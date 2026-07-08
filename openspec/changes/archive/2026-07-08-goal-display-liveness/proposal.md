## Why

Goals whose owning session has crashed, been killed, or lost its lease still display `running` across THREE independent display surfaces: the `/goal-focus` picker, the footer status bar (1s refresh via `statusRefreshTimer`), and the above-editor goal widget. All three read `status: "active" && autoContinue` directly from the goal file on disk, with no consultation of the focus lock's two-signal liveness (PID alive + lease fresh). When a session dies, nothing flips the on-disk status to `paused`, so the dead goal advertises itself as actively running indefinitely — misleading the user into thinking live work is in progress when no live session holds the goal.

Additionally, the heartbeat timer (`refreshLease`) silently returns on owner mismatch when a lock is stolen mid-session — the session enters a zombie state (goal focused, no lock, no auto-run, heartbeat timer leaking) without any detection or user-facing signal. The footer continues showing `running` for the session that lost its lock.

## What Changes

### Display liveness (all three surfaces)
- `compactStatusLabel` (picker + `/goal-list`) SHALL accept an optional lock-liveness signal. When disk status is `active + autoContinue` but no live lock holder exists, display `stale` instead of `running`.
- `statusLabel` / `footerStatus` (footer status bar) SHALL accept the same liveness signal. When the current session's focused goal has no live lock, display `stale` in the footer.
- `goal-widget.ts:displayIcon` (above-editor widget) SHALL accept the liveness signal. When the goal has no live lock, display a stale icon (`⌽` muted) instead of the running icon (`●` accent).
- Genuinely-running goals (live lock held by self or another session) continue to display `running` unchanged.
- Deterministic row ordering SHALL treat `stale` goals as non-running — sort by recency alongside paused goals, NOT first.

### Liveness signal computation
- The picker, `/goal-list` builder, footer refresh, and widget SHALL compute a per-goal liveness signal via `readLock` + `isLockHeld` for every open goal with on-disk `status: active` and `autoContinue: true`.

### Heartbeat lock-loss detection (M1/M2 fix)
- The heartbeat timer callback SHALL detect when `refreshLease` finds the lock is no longer owned by self (owner mismatch or missing). On detection: stop the heartbeat timer, surface a user-facing message ("Goal <id> focus lock lost — another session took over or the lease lapsed. Use /goal-resume to reacquire."), and refresh the footer/widget display to show `stale`.

### `readLock` error discrimination (E1 fix)
- `readLock` SHALL return a discriminated result distinguishing "missing" (ENOENT) from "error" (EACCES, corrupt JSON, other fs error). The liveness signal computation uses this: "missing" + `.locks/` dir present → `false` (stale); "error" → `undefined` (legacy fallback, do not false-positive stale on a lock we cannot read).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `goal-focus-picker`: Status segment gains `stale` value; `running` gated on live lock holder; `stale` goals demoted in sort order; liveness signal computed for display; `readLock` returns discriminated result.
- `goal-focus-locking`: Heartbeat callback detects lock loss (owner mismatch/missing) → stops timer + surfaces message; `refreshLease` returns a status indicating whether the refresh succeeded or the lock was lost.

## Impact

- **Affected code**:
  - `extensions/goal-core.ts` — `compactStatusLabel`, `statusLabel`, `footerStatus` gain optional `liveLockHolder?: boolean | undefined` parameter.
  - `extensions/goal-pool.ts` — `formatPickerRow`/`goalSelectorLabel`, `buildGoalListText`, `sortGoalsForPicker` receive + propagate liveness signal.
  - `extensions/widgets/goal-widget.ts` — `displayIcon` gains liveness awareness; widget constructor/getters receive liveness signal.
  - `extensions/goal-lock.ts` — `readLock` returns `{ status: "found", lock } | { status: "missing" } | { status: "error" }` (or equivalent); `refreshLease` returns `{ refreshed: boolean; lostLock?: boolean }`.
  - `extensions/goal.ts` — heartbeat callback (line ~735) handles lock-loss detection; `statusRefreshTimer` (line ~636) passes liveness to `footerStatus`; `updateUI`/widget getter passes liveness to widget; `computeHeldByOther` extended to return `liveLockHolderSet`.
- **Dependencies**: uses existing `goal-lock.ts` primitives — no new modules.
- **Backward compatibility**: `readLock` signature change is internal (callers updated in same change). Display functions gain optional params (backward-compatible for external callers if any). Repos without `.locks/` dir → legacy `running` fallback (unchanged).
