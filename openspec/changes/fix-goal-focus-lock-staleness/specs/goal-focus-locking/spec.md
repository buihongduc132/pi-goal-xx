## MODIFIED Requirements

### Requirement: Two-signal liveness check
The system SHALL consider a lock HELD if and only if ALL of the following hold: (1) the owning PID is alive (`process.kill(pid, 0)` succeeds OR throws `EPERM` — process exists but owned by another user; both mean alive); (2) the process at that PID has a start time matching the recorded `startTimeMs` (when `startTimeMs` is present — process-identity check, see `goal-lock-process-identity`); AND (3) `now < expiresAt` (lease not lapsed). If any signal fails (PID dead = `ESRCH`, start-time mismatch = PID recycled, or lease lapsed), the lock is STALE and reapable. When `startTimeMs` is absent (legacy lock), the process-identity check is skipped (PID-existence only).

#### Scenario: All signals healthy
- **WHEN** a lock's owning PID is alive, start time matches, and `expiresAt` is in the future
- **THEN** the lock is HELD and acquisition by another session MUST fail

#### Scenario: Owning process dead
- **WHEN** `process.kill(pid, 0)` throws `ESRCH` (no such process)
- **THEN** the lock is STALE and reapable

#### Scenario: Owning process alive but cross-user (EPERM)
- **WHEN** `process.kill(pid, 0)` throws `EPERM` and start time matches and `expiresAt` is in the future
- **THEN** the lock is HELD (EPERM = process exists; start-time confirms it is the owner)

#### Scenario: Lease lapsed
- **WHEN** the owning PID is alive and start time matches but `now >= expiresAt`
- **THEN** the lock is STALE (hung or suspended session) and reapable

#### Scenario: PID recycled by unrelated process within lease window
- **WHEN** the original owner died, the OS recycled the PID to an unrelated process, `process.kill(pid, 0)` succeeds, BUT start time does NOT match, and `expiresAt` is still in the future
- **THEN** the lock is STALE (process-identity check caught the recycle) and reapable — closes the false-held window that previously persisted until lease lapse

### Requirement: Reap-on-acquire AND reap-on-read
The system SHALL, during `acquireLock`, read any existing lock file. If a held lock exists for another session, acquisition MUST fail. If a stale lock exists, it MUST be reaped (deleted) before writing the new lock. After atomic write, the system MUST re-read to verify ownership; if the ownerId does not match the acquiring session, acquisition MUST fail (boot-race loser backs off). ADDITIONALLY, read paths that surface lock state to the user (`computeHeldByOther` for the goal picker/list, `confirmFocusOverride` for takeover prompts) SHALL reap stale locks on sight, so that a stale lock clears even when no acquisition is attempted — preventing the UI from indefinitely displaying a falsely-held lock and the associated blocking takeover popup.

#### Scenario: No existing lock
- **WHEN** `acquireLock(goalId, self)` is called and no `.lock` file exists
- **THEN** the system writes the lock atomically, verifies ownership, and succeeds

#### Scenario: Held by another session
- **WHEN** `acquireLock(goalId, self)` is called and the existing lock is HELD by another session
- **THEN** acquisition fails and the caller does NOT focus or auto-run the goal

#### Scenario: Stale lock reaped on acquire
- **WHEN** `acquireLock(goalId, self)` is called and the existing lock is STALE
- **THEN** the system deletes the stale lock, writes its own atomically, verifies, and succeeds

#### Scenario: Concurrent acquisition race
- **WHEN** two sessions call `acquireLock(goalId)` simultaneously with no prior lock
- **THEN** one's atomic rename wins; the loser's verify-read finds a different ownerId and fails

#### Scenario: Stale lock reaped on read (picker/list)
- **WHEN** `computeHeldByOther` reads a lock that is STALE and another session is NOT attempting acquisition
- **THEN** the system reaps the stale lock (deletes it) so the goal picker/list no longer shows it as held

#### Scenario: Stale lock reaped on takeover confirm
- **WHEN** `confirmFocusOverride` reads a lock that is STALE before prompting the user
- **THEN** the system reaps the stale lock silently and proceeds (does NOT show the takeover popup for a lock whose owner is already dead)
