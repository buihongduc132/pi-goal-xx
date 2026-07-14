# Requirements — Crash-safe auditor inheritance

> Date: 2026-07-11
> Derived from: `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` + user design decision (this turn) + `flow/findings/auditor-config-design/2026-07-03-turn2-design-decisions.md`
> Status: draft (pre-verifier-loop)

## Context

Auditor runs **in-process** (`SessionManager.inMemory`) and inherits host's full resource set (`inheritFromCwd:true`). This is intentional — auditor verifies work with project tools. Two crash modes exist because in-process child has no isolation from host's event loop. Fix: harden the in-process boundary, NOT remove inheritance.

## R1 — Inheritance contract (locked)

**R1.1** — Auditor MUST inherit all host resources (tools, extensions, skills, MCP via pi-mcp-adapter) when `auditorMode="inherit"` (default).
**R1.2** — Opt-out ONLY via existing `auditorExclude` (filter list) in settings. No allow-list mode introduced.
**R1.3** — `inheritFromCwd:true` stays at `extensions/goal.ts:3142-3150`. NOT removed.
**R1.4** — `auditorMode="minimal"` (opt-in) already exists per `auditor-config-design/turn2` — out of scope here.

## R2 — Auditor prompt timeout (NEW, blocking)

**R2.1** — `runGoalCompletionAuditor` MUST enforce a hard timeout on `await session.prompt(...)`.
**R2.2** — Default ceiling: **300000ms (5min)**. Rationale: auditor is a bounded review pass, NOT a verifier-loop (which has 30min floor). 5min covers model latency + tool calls for typical completion audits.
**R2.3** — Configurable via NEW settings key `ceremony.auditorTimeoutMs` (number, min 60000, max 1800000).
**R2.4** — Timeout fires → `session.abort()`, return `{approved:false, disapproved:true, error:"Auditor timeout after ${ms}ms", timedOut:true}`. Host MUST stay alive.
**R2.4a** — After `session.abort()`, the pending `await session.prompt()` promise (goal-auditor.ts:722) MUST be caught: wrap in `.catch(() => {})` or equivalent. If any inherited extension rejects during abort teardown (Bug 1 failure mode 2), that rejection MUST NOT escape as unhandledRejection. This is the exact crash vector the requirement is supposed to fix.
**R2.4b** — Timeout return path MUST be checked BEFORE the existing `aborted || args.signal?.aborted` check at goal-auditor.ts:736-748. Add `timedOut` boolean to return shape; when `timedOut:true`, return timeout error (R2.4) regardless of `aborted` flag. Prevents "Auditor aborted." message overriding timeout message.
**R2.5** — Timeout cleanup: `clearTimeout(timeoutId)` (the NEW setTimeout), `removeEventListener("abort")`, stop progress animation, clear `auditAbortController`. No leaked timers. The timeout timer MUST be cleared when `session.prompt` resolves BEFORE timeout fires (Promise.race loser cleanup).
**R2.6** — Ledger: augment existing `audit_result` event with `timedOut:true` when timeout fires. No new event type.

## R3 — Unhandled rejection guard (NEW, scoped to audit window)

**R3.1** — During `await runGoalCompletionAuditor(...)`, install `process.on("unhandledRejection", handler)` scoped to the audit. Store handler in a named variable (required for `process.off` identity match at removal).
**R3.2** — Handler: log rejection via `logAuditorTrace` (phase `unhandled-rejection`), swallow (prevents Node default exit). Do NOT propagate.
**R3.3** — Handler removed via `process.off("unhandledRejection", handler)` in `finally` block after `session.prompt` resolves/aborts. MUST NOT leak past audit window (would mask real bugs elsewhere).
**R3.4** — When guard catches a rejection: return `{approved:false, disapproved:true, error:"Auditor inherited-resource rejection: ${msg}"}`. Host stays alive.
**R3.5** — Guard MUST identify `AbortError` (check `reason.name === "AbortError"`). If `AbortError` reaches unhandledRejection handler, swallow it as benign abort (do NOT let Node default fire). Rationale: if AbortError escapes the existing catch at goal-auditor.ts:769, it has already escaped the normal path — letting it propagate contradicts crash-safe goal.

## R4 — Crash-safe message sends (Bug 2 fix)

**R4.1** — ALL `pi.sendMessage` calls inside `complete_goal.execute` (`goal.ts:2958, 3024, 3078, 3184, 3276, 3293`) MUST be crash-safe.
**R4.2** — Crash-safe = routed through existing `serializedSend` (which swallows rejections at `goal.ts:505`) OR `.catch(() => {})` appended.
**R4.3** — Prefer `serializedSend` for consistency with continuation path (`goal.ts:1576, 1704, 1748`).
**R4.4** — Rejection MUST NOT propagate to Node's unhandledRejection handler.

## R5 — Non-functional

**R5.1** — Backward compat: missing `ceremony.auditorTimeoutMs` = 300000 default. Zero-config migration.
**R5.2** — No perf regression on happy path (auditor approves quickly). Timeout + guard add negligible overhead.
**R5.3** — `additionalProperties:false` preserved on settings schema.

## R6 — Tests

**R6.1** — `auditor-timeout.test.ts`: mock `session.prompt` that never resolves → timeout fires at `auditorTimeoutMs` → returns `{approved:false, error:"Auditor timeout...", timedOut:true}`, host alive.
**R6.1a** — `auditor-timeout-pending-promise.test.ts`: mock `session.prompt` that rejects AFTER timeout fires (simulates inherited extension rejection during abort teardown) → rejection caught, no unhandledRejection, host alive.
**R6.1b** — `auditor-timeout-timer-cleanup.test.ts`: mock `session.prompt` that resolves BEFORE timeout → timeout timer cleared (no leaked setTimeout), no timeout error returned.
**R6.2** — `auditor-unhandled-rejection.test.ts`: inject extension that throws async rejection during audit → guard catches → logged → host alive.
**R6.2a** — `auditor-guard-removal.test.ts`: after audit completes (success or failure), guard removed via `process.off` → subsequent unhandledRejection NOT caught by guard (no leak).
**R6.2b** — `auditor-abort-error-swallow.test.ts`: AbortError reaches unhandledRejection handler → swallowed as benign, host alive.
**R6.3** — `complete-goal-reject-no-exit.test.ts`: auditor returns `<disapproved/>` → pi stays alive, rejection text returned to agent, no unhandledRejection emitted.
**R6.4** — `complete-goal-send-crash-safe.test.ts`: all 6 sends reject → swallowed, no unhandledRejection.

## Out of scope

- Out-of-process auditor (escalation path if R2+R3 insufficient — separate design).
- Verifier-loop ceremony (separate requirement `2026-07-06_goal-ceremony-and-hook-routing.md` R2).
- Changing `auditorMode` semantics (inherit/minimal already locked in turn2 design).

## References

- Bug: `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md`
- Prior finding: `flow/findings/2026-07-10_complete-goal-fork-diff-crash.md`
- Design decision (inherit/opt-out): `flow/findings/auditor-config-design/2026-07-03-turn2-design-decisions.md`
- Code: `extensions/goal.ts:3142-3150` (inheritance), `goal-auditor.ts:443-450` (loader), `goal-auditor.ts:710-723` (prompt await)
