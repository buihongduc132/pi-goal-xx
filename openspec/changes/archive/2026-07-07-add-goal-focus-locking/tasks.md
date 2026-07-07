## 1. Lock primitives (new module `extensions/goal-lock.ts`)

- [ ] 1.1 Define `GoalFocusLock` type: `{ goalId, owner: { sessionId, pid }, acquiredAt, expiresAt, heartbeatAt }` (branch field deferred — see design D1)
- [ ] 1.2 Implement `lockDir(cwd)` → `<cwd>/.pi/goals/.locks` (ensure dir exists, fail-open on error)
- [ ] 1.3 Implement `lockPath(cwd, goalId)` → `<cwd>/.pi/goals/.locks/<goalId>.lock`
- [ ] 1.4 Implement `readLock(cwd, goalId): GoalFocusLock | null` (parse JSON, return null on missing/invalid/corrupt)
- [ ] 1.5 Implement `isPidAlive(pid): boolean` via `process.kill(pid, 0)`. **Error-code aware**: return `true` on success (alive), `true` on `EPERM` (process exists but owned by another user — still alive, just no permission to signal), `false` on `ESRCH` (no such process) and any other throw. Naively returning `false` on any throw would mark a live cross-user process as dead → false-positive stale lock → steal.
- [ ] 1.6 Implement `isLockHeld(lock): boolean` — PID alive AND `now < expiresAt`
- [ ] 1.7 Implement `isLockStale(lock): boolean` — lock exists AND NOT `isLockHeld`
- [ ] 1.8 Implement `writeLockAtomic(cwd, goalId, lock)` — write `.<pid>.<ts>.tmp` then `fs.renameSync` to final path
- [ ] 1.9 Implement `acquireLock(cwd, goalId, self): { ok: boolean; heldByOther?: GoalFocusLock }` — read→reap-stale→write→verify per design D5
- [ ] 1.10 Implement `releaseLock(cwd, goalId, self?)` — delete file (only if owned by self when self provided)
- [ ] 1.11 Implement `reapStaleLock(cwd, goalId)` — read, if stale delete
- [ ] 1.12 Implement `refreshLease(cwd, goalId, self, leaseMs)` — re-write `expiresAt = now + leaseMs`, `heartbeatAt = now`; fail-open
- [ ] 1.13 Add unit tests for `goal-lock.ts`: held/stale/reap/acquire/verify/release/refresh, PID-dead, lease-lapsed, boot-race loser, fail-open

## 1b. Verify pi event names + reason enum (PRECONDITION before task 2)

- [ ] 1b.1 Confirm `turn_end`, `session_shutdown` are actual event names emitted by pi's ExtensionAPI in this codebase version (grep `pi.on(` in `node_modules/@earendil-works/pi-coding-agent/dist` and existing extensions). `session_start`, `session_compact`, `session_tree`, `session_before_compact`, `before_agent_start` are confirmed; the two new ones must be verified before depending on them.
- [ ] 1b.2 Verify the ACTUAL values of `SessionStartEvent.reason` enum. Grep `types.d.ts` for the enum. Confirm the full set exists (assumed `"startup" | "reload" | "new" | "resume" | "fork"`). Note: `reload` EXISTS as a value but is treated as NON-resume-like under the default per LD3 ("resume only" honored verbatim). If `reload` does not actually exist as an emitted value, this is moot.

## 2. Lease + heartbeat wiring (timer-only — no event-driven refresh)

- [ ] 2.1 Add `leaseMs` setting (default `180_000`, i.e. 3 min) and `heartbeatMs` (default `60_000`) to `GoalSettings`
- [ ] 2.2 Generate a session id (`crypto.randomUUID()` once per process, module-level)
- [ ] 2.3 Add `refreshFocusedLease(ctx)` helper that calls `refreshLease` on the focused goal
- [ ] 2.4 Start a single `setInterval(heartbeatMs)` timer when a goal becomes focused+active; clear on focus loss / shutdown (register with the existing timer-cleanup set — verify the set exists; if not, add to `clearStoppedRuntimeState`)
- [ ] 2.5 DO NOT add `turn_end` / `tool_execution_end` / write-hook refresh paths. Timer-only. (LD1 "least resistant"; both verifiers confirmed these are redundant vs the 60s timer.)
- [ ] 2.6 Add unit tests for heartbeat timer lifecycle (start/stop/clear, no-leak on shutdown)

## 3. Focus resolution gate (`resolveSessionFocus`) + reason routing

- [ ] 3.1 Add `PI_GOAL_AUTO_FOCUS` env read: `resume` (default) | `all`
- [ ] 3.2 Change `loadState` signature to accept `autoFocusReason: string | null`. Thread it from EVERY caller:
  - `session_start` handler (goal.ts:3648) passes `event.reason` (the full enum)
  - `session_tree` handler (goal.ts:3683) passes `null` (tree nav must not auto-focus)
  - audit any OTHER `loadState` callers via `grep -n 'loadState' extensions/goal.ts` and route each explicitly
- [ ] 3.3 Change `resolveSessionFocus` to receive `autoFocusReason` + `cwd` + `selfSessionId`
- [ ] 3.4 Define resume-like reasons: `resume` ONLY (LD3 honored verbatim — `reload` is NOT resume-like under default; excluded to avoid silently extending a locked decision). Non-resume: `new`, `startup`, `fork`, `reload`, `null`.
- [ ] 3.5 In `resolveSessionFocus`, gate the `open.length === 1` auto-focus branch on: reason is resume-like OR `PI_GOAL_AUTO_FOCUS=all`
- [ ] 3.6 Add lock check on the single auto-focus candidate: skip if `isLockHeldByOther(lock, selfSessionId)`
- [ ] 3.7 Do NOT change behavior when `open.length > 1` (preserves existing `=== 1` semantics — no new auto-focus when multiple goals exist)
- [ ] 3.8 Preserve branch-focus-entry precedence at RESOLUTION (explicit user choice wins over stale-looking lock) — but auto-run is gated separately (see task 4)
- [ ] 3.9 Preserve legacy migration precedence
- [ ] 3.10 Add unit tests: resume+1-open focuses; reload+1-open does NOT (LD3 literal); new/startup/fork+1-open do NOT; null (tree)+1-open does NOT; PI_GOAL_AUTO_FOCUS=all focuses on any reason (incl reload); the one candidate locked-by-other → unfocused; explicit branch entry wins at resolution despite lock

## 4. Lock acquire-at-transition + auto-run chokepoint

### 4a. Auto-run chokepoint (single guard)
- [ ] 4.1 Add a guard at the TOP of `queueContinuation` (goal.ts:~1417): `if (focusedGoalId && !isLockHeldBySelf(cwd, focusedGoalId, selfSessionId)) { log; return; }`. This single guard covers ALL ~8 call sites (session_start, session_compact, session_tree, /goal-focus, /goal-resume:1697, replaceGoal:1444, turn_end, agent_end) uniformly.

### 4b. Lock acquired at EVERY focus ownership transition (CRITICAL — without this the chokepoint blocks resume-and-continue)
- [ ] 4.2 `session_start` handler: AFTER `loadState` resolves focus (goal.ts:978 direct-assigns `focusedGoalId`) and BEFORE `queueContinuation` (3663), call `acquireLock(focusedGoalId)` + start heartbeat timer. On success → chokepoint passes → resume-and-continue works. On failure (held by other) → focus preserved, chokepoint blocks, surface held-by message.
- [ ] 4.3 `handleGoalResume` (`/goal-resume`, goal.ts:~1697): call `acquireLock` before `queueContinuation`. Reaps own-stale lock (pause+lapse self-heal); fails if another live session holds it → surface held-by message.
- [ ] 4.4 `setFocusedGoalId(B)` (goal.ts:706): `releaseLock(A)` then `acquireLock(B)` before arming continuation. Covers `/goal-focus` and explicit focus changes.
- [ ] 4.5 `replaceGoal` (new-goal creation, goal.ts:~1444): `acquireLock(newGoalId)` before `queueContinuation` so the heartbeat timer refreshes a lock that actually exists.
- [ ] 4.6 On `complete_goal` success: `releaseLock(focusedGoalId)` (co-located with turn_end archival; status persisted to active file before release so pool excludes it)
- [ ] 4.7 On `pause_goal`: NO explicit release (lazy reap-on-acquire; heartbeat timer stops). `/goal-resume` reacquires via 4.3. Document in code comment. On `abort_goal` (`setGoal(null, "aborted")`): EXPLICIT release via the `state.goal` setter instrumentation (4.8b) — abort is terminal, so releasing immediately is cleaner than lazy reap and honors the "MUST NOT hold locks" invariant. (This resolves the apparent contradiction between 4.7 and 4.8b: pause = lazy reap, abort = explicit release via the setter.)
- [ ] 4.8 On `session_shutdown`: `releaseLock(focusedGoalId)` then clear heartbeat timer
- [ ] 4.8b Instrument the `state.goal` setter (goal.ts:427-436): when the new value is `null` OR has a different `id` than current `focusedGoalId`, call `releaseLock(previousId)` BEFORE the assignment. This single-chokepoint covers ALL `setGoal(null)` paths (clear at 1610/1833, replace-topic, aborted at 1860/3037) automatically, mirroring the `queueContinuation` chokepoint philosophy. Verify it fires for `setGoal(null,"cleared")` and `setGoal(differentId)`.

### 4c. User-facing message
- [ ] 4.9 Surface message when focused-but-not-running: "Focused on <goal> but not running — held by session <sessionId>. Use /goal-focus to take over." (fires at focus-resolution failure, when the chokepoint blocks in the `armFocusedContinuation` path — e.g. handleGoalResume early-return at 1671 — AND when a mid-run lease lapses and another session takes over)

### 4d. Tests (corrected — round 3 caught a test that encoded the bug)
- [ ] 4.10 session_start reason="resume" + 1 open unlocked goal → acquireLock succeeds → continuation QUEUED (the core resume-and-continue flow MUST work)
- [ ] 4.10b session_tree loadState resolves a goal via branch-entry → NO acquireLock wired → chokepoint blocks → DOCUMENTED behavior: "tree navigation does not auto-run; user must `/goal-resume`" (add to README/docs in task 8)
- [ ] 4.11 session_start reason="new"/"startup"/"fork" → no auto-focus → no continuation (chokepoint not reached)
- [ ] 4.12 `/goal-resume` after pause+lapse (own stale lock) → acquireLock reaps+reacquires → continuation QUEUED (self-heal)
- [ ] 4.13 `/goal-resume` after lapse AND other-session-acquired → acquireLock fails → continuation NOT queued → held-by message
- [ ] 4.14 new-goal creation (replaceGoal) → acquireLock → continuation QUEUED
- [ ] 4.15 focus change A→B → releaseLock(A) + acquireLock(B)
- [ ] 4.16 fail-open fs error on acquireLock → no continuation queued (auto-run is NOT fail-open; manual work proceeds)

## 5. `/goal-focus` override flow (on the actual selector)

- [ ] 5.1 Add lock check inside `focusGoalCommand` itself (the actual selector at goal.ts:~1579), INCLUDING the single-open fast-path (lines ~1579-1585). The command takes no `<id>` arg — it's a selector. **Ordering**: the prompt MUST execute BEFORE `setFocusedGoalId` is called; `setFocusedGoalId`'s acquireLock (task 4.4) is silent (no prompt) — it just attempts and fails if held. The prompt logic lives here in `focusGoalCommand`.
- [ ] 5.2 When the selected (or auto-selected via fast-path) goal is HELD by another live session → confirm dialog with owner identity (sessionId, pid)
- [ ] 5.3 On confirm: reap the held lock, acquire fresh, set focus
- [ ] 5.4 On decline: no change
- [ ] 5.5 On STALE lock: silent reap + acquire (no prompt)
- [ ] 5.6 Headless / `!ctx.hasUI`: log warning + refuse (cannot prompt)
- [ ] 5.7 Add unit tests: override refused (headless), override confirmed (reaps + acquires), override on stale lock proceeds without prompt, fast-path on held goal prompts

## 6. C4 verification (auditor sub-session) — MAKE-OR-BREAK for the "solved for free" hypothesis

- [ ] 6.1 Spawn `runGoalCompletionAuditor` with `inheritFromCwd: true` while parent holds the goal lock; inspect the auditor's actual `session_start` event `reason`. If it is `"startup"` (hypothesis), resume-only default excludes it → auditor unfocused → C4 solved. If it is something else (e.g. `"new"`, or inherits a focus entry), the convergence hypothesis FAILS.
- [ ] 6.2 Verify the auditor does not write a competing lock file for the focused goal
- [ ] 6.3 If C4 is NOT solved by convergence, add an explicit "sub-session" signal (reuse `PI_TEAMS_WORKER` OR a new `PI_GOAL_SUBSESSION=1`) and document. This is the agreed fallback.

## 7. Tests (broader)

- [ ] 7.1 Unit test `acquireLock` boot race (two sessions, one wins, one backs off)
- [ ] 7.2 Unit test PID-dead → stale → reaped by next acquirer
- [ ] 7.3 Unit test lease-lapsed → stale → reaped
- [ ] 7.4 Unit test fail-open: chmod read-only `.locks/` → warning logged, goal work proceeds
- [ ] 7.5 Integration test: two-session scenario — S1 focuses A, S2 starts in same cwd with `reason: "new"` → S2 unfocused
- [ ] 7.6 Integration test: S1 focuses A, S2 starts with `reason: "resume"` → S2 unfocused (locked by S1)
- [ ] 7.7 Integration test: S1 crashes (simulated by deleting pid from lock + expiring lease) → S2 acquires on next start
- [ ] 7.8 Verify all existing tests still pass (backward compat for the single-session common case)

## 8. Documentation

- [ ] 8.1 Add "Multi-session goal focus" section to README explaining locks, the auto-focus change, and the env flag
- [ ] 8.2 Add `PI_GOAL_AUTO_FOCUS` to the env-var table with default `resume`
- [ ] 8.3 Add `leaseMs` / `heartbeatMs` to the settings table
- [ ] 8.4 Document the `.locks/` directory and that it's safe to `rm -rf` for recovery
- [ ] 8.5 Note backward-compat migration: users relying on auto-focus-on-startup set `PI_GOAL_AUTO_FOCUS=all`

## 9. Verification

- [ ] 9.1 `npm test` — all green (existing + new)
- [ ] 9.2 `npm run check` — tsc clean
- [ ] 9.3 `openspec validate add-goal-focus-locking` passes
- [ ] 9.4 Manual: run two pi sessions in one cwd, confirm no stealing
- [ ] 9.5 Manual: kill -9 one session, confirm the other acquires within lease window
- [ ] 9.6 Verify the auditor sub-session (C4) does not collide (task 6) — BLOCKER if it fails
