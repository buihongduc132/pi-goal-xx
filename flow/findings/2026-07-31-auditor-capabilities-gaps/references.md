# References

> Sources consulted during this explore session.

## Source files
- `extensions/goal-auditor.ts` — 1479-line main auditor implementation. `runGoalCompletionAuditor()`, `parseAuditorDecision()`, `buildAuditorPromptParts()`. Read in full (offset 1-150, 150-400, 400-700, 700-1000, 1000-1300, 1300-end). Source of truth for Q1 (no early-exit), Q2 (`SessionManager.inMemory()` fresh ctx), Q3 (`parseAuditorDecision()` last-marker parsing).
- `extensions/auditor-modes.ts` — Auditor resource resolution. `AUDITOR_BASELINE_TOOLS`, `resolveAuditorResources()` (inherit/minimal modes). Confirms auditor gets read/grep/find/ls/bash baseline + `report_auditor_progress`.
- `extensions/auditor-prompt.ts` — Auditor prompt resolution via `loadAuditorPrompt()`. Persona + fact layer split. Confirms free-form text output expected (no structured schema).
- `extensions/auditor-log.ts` — `auditor-trace.jsonl` forensic logging. `buildStartEntry`, `buildEventEntry`, `buildEndEntry`. Confirms trace is write-only — never fed back as input (Q2 negative).
- `extensions/goal-auditor-subscriptions.ts` — Async event forwarding. `emitAuditorSubscription()` only appends to ledger + UI notify; does NOT invoke auditor. Confirms subscriptions are informational only.
- `extensions/goal-settings.ts` — Settings schema. `auditorMode`, `auditorExclude`, `auditorInclude`, `auditorPromptMode`, `auditorPrompt`, `auditorTimeoutMs`, `auditorTimeoutFloorMs`, `auditorSubscriptions`, `commandHooks`, `hooksDir`. Confirms no `preAudit` or `earlyExit` keys exist.
- `extensions/command-hook-loader.ts` — Per-command hook system (`loadHook`, `wrapHandler`, `lazyWrapCommand`). pre/post/override modes. Confirms hook system is command-handler-scoped, NOT auditor-scoped — Q4 not currently supported.
- `extensions/goal.ts` — `complete_goal` handler grep. Confirms `runGoalCompletionAuditor()` called directly with no hook layer in front.

## Documents
- (none — analysis based solely on source code)

## Code patterns
- `SessionManager.inMemory(args.ctx.cwd)` — fresh in-memory session per audit (no persistence across audits). Pattern that answers Q2.
- `parseAuditorDecision(output)` — regex scan for LAST `<approved/>` / `<disapproved/>` marker in free-form text. Pattern that answers Q3 (free-form, not structured).
- `Promise.race([session.prompt(...), timeoutPromise])` — single blocking prompt with timeout ceiling. Pattern that answers Q1 (no early-exit mid-stream).
- `command-hook-loader.ts` → `wrapHandler()` — wraps command handlers only; auditor bypasses this layer entirely. Pattern that answers Q4.
