# Bugs — `complete_goal`: crash-on-run + exit-on-reject

> Date: 2026-07-11
> Status: fixed (G1-G7 + P1 review follow-ups on `fix/g1-g7-crash-vectors`; merged to main via PR)
> Related finding: `flow/findings/2026-07-10_complete-goal-fork-diff-crash.md`
> Root cause of "still not running on main": main only had PR #21 (partial — removed `await` from sendMessage, did NOT touch `inheritFromCwd`). The G1-G7 hardening lived on `fix/g1-g7-crash-vectors` and was never merged (PR #22 closed as dup of #23; #23 open but base = agent2 branch missing review follow-ups).

## Bug 1 — `complete_goal` crashes pi when auditor runs

**Symptom:** pi hangs then exits (no stack trace) when `complete_goal` reaches the auditor spawn. Ledger shows `audit_started` but no `audit_result`.

**Root cause:** `extensions/goal.ts:3142-3150` passes `mainResources: { tools: safeGetActiveTools(pi), inheritFromCwd: true }` to `runGoalCompletionAuditor`. Auditor runs **in-process** (`SessionManager.inMemory`). `inheritFromCwd` makes it load the host's full resource set (every extension, every MCP server, every skill) via `DefaultResourceLoader.reload()` (`goal-auditor.ts:443-450`).

**Failure modes:**
1. An inherited extension's `onLoad` or MCP adapter handshake awaits something that never resolves → `await session.prompt()` hangs forever.
2. An inherited extension throws an async unhandled rejection in the auditor child's event loop → Node terminates the whole process with no host-side stack trace.

**Why the landed "fix" (`ff36e54`/`ec4517c`, Jul 9) doesn't help:** those commits removed `await` from `pi.sendMessage` but did NOT touch `inheritFromCwd`. The crash is inside `runGoalCompletionAuditor`, ~60 lines downstream of the patched send.

**Fix direction:** keep `inheritFromCwd:true` (user's design decision — auditor inherits all, opt-out via `auditorExclude`/`auditorInclude` settings). Harden in-process:
1. Add **auditor prompt timeout** — currently NONE in `goal-auditor.ts`. Default ceiling (e.g. 5min for audit, separate from verifier-loop's 30min). Configurable via `ceremony.auditorTimeoutMs`. On timeout: abort session, return `{approved:false, error:"Auditor timeout"}`, do NOT kill host.
2. Add **`unhandledRejection` guard** scoped to audit window — catch async rejections from inherited extensions during `await session.prompt()`. Log via `logAuditorTrace`, do NOT propagate to Node's default handler.
3. If hardening still flaky after (1)+(2), escalate to out-of-process auditor (separate design).

## Bug 2 — auditor rejects → pi exits immediately

**Symptom:** auditor runs cleanly, returns `<disapproved/>`, pi exits right after.

**Root cause:** ALL 6 `pi.sendMessage` calls inside `complete_goal.execute` (`goal.ts:2958, 3024, 3078, 3184, 3276, 3293`) are bare fire-and-forget with **no `.catch()`**. The reject-path send at `goal.ts:3276` is the trigger. An unhandled promise rejection from `pi.sendMessage` → Node's default handler → process exit.

**Why the landed "fix" made it worse:** `ff36e54` removed `await` from the send at line 3078, turning a catchable rejection (inside `execute`'s frame) into an unhandled one. The continuation sends (`goal.ts:1576, 1704, 1748`) are correctly wrapped in `void serializedSend(...)` which swallows rejections (`goal.ts:505`). complete_goal sends are not.

**Fix:** route all 6 complete_goal sends through `serializedSend`, OR add `.catch(() => {})` to each.

## Verification

- [x] Bug 1: `complete_goal` with auditor enabled does not hang/exit. Ledger contains `audit_result`. (G1: guards before createSession; timeout ceiling; isGoalSelfExtension strips the goal extension from the auditor)
- [x] Bug 2: auditor rejects → pi stays alive, agent receives rejection text, can retry. (safeFireAndForget wraps all 6 sends; implicit-return per LSL #2)
- [x] Test: complete_goal reject path does not produce unhandledRejection. (regression-race-and-complete-goal-crash.test.ts)
- [x] Test: auditor timeout fires → returns `{approved:false, error:"Auditor timeout"}`, host stays alive. (goal-auditor-crash-safe.test.ts R2.4)
- [x] Test: inherited extension throws async rejection during audit → logged, host stays alive. (goal-auditor-crash-safe.test.ts R3.x + G1)
- [x] P1: guard body non-throwing — safeToString handles Object.create(null) / throwing proxy. (goal-auditor-crash-safe.test.ts P1 suite)
- [x] P1: propose_goal_tweak enforces G6 50KB objective cap on confirmation. (goal-write-error.test.ts P1 suite)
- [x] P1: all tryWriteActiveGoalFile callers check `.ok` (propose_goal_tweak, persist, complete_goal x4).
- [x] Tracing: auditor-trace.jsonl records pre-createSession, start, every event, end/abort/error. (auditor-log.test.ts)
- [x] `npm test` exits cleanly (975 tests, 0 fail). --test-force-exit added for lingering test handle.
