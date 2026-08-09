# Intention — Fix goal focus lock staleness (PID recycle + web popup cascade)

**Date:** 2026-07-07
**Change:** `fix-goal-focus-lock-staleness`
**Source investigation:** `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md`

## User-requested goal (verbatim intent)

Fix two bugs:
1. **"process dead but it is still locked"** — a pi session owning a focused goal dies, but the goal lock stays held, blocking other sessions.
2. **"pi-web UI keeps showing the blocking popup on launch"** — launching a pi session in pi-web repeatedly surfaces a blocking popup that won't dismiss / keeps reappearing.

User explicitly requested: create the fix, make a worktree, return abs paths to spec + intention + worktree.

## Derived scope

- **Root cause (bug #1):** `extensions/goal-lock.ts` `isPidAlive()` uses `process.kill(pid, 0)` = PID *existence*, no process-identity check. OS PID recycling within the 3-min lease → false-held. Plus `reapStaleLock` only runs on `acquireLock`, so stale locks never clear without an acquisition attempt.
- **Cascade (bug #2):** the false-held lock makes `confirmFocusOverride` fire the takeover `ctx.ui.confirm` popup on every auto-focus/resume in pi-web.
- **Fix:** add process-identity signal (`startTimeMs` start-time cross-check, cross-platform); add reap-on-read to `computeHeldByOther` + `confirmFocusOverride`. Fixing #1 resolves the #2 cascade (no separate frontend change).

## Non-goals (explicitly out)

- pi-web frontend popup RPC bug (H3) — only if repro shows it's independent of the lock cascade.
- Lease/heartbeat tuning.
- Cluster-wide / distributed locking.

## Verification contract

Before marking complete: repro from the findings doc confirms (a) SIGKILL + PID recycle no longer false-holds, (b) `/goals` clears stale lock without acquire, (c) legacy lock files (no `startTimeMs`) still resolve via fallback. All `tests/goal-lock*.test.ts` green.
