## Why

When multiple pi sessions run in the same cwd (worktree-per-feature, parallel verification, ad-hoc second session), a fresh session auto-focuses the only open goal in `.pi/goals/` and auto-runs it on `session_start` — stealing the goal from the session that was actively working on it. There is no coordination mechanism: focus state is per-session but auto-derived from a cwd-shared disk pool, with no gate between "I discovered a goal" and "I started running it." This causes duplicate work, conflicting writes to the same goal file, and the auditor sub-session (post-inheritance fix) colliding with its parent.

## What Changes

- **Goal focus locks**: a lease-based advisory lock per goal (`<cwd>/.pi/goals/.locks/<goalId>.lock`), with two independent liveness signals (PID alive AND lease fresh). Either signal going stale makes the lock reapable.
- **Auto-focus gated by lock**: `resolveSessionFocus` only auto-focuses goals not locked by another live session. If the only open goal is held, the new session starts unfocused.
- **Auto-run gated by lock acquisition**: `queueContinuation` (the auto-run trigger) fires only after a lock is successfully acquired. No lock → no auto-run.
- **Auto-focus restricted to session `reason: "resume"` by default** (LD3): fresh `new`/`startup` sessions never auto-focus. Env flag `PI_GOAL_AUTO_FOCUS` allows opting back into broader auto-focus.
- **Explicit override asks before stealing** (LD2): `/goal-focus <id>` on a locked goal prompts "S1 looks alive, take over anyway?" before acquiring. The lock is advisory; the user is the authority.
- **Heartbeat refresh**: the lock owner extends its lease via a single 60-second backstop timer while focused & active. No event-driven refresh (`turn_end`, `tool_execution_end`, write-hooks) is added — the timer alone refreshes the lease ~3× within the 3-minute window, covering both idle presence and long tool executions. (Per LD1 "least resistant path"; both verifiers confirmed event-driven paths are redundant.)
- **Implementation surface**: new `goal-lock.ts` module (lock primitives); `acquireLock`/`releaseLock`/heartbeat calls at focus ownership transitions (session_start resume, `/goal-focus`, `/goal-resume`, new-goal creation, `setGoal(null)` clear) and at `session_shutdown`; single chokepoint guard at the top of `queueContinuation`.
- **Clean release on `session_shutdown` and focus change**: lock files are deleted; switching focus releases the old goal's lock before acquiring the new one.

## Capabilities

### New Capabilities
- `goal-focus-locking`: Per-goal advisory locking with lease-based liveness, heartbeat refresh, reap-on-acquire, and clean release. Prevents two sessions from simultaneously focusing/running the same goal.

### Modified Capabilities
- `goal-session-focus`: Auto-focus behavior changes — now restricted to `reason: "resume"` by default (env-flag overridable) AND gated by the focus lock. Previously auto-focused the only open goal on any session start.

## Impact

- **Affected code**:
  - `extensions/goal-pool.ts` — `resolveSessionFocus` gains a lock check; auto-focus restricted to unlocked goals.
  - `extensions/goal.ts` — `session_start` handler gates `queueContinuation` behind lock acquisition; `loadState` respects auto-focus-reason restriction; new `acquireLock`/`releaseLock`/heartbeat calls at focus ownership transitions (session_start resume, `/goal-focus`, `/goal-resume`, new-goal creation, `setGoal(null)` clear) and `session_shutdown`; single chokepoint guard at the top of `queueContinuation`; new env flag `PI_GOAL_AUTO_FOCUS`.
  - `extensions/storage/goal-files.ts` (or new `extensions/goal-lock.ts`) — lock file read/write/verify/reap logic.
  - `/goal-focus` command — steal-with-prompt flow when target is locked.
- **New disk artifacts**: `<cwd>/.pi/goals/.locks/<goalId>.lock` (JSON sidecar per locked goal).
- **Dependencies**: none new. Uses `fs.renameSync` (atomic), `process.kill(pid, 0)` (liveness), existing event hooks.
- **Backward compatibility**: default behavior changes (auto-focus no longer fires on fresh sessions). Users who relied on it set `PI_GOAL_AUTO_FOCUS=all` (or similar) to restore prior behavior.
- **Hypothesized resolved collisions** (verify via task 6 before merge): C1 (auto-focus steal), C5 (dual-focus). C4 (auditor sub-session collision) is hypothesized solved by convergence (auditor's `session_start` `reason` is expected to be `"startup"`, which the resume-only default excludes; AND the parent lock blocks acquisition) — this is UNVERIFIED and task 6.1 must confirm the auditor's actual `session_start` reason before relying on it.
- **Out of scope**: C2 (lost-update on goal file — lock reduces but doesn't eliminate it), C3 (settings cross-contamination — user-declared out of scope).
