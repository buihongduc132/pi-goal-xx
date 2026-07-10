# Bugs — `complete_goal`: crash-on-run + exit-on-reject

> Date: 2026-07-11
> Status: open (not fixed)
> Related finding: `flow/findings/2026-07-10_complete-goal-fork-diff-crash.md`

## Bug 1 — `complete_goal` crashes pi when auditor runs

**Symptom:** pi hangs then exits (no stack trace) when `complete_goal` reaches the auditor spawn. Ledger shows `audit_started` but no `audit_result`.

**Root cause:** `extensions/goal.ts:3142-3150` passes `mainResources: { tools: safeGetActiveTools(pi), inheritFromCwd: true }` to `runGoalCompletionAuditor`. Auditor runs **in-process** (`SessionManager.inMemory`). `inheritFromCwd` makes it load the host's full resource set (every extension, every MCP server, every skill) via `DefaultResourceLoader.reload()` (`goal-auditor.ts:443-450`).

**Failure modes:**
1. An inherited extension's `onLoad` or MCP adapter handshake awaits something that never resolves → `await session.prompt()` hangs forever.
2. An inherited extension throws an async unhandled rejection in the auditor child's event loop → Node terminates the whole process with no host-side stack trace.

**Why the landed "fix" (`ff36e54`/`ec4517c`, Jul 9) doesn't help:** those commits removed `await` from `pi.sendMessage` but did NOT touch `inheritFromCwd`. The crash is inside `runGoalCompletionAuditor`, ~60 lines downstream of the patched send.

**Fix:** remove `mainResources` block from `goal.ts:3142-3150`. Restore upstream's isolated auditor (empty resource loader, 6 hardcoded tools, compaction disabled). If resource inheritance is still wanted, it must run out-of-process or with a hard allow-list.

## Bug 2 — auditor rejects → pi exits immediately

**Symptom:** auditor runs cleanly, returns `<disapproved/>`, pi exits right after.

**Root cause:** ALL 6 `pi.sendMessage` calls inside `complete_goal.execute` (`goal.ts:2958, 3024, 3078, 3184, 3276, 3293`) are bare fire-and-forget with **no `.catch()`**. The reject-path send at `goal.ts:3276` is the trigger. An unhandled promise rejection from `pi.sendMessage` → Node's default handler → process exit.

**Why the landed "fix" made it worse:** `ff36e54` removed `await` from the send at line 3078, turning a catchable rejection (inside `execute`'s frame) into an unhandled one. The continuation sends (`goal.ts:1576, 1704, 1748`) are correctly wrapped in `void serializedSend(...)` which swallows rejections (`goal.ts:505`). complete_goal sends are not.

**Fix:** route all 6 complete_goal sends through `serializedSend`, OR add `.catch(() => {})` to each.

## Verification

- [ ] Bug 1: `complete_goal` with auditor enabled does not hang/exit. Ledger contains `audit_result`.
- [ ] Bug 2: auditor rejects → pi stays alive, agent receives rejection text, can retry.
- [ ] Test: complete_goal reject path does not produce unhandledRejection.
