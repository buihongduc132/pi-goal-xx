## ADDED Requirements

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
