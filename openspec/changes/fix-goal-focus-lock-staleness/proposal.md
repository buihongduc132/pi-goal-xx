## Why

When a pi session owning a focused goal dies (crash, SIGKILL, OOM), the goal lock can remain falsely "held" because `isPidAlive()` uses `process.kill(pid, 0)` — a PID-existence check with no process-identity verification. If the OS recycles that PID to another process within the 3-minute lease window, the lock reports held (false positive), blocks other sessions from focusing the goal, and the web UI surfaces a persistent "take over" popup on launch. Additionally, `reapStaleLock` only runs on `acquireLock`, so a stale lock persists on disk indefinitely until another session triggers acquisition.

## What Changes

- Add process-identity signal to `isPidAlive`: record `startTimeMs` (process start time) at lock acquisition; on liveness check, verify the current process at that PID has a matching start time. Cross-platform: Linux via `/proc/<pid>/stat`, macOS via `sysctl KERN_PROCARGS2` / `ps -o lstart`, fallback to PID-only on unsupported platforms.
- Make `reapStaleLock` run on read paths too: `computeHeldByOther` (goal picker/list) and `confirmFocusOverride` should reap stale locks on sight, not just `acquireLock`. This clears stale locks even when no acquisition is attempted.
- No change to `confirmFocusOverride` popup path itself — it is correct; the bug is upstream (false-held lock).

## Capabilities

### New Capabilities
- `goal-lock-process-identity`: process-identity verification for PID liveness (start-time cross-check, cross-platform fallback, nonce stored in lock file).

### Modified Capabilities
- `goal-focus-locking`: staleness detection now uses process-identity (not just PID existence); reap-on-read added to read paths (picker/list, takeover confirm).

## Impact

- `extensions/goal-lock.ts`: `isPidAlive` signature changes (now takes lock object for start-time comparison); new `getProcessStartTime(pid)` helper; `GoalFocusLock.owner` gains `startTimeMs` field; `reapStaleLock` called from `computeHeldByOther` and `confirmFocusOverride`.
- `extensions/goal.ts`: `acquireLock` call site writes `startTimeMs`; `computeHeldByOther` and `confirmFocusOverride` now reap stale on read.
- `tests/goal-lock.test.ts`: new test cases for PID-recycle scenario (mocked start-time mismatch), reap-on-read behavior.
- Backward compatibility: locks written without `startTimeMs` (older sessions) fall back to PID-only check (current behavior) — no breaking change for in-flight locks.
