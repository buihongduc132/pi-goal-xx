# goal-focus-locking Specification

## Purpose
Focus locking mechanism for pi goals — lease-based advisory locks that prevent concurrent goal focus conflicts across sessions.
## Requirements
### Requirement: Goal focus lock file
The system SHALL maintain a per-goal advisory lock at `<cwd>/.pi/goals/.locks/<goalId>.lock` as a JSON sidecar whenever a session is focused on a non-complete goal (active OR paused — both are "in the active pool" and lockable). The lock file MUST record: `goalId`, `owner.sessionId`, `owner.pid`, `acquiredAt`, `expiresAt`, and `heartbeatAt`. (`owner.branch` is intentionally omitted — see design D1; deferred as debug-only overhead.)

#### Scenario: Lock created on focus acquisition
- **WHEN** a session acquires focus on a non-complete goal (active or paused)
- **THEN** the lock file `<cwd>/.pi/goals/.locks/<goalId>.lock` is written atomically (write-tmp + rename) with the owner's sessionId, pid, current timestamps, and `expiresAt = now + lease window`

#### Scenario: Lock directory is excluded from active pool scan
- **WHEN** the system reads active goals from `<cwd>/.pi/goals/`
- **THEN** the `.locks/` subdirectory MUST NOT be scanned as goal files (lock sidecars are never parsed as goals)

### Requirement: Two-signal liveness check
The system SHALL consider a lock HELD if and only if BOTH the owning PID is alive (`process.kill(pid, 0)` succeeds OR throws `EPERM` — process exists but owned by another user; both mean alive) AND `now < expiresAt` (lease not lapsed). If either signal fails (PID dead = `ESRCH`, or lease lapsed), the lock is STALE and reapable.

#### Scenario: Both signals healthy
- **WHEN** a lock's owning PID is alive and `expiresAt` is in the future
- **THEN** the lock is HELD and acquisition by another session MUST fail

#### Scenario: Owning process dead
- **WHEN** `process.kill(pid, 0)` throws `ESRCH` (no such process) but `expiresAt` is still in the future
- **THEN** the lock is STALE and the next acquirer MUST reap it

#### Scenario: Owning process alive but cross-user (EPERM)
- **WHEN** `process.kill(pid, 0)` throws `EPERM` (process exists but owned by another user) and `expiresAt` is in the future
- **THEN** the lock is HELD (EPERM = process exists, just no permission to signal — treating it as dead would falsely mark live cross-user processes as stale and cause lock stealing)

#### Scenario: Lease lapsed
- **WHEN** the owning PID is alive but `now >= expiresAt`
- **THEN** the lock is STALE (hung or suspended session) and the next acquirer MUST reap it

#### Scenario: PID reused by unrelated process
- **WHEN** the owning PID was reused by an unrelated process after the original died but before `expiresAt` lapsed
- **THEN** the lease (which the dead original could not refresh) has lapsed, so the lock is STALE and the next acquirer reaps it

### Requirement: Lease heartbeat
The system SHALL refresh the lease (`expiresAt = now + lease window`) at acquisition and via a 60-second backstop timer while the goal is focused and active. Default lease window is 3 minutes, tunable via settings. The 60-second timer alone refreshes the lease ~3× within the 3-minute window, covering both idle presence and long tool executions — no event-driven refresh (`turn_end`, `tool_execution_end`) is added, because each adds a second code path and extra lock-file writes for zero liveness benefit the timer does not already provide (LD1 "least resistant path").

#### Scenario: Timer refresh during idle and active
- **WHEN** the session is focused on an active goal
- **THEN** a 60-second timer refreshes the lease, keeping the lock alive while the session is genuinely present (whether or not turns are firing)

#### Scenario: Timer stops on focus loss
- **WHEN** the session loses focus or the goal becomes non-active
- **THEN** the 60-second timer is cleared and no further lease refreshes fire

### Requirement: Reap-on-acquire
The system SHALL, during `acquireLock`, read any existing lock file. If a held lock exists for another session, acquisition MUST fail. If a stale lock exists, it MUST be reaped (deleted) before writing the new lock. After atomic write, the system MUST re-read to verify ownership; if the ownerId does not match the acquiring session, acquisition MUST fail (boot-race loser backs off).

#### Scenario: No existing lock
- **WHEN** `acquireLock(goalId, self)` is called and no `.lock` file exists
- **THEN** the system writes the lock atomically, verifies ownership, and succeeds

#### Scenario: Held by another session
- **WHEN** `acquireLock(goalId, self)` is called and the existing lock is HELD by another session
- **THEN** acquisition fails and the caller does NOT focus or auto-run the goal

#### Scenario: Stale lock reaped
- **WHEN** `acquireLock(goalId, self)` is called and the existing lock is STALE
- **THEN** the system deletes the stale lock, writes its own atomically, verifies, and succeeds

#### Scenario: Concurrent acquisition race
- **WHEN** two sessions call `acquireLock(goalId)` simultaneously with no prior lock
- **THEN** one's atomic rename wins; the loser's verify-read finds a different ownerId and fails

### Requirement: Clean release (covers ALL focus-clearing paths)
The system SHALL release (delete) a session's lock whenever focus leaves a goal, covering ALL paths that change `focusedGoalId` — including `setFocusedGoalId`, `loadState` re-resolution, and `setGoal(null)` (clear/replace/aborted). Concretely: on `session_shutdown`, on focus change via `setFocusedGoalId` (release old before acquiring new), on `setGoal(null, "cleared")` at goal.ts:1610 & 1833, on `setGoal(null, "aborted")` at 1860 & 3037 (abort is terminal — explicit release is cleaner than lazy reap and honors the MUST invariant below), and on goal completion (`complete_goal` success, co-located with the turn_end archival that actually moves the file out of the active pool). `pause_goal` is the ONLY focus-clearing path that does NOT trigger explicit release (lazy reap; heartbeat stops; `/goal-resume` self-heals via reacquire). A session MUST NOT hold locks on goals it is no longer focused on.

**Implementation note**: Because the `state.goal` setter (goal.ts:427-436) assigns `focusedGoalId` directly and `setGoal(null)` bypasses `setFocusedGoalId`, the cleanest single-chokepoint fix is to instrument the `state.goal` setter: when the new value is `null` or has a different `id` than the current `focusedGoalId`, call `releaseLock(previousId)` before the assignment. This covers all `setGoal(null)` paths automatically — including aborted (1860/3037), which is why abort gets explicit release for free while pause (which does NOT call `setGoal(null)` — it only flips status to paused) correctly relies on lazy reap. **Scope caveat**: a few direct `focusedGoalId = null` assignments OUTSIDE the setter (e.g. `reconcileFocusedGoalFromDisk` at goal.ts:683 when a goal vanishes from disk, `removeFocusedGoal` at 752, debug-goal toggle at 1136) bypass this chokepoint and may leak a lock until `session_shutdown` or lease lapse. These are degenerate cases (goal already gone from pool or debug-only) and the lease (3 min) ensures eventual cleanup, so the invariant is best-effort, not absolute. If absolute guarantee is later required, route those sites through a `clearFocusedGoalIdLocked(prevId)` helper.

#### Scenario: Release on shutdown
- **WHEN** the `session_shutdown` event fires and the session holds a lock
- **THEN** the lock file is deleted

#### Scenario: Release on focus change
- **WHEN** focus changes from goal A to goal B (via `setFocusedGoalId` OR `setGoal(differentId)`)
- **THEN** the lock on A is released before acquiring the lock on B

#### Scenario: Release on `setGoal(null, "cleared")`
- **WHEN** a session clears focus via `setGoal(null, "cleared")` (replace-topic at 1610, clear-goal at 1833)
- **THEN** the lock on the previously-focused goal is released immediately (not lazily reaped)

#### Scenario: Release on goal completion
- **WHEN** the focused goal transitions to `complete` status via `complete_goal` (status persisted to the active file, so the pool scan excludes it)
- **THEN** the lock is released (co-located with archival; the goal is archived; no longer lockable)

#### Scenario: Pause relies on lazy reap
- **WHEN** the focused goal is paused (`pause_goal` — status flip only, NOT a `setGoal(null)`)
- **THEN** no explicit release fires; the heartbeat timer stops (goal no longer active); the lock lapses at `expiresAt` and is reaped by the next acquirer (or self-reaped on `/goal-resume`)

#### Scenario: Abort releases explicitly
- **WHEN** the focused goal is aborted (`abort_goal` → `setGoal(null, "aborted")` at 1860/3037)
- **THEN** the `state.goal` setter instrumentation fires `releaseLock(previousId)` immediately (abort is terminal; no stale lock lingers)

### Requirement: Advisory override with confirmation
The lock is advisory. The `/goal-focus` selector (including its single-open-goal fast-path) on a goal locked by another live session SHALL prompt the user with the owning session's identity (sessionId, pid) and a confirmation: "looks alive — take over anyway?". On confirmation, the system reaps the held lock and acquires fresh. On decline, focus does not change.

#### Scenario: Override refused
- **WHEN** the user runs `/goal-focus` and selects (or auto-selects via the single-open fast-path) a HELD goal and declines the confirmation
- **THEN** no lock is taken and focus does not change

#### Scenario: Override confirmed
- **WHEN** the user confirms the takeover prompt
- **THEN** the held lock is reaped and the new session acquires the lock

#### Scenario: Override on a stale lock proceeds without prompt
- **WHEN** `/goal-focus` targets a goal whose lock is STALE (PID dead or lease lapsed)
- **THEN** the lock is reaped silently and the new session acquires without prompting

### Requirement: Fail-open on lock errors (scope: no crash, manual work proceeds; auto-run still gated)
Lock acquisition, heartbeat, and release MUST fail open against CRASHES: if the filesystem operation throws (permissions, disk full), the system logs a warning and continues rather than throwing. **Scope of "fail-open"**: the session does not crash, and manual/explicit goal work (user-driven tool calls, `/goal-focus`, etc.) proceeds normally. **Auto-run is NOT fail-open**: if the session cannot prove it holds the lock (because the write failed), the auto-run chokepoint STILL blocks `queueContinuation` — the session cannot assert ownership of a goal it failed to lock. Locking is a coordination optimization for the multi-session case, not a security boundary, but the auto-run gate is a correctness invariant (no lock, no auto-run) that fail-open does not relax.

#### Scenario: Write fails — manual work proceeds, auto-run blocked
- **WHEN** `acquireLock` cannot write the `.lock` file (fs error)
- **THEN** a warning is logged, the session does NOT crash, manual/explicit goal work proceeds, BUT `queueContinuation`'s chokepoint finds no self-held lock and auto-run does NOT fire

### Requirement: Heartbeat detects lock loss
The heartbeat timer callback SHALL detect when the focus lock is no longer owned by the current session (owner mismatch or lock file missing). The `refreshLease` function SHALL return a status: `{ refreshed: true }` on success, or `{ refreshed: false, lostLock: true }` when the lock is gone (missing or owned by another session). On `lostLock`, the heartbeat callback SHALL: (a) stop the heartbeat timer (no more no-op refresh attempts), (b) refresh the footer and widget display to show `stale`, and (c) surface a user-facing notification: "Goal focus lock lost — another session took over or the lease lapsed. Use /goal-resume to reacquire." This closes the zombie-session gap where a session loses its lock but the heartbeat timer leaks indefinitely and the display continues showing `running`.

#### Scenario: Lease refreshed successfully
- **WHEN** the heartbeat fires and the lock is still owned by self (PID alive, lease fresh)
- **THEN** `refreshLease` returns `{ refreshed: true }`, the lease `expiresAt` is extended, and the heartbeat continues

#### Scenario: Lock stolen by another session
- **WHEN** the heartbeat fires, reads the lock, and finds the owner is a different session
- **THEN** `refreshLease` returns `{ refreshed: false, lostLock: true }`, the heartbeat timer stops, the footer/widget switch to `stale`, and the user sees the lock-lost notification

#### Scenario: Lock file missing (reaped)
- **WHEN** the heartbeat fires and the lock file no longer exists (reaped after lease lapse by another session that then released or crashed)
- **THEN** `refreshLease` returns `{ refreshed: false, lostLock: true }`, same handling as stolen scenario

#### Scenario: readLock error during heartbeat — fail-open, no false loss
- **WHEN** the heartbeat fires and `readLock` returns an error (EACCES, disk error)
- **THEN** `refreshLease` returns `{ refreshed: false }` WITHOUT `lostLock: true` (fail-open — do not claim lock loss on an fs error; the timer continues and retries next tick)

### Requirement: PID reuse window — known limitation
The two-signal liveness check (PID alive AND lease fresh) has a known limitation: if the owning PID dies and is reused by an unrelated process before the lease lapses (within the 3-minute default lease window), `isPidAlive` returns true and the lock appears held. The system SHALL treat this as an accepted trade-off of PID-based liveness without process-identity verification. The lease timer is the backstop — after the lease lapses (3 min with no heartbeat refresh from the dead original), the lock MUST become stale regardless of PID reuse. The display liveness signal is only as accurate as the lock's liveness; during the PID-reuse window (up to `leaseMs`), a dead session's goal may display `running`. This MUST self-correct after lease lapse.

#### Scenario: PID reused — false-positive held during lease window
- **WHEN** session S1 (pid 12345) crashes, PID 12345 is reused by an unrelated process within the 3-minute lease window, and the lease has not yet lapsed (heartbeat stopped at crash)
- **THEN** `isLockHeld` returns true (PID alive + lease fresh), the goal displays `running`, and acquisition by another session fails — until the lease lapses, at which point the lock becomes stale and the display switches to `stale`

#### Scenario: PID reused — self-corrects after lease lapse
- **WHEN** the lease lapses (3 min after last heartbeat) even though the reused PID is still alive
- **THEN** `isLockHeld` returns false (lease lapsed), the goal displays `stale`, and the lock is reapable by the next acquirer

### Requirement: Orphaned lock cleanup on pool scan
When the goal pool is scanned (for the picker, `/goal-list`, or focus resolution), the system SHALL reap stale lock files for goals that are no longer in the active pool (completed, archived, or deleted). This prevents orphaned lock files from accumulating when a goal is completed or deleted while its lock file persists (e.g., session crashed after `complete_goal` but before the `turn_end` archival that releases the lock). The cleanup is best-effort and non-blocking: iterate `.locks/*.lock`, check if the corresponding goal ID is in the active pool, and if not, reap the stale lock. Locks for goals still in the active pool are NOT reaped here (they are reaped lazily on `acquireLock`).

#### Scenario: Orphaned lock for completed goal reaped
- **WHEN** the pool scan finds a `.locks/<goalId>.lock` for a goal that has `status: complete` or has been archived (not in the active pool)
- **THEN** the lock file is reaped (deleted) during the scan

#### Scenario: Orphaned lock for deleted goal reaped
- **WHEN** the pool scan finds a `.locks/<goalId>.lock` for a goal whose goal file no longer exists
- **THEN** the lock file is reaped (deleted) during the scan

#### Scenario: Active goal lock not reaped during scan
- **WHEN** the pool scan finds a `.locks/<goalId>.lock` for a goal that IS in the active pool (even if the lock is stale)
- **THEN** the lock is NOT reaped during the scan (it is reaped lazily on `acquireLock` by the next session that focuses the goal)

