## Context

The `/goal-focus` picker, footer status bar, and above-editor widget all render goal status from on-disk fields only (`status`, `autoContinue`, `stopReason`) — none consult the focus-lock's two-signal liveness (PID alive + lease fresh). When a session dies, the goal file's `status: active` is never flipped, so the dead goal shows `running` across all three surfaces indefinitely.

The lock system (`goal-lock.ts`) already has liveness primitives (`readLock`, `isLockHeld`, `isPidAlive`), but they are used only for: (1) the lock-owner pill in the picker (other-session live locks only), and (2) the auto-focus/auto-run gating. Neither surfaces the "no live holder" state to the user's display.

Additionally, the heartbeat timer (`refreshLease`) silently returns when it detects an owner mismatch — it does not signal the session that it lost the lock. The heartbeat timer keeps running indefinitely (calling `refreshLease` which no-ops), the footer keeps showing `running`, and the session is in a zombie state (focused, lockless, no auto-run, no user message).

## Goals / Non-Goals

**Goals:**
- Dead-session goals display `stale` instead of `running` across ALL THREE display surfaces: picker, footer, widget.
- Heartbeat detects lock loss → stops timer → refreshes display → surfaces message (closes zombie-session gap).
- `readLock` discriminates "missing" from "error" → prevents false-positive `stale` on permission/corrupt-lock.
- Orphaned lock files (completed/deleted goals) cleaned up during pool scan.
- Graceful degradation: when liveness is unknown (no `.locks/` dir, fs error), fall back to legacy `running`.
- `stale` goals sort as non-running in the picker.

**Non-Goals:**
- Automatically flipping `status: active` → `paused` on disk when a session dies. Display change is read-only.
- Process-identity verification (e.g., checking `/proc/<pid>/cmdline` to confirm the PID is actually a pi session). The lease timer is the backstop for PID reuse. Out of scope — see PID Reuse Window requirement.
- Changing the lock-owner pill behavior, `/goal-resume`, or `/goal-focus` override flow — unchanged.
- Verbose `statusLabel` for the auditor sub-session — the auditor runs in a live sub-session and does not hold a goal lock.

## Decisions

### D1: Tri-state liveness signal in display functions

`compactStatusLabel`, `statusLabel`, `footerStatus`, and `displayIcon` each gain an optional `liveLockHolder?: boolean | undefined` parameter:
- `true` → live lock holder exists → `running` (existing behavior).
- `false` → confirmed no live holder → `stale`.
- `undefined` → cannot determine → `running` (legacy fallback).

**Rationale**: The `undefined` fallback is critical for backward compatibility. Repos that never used locking would have every `active` goal show `stale`. The `.locks/` dir existence check is the proxy for "is locking enabled in this cwd?"

### D2: `readLockDetailed` — discriminated return for error vs missing

The current `readLock` catches ALL exceptions and returns `null`, conflating ENOENT (missing), EACCES (permission), and corrupt JSON. This makes it impossible for the liveness computation to distinguish "the lock file genuinely doesn't exist" (→ stale) from "we can't read it due to a permission error" (→ unknown). A new `readLockDetailed` returns `{ status: "found", lock } | { status: "missing" } | { status: "error" }`. A legacy `readLock` wrapper maps found→lock, missing+error→null for existing callers.

**Rationale**: Distinguishing "missing" from "error" prevents false-positive `stale` on permission-denied locks. A corrupt lock file (valid file, broken JSON) is treated as "error" not "missing" — a broken lock may indicate an active session mid-write, so we should not claim staleness.

**Alternatives considered**:
- Keep `readLock` as-is, treat null as stale when `.locks/` exists: simpler, but false-positives on permission errors. Rejected.
- Throw from `readLock`: breaks all existing callers, violates fail-open. Rejected.

### D3: Heartbeat lock-loss detection

`refreshLease` currently returns `void` and silently no-ops on owner mismatch. Change it to return `{ refreshed: boolean; lostLock?: boolean }`:
- `{ refreshed: true }` — lease extended.
- `{ refreshed: false, lostLock: true }` — lock missing or owned by another session → the session lost it.
- `{ refreshed: false }` (no `lostLock`) — fs error during read (fail-open; timer continues).

The heartbeat callback (`startHeartbeatTimer` at goal.ts:735) checks the result. On `lostLock: true`: stop the heartbeat timer, call `updateUI(ctx)` to refresh footer+widget (which now checks liveness and shows `stale`), and `ctx.ui.notify(...)` with the lock-lost message.

**Rationale**: This closes the zombie-session gap. Without it, the heartbeat timer leaks indefinitely and the footer shows `running` forever for a session that lost its lock.

**Alternatives considered**:
- Check `isLockHeldBySelf` in the `statusRefreshTimer` (1s interval) instead of the heartbeat (60s): more responsive but adds an fs read every second. The 60s heartbeat is sufficient — lock loss is not a time-critical display update.
- Add a separate `setInterval` that only checks lock ownership: redundant with the heartbeat. Rejected.

### D4: Widget liveness via getter injection

The `GoalWidgetComponent` receives data via constructor getters (`getGoal`, `getOpenGoalCount`, etc.). Add a `getLiveLockHolder: () => boolean | undefined` getter. The widget's `displayIcon` function uses it to choose between `●` (running) and `⌽` (stale). The hosting session provides the getter, calling `isLockHeldBySelf(cwd, focusedGoalId)`.

**Rationale**: The widget already uses the getter-injection pattern — adding one more getter is the minimal change. The widget does not need to know about lock files; it just needs a boolean.

### D5: `computeHeldByOther` → `computeLockInfo`

Extend `computeHeldByOther(goals, cwd)` to also return a `liveLockHolderSet: Set<string>`. Rename to `computeLockInfo`. Self-held live locks go into `liveLockHolderSet` (for display liveness) but NOT into `heldByOther` (for the pill). Other-held live locks go into both. The function also uses `readLockDetailed` to build the set: "found" + `isLockHeld` → live; "missing" + dir present → stale; "error" → undefined (skip, legacy fallback).

### D6: Orphaned lock cleanup during pool scan

Add a `reapOrphanedLocks(cwd, activeGoalIds: Set<string>)` call at the top of the pool-scan paths (picker build, `/goal-list`, focus resolution). It reads `.locks/*.lock`, and for any lock whose `goalId` is NOT in `activeGoalIds`, reaps it (delete). This is best-effort + fail-open. Stale locks for ACTIVE goals are NOT reaped here (lazy reap on `acquireLock`).

**Rationale**: Without this, completed/archived goals' lock files persist forever (the session that completed them may have crashed before `turn_end` archival released the lock). This is disk cruft, not a correctness bug, but it pollutes the `.locks/` dir and can confuse manual inspection.

## Risks / Trade-offs

**[Risk] False-positive `stale` on a genuinely-running goal** → Mitigation: tri-state signal (`undefined` = legacy fallback) + `readLockDetailed` error discrimination (D2). The only false-positive scenario is PID reuse during the lease window (see PID Reuse Window requirement), which self-corrects after `leaseMs` (3 min default).

**[Risk] `refreshLease` signature change breaks callers** → Mitigation: all callers are internal (`goal.ts` heartbeat callback). Update in same change. No external API.

**[Risk] `readLockDetailed` adds complexity** → Mitigation: legacy `readLock` wrapper retained. New function is only used by liveness computation. Existing callers don't change.

**[Risk] Footer status refresh (1s interval) now does an fs read for liveness** → Mitigation: `isLockHeldBySelf` is a single `readFileSync` + JSON parse of a tiny file. Acceptable overhead (<1ms per second). If profiling shows issues, cache the result with a 1s TTL.

**[Trade-off] Display-only fix does not mutate disk state** → The goal file still says `status: active`. The display change is cosmetic. A future change could add a background reaper that flips dead-session goals to `paused` on disk, but that is out of scope.

**[Trade-off] PID reuse window (up to `leaseMs`)** → A dead session's goal may display `running` for up to 3 minutes if its PID was reused. This is inherent to PID-based liveness. Process-identity verification (checking `/proc/<pid>/cmdline`) would fix this but adds platform-specific complexity and a `/proc` dependency. Deferred.

**[CA1] Orphaned lock cleanup only runs during pool scan** → If no session ever opens the picker or `/goal-list` in a cwd, orphaned locks persist. This is acceptable — the cleanup is opportunistic, not a background daemon. A separate cron/systemd job could be added if needed.
