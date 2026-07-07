## 1. Process-identity start-time resolution (RED phase)

- [ ] 1.1 Write failing test: `getProcessStartTime(pid)` returns a number on Linux via `/proc/<pid>/stat` field 22 (mock fs read, assert conversion `bootMs + (ticks/100)*1000`)
- [ ] 1.2 Write failing test: `getProcessStartTime` returns `null` when `/proc/<pid>/stat` unreadable (ENOENT/EACCES) — fail-open, no throw
- [ ] 1.3 Write failing test: `getProcessStartTime` on macOS path uses `ps -p <pid> -o lstart` (mock child_process exec, parse timestamp)
- [ ] 1.4 Write failing test: `getProcessStartTime` on unsupported platform returns `null`
- [ ] 1.5 Write failing test: boot-time read from `/proc/stat` `btime` line (cached within process lifetime)

## 2. Lock schema + acquisition writes startTimeMs (GREEN phase)

- [ ] 2.1 Add `startTimeMs?: number | null` to `GoalFocusLock.owner` type in `goal-lock.ts`
- [ ] 2.2 Implement `getProcessStartTime(pid): number | null` per design D2/D3
- [ ] 2.3 Update `acquireLock` and `refreshLease` to record `getProcessStartTime(process.pid)` into `owner.startTimeMs`
- [ ] 2.4 Update `parseLock`/`readLock` to tolerate missing `startTimeMs` (legacy locks → `null`)

## 3. Identity-aware isPidAlive (closes recycle gap)

- [ ] 3.1 Write failing test: `isPidAlive` returns FALSE when PID exists but start time mismatches (recycle scenario, lease still fresh) — the core bug repro
- [ ] 3.2 Write failing test: `isPidAlive` returns TRUE when PID exists and start time matches
- [ ] 3.3 Write failing test: `isPidAlive` falls back to PID-existence-only when `startTimeMs` is `null` (legacy lock)
- [ ] 3.4 Implement: `isPidAlive` now takes `(pid, startTimeMs?)` — if `startTimeMs != null`, compare to `getProcessStartTime(pid)`; mismatch → false
- [ ] 3.5 Update `isLockHeld`/`isLockStale` to pass `lock.owner.startTimeMs` through to `isPidAlive`

## 4. Reap-on-read (clears stale locks without acquisition)

- [ ] 4.1 Write failing test: `computeHeldByOther` reaps a stale lock it reads (file deleted, returns empty map for that goal)
- [ ] 4.2 Write failing test: `computeHeldByOther` does NOT reap a HELD lock (read is still non-destructive for live locks)
- [ ] 4.3 Write failing test: `confirmFocusOverride` reaps a stale lock silently and returns true (no popup) when owner is dead
- [ ] 4.4 Implement: call `reapStaleLock(cwd, goalId)` at the start of `computeHeldByOther` per-goal loop and in `confirmFocusOverride` stale branch (before the `return true`)
- [ ] 4.5 Verify TOCTOU guard in `reapStaleLock` still holds (re-read before unlink) — no new race introduced by additional callers

## 5. Update existing tests + regression sweep

- [ ] 5.1 Update any existing `isPidAlive` tests that assume PID-only signature to new `(pid, startTimeMs?)` signature
- [ ] 5.2 Run full `tests/goal-lock.test.ts` + `tests/goal-lock-settings.test.ts` — all green
- [ ] 5.3 Run `pnpm test` (or project test command) — no regressions in goal.ts consumers
- [ ] 5.4 Lint + typecheck pass

## 6. Integration verification (bug repro confirmation)

- [ ] 6.1 Manual repro per `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md`: focus goal in session A, SIGKILL A, force PID recycle, confirm session B no longer sees false-held lock (was the bug)
- [ ] 6.2 Confirm `computeHeldByOther` clears the stale lock on next `/goals` render without needing an acquire attempt
- [ ] 6.3 Confirm legacy lock (manually craft a lock file without `startTimeMs`) still resolves via fallback path

## 7. Docs + spec sync

- [ ] 7.1 Update `extensions/goal-lock.ts` header comment (two-signal → three-signal liveness description, D2 → identity-aware)
- [ ] 7.2 Note the `computeHeldByOther` contract change (pure-read → read+reap-stale) in code comment
- [ ] 7.3 Cross-reference `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md` in the change proposal (done) and confirm bug cascade resolved
