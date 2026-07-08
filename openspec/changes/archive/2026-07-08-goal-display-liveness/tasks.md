## 1. `readLockDetailed` — discriminated return (E1 fix)

- [ ] 1.1 Add `readLockDetailed(cwd, goalId): { status: "found"; lock: GoalFocusLock } | { status: "missing" } | { status: "error" }` in `extensions/goal-lock.ts`. Distinguishes: ENOENT → "missing"; EACCES/corrupt/other → "error"; valid parse → "found". Uses `fs.readFileSync` directly with try/catch that inspects `err.code`.
- [ ] 1.2 Refactor existing `readLock(cwd, goalId): GoalFocusLock | null` to delegate to `readLockDetailed`: found→lock, missing+error→null. Retain as the legacy wrapper for existing callers.
- [ ] 1.3 Unit tests: (a) valid lock → `{ status: "found", lock }`, (b) ENOENT → `{ status: "missing" }`, (c) corrupt JSON → `{ status: "error" }`, (d) invalid shape → `{ status: "error" }`, (e) EACCES simulation → `{ status: "error" }`.

## 2. `compactStatusLabel` + `statusLabel` + `footerStatus` liveness signal

- [ ] 2.1 Add optional `liveLockHolder?: boolean | undefined` to `compactStatusLabel` in `extensions/goal-core.ts`. When `status: active && autoContinue && liveLockHolder === false` → return `"stale"`. `undefined` → `"running"` (legacy). `true` → `"running"` (unchanged).
- [ ] 2.2 Add same param to `statusLabel` (verbose, used by footer) and `footerStatus`. Same logic: `false` → `stale`, `undefined` → legacy `running`.
- [ ] 2.3 Unit tests for all three functions: (a) active+autoContinue+`true` → running, (b) +`false` → stale, (c) +`undefined` → running, (d) paused+`false` → paused (lock irrelevant), (e) paused·agent+`false` → paused·agent.

## 3. Widget `displayIcon` liveness (goal-widget.ts)

- [ ] 3.1 Add `liveLockHolder?: boolean | undefined` to `displayIcon`'s input (the `GoalWidgetRecord` or a new param). When `status: active && autoContinue && liveLockHolder === false` → return `{ icon: "⌽", color: "muted", label: "stale" }`. `undefined` → existing `●`/`goal running` (legacy).
- [ ] 3.2 Add `getLiveLockHolder: () => boolean | undefined` to `GoalWidgetComponent` constructor options. Wire it into the record passed to `displayIcon`.
- [ ] 3.3 Unit tests: (a) active+autoContinue+lock true → `●` accent `goal running`, (b) +lock false → `⌽` muted `stale`, (c) +lock undefined → `●` accent `goal running` (legacy), (d) paused → unchanged regardless of lock.

## 4. `sortGoalsForPicker` liveness-aware ranking

- [ ] 4.1 Add optional `liveLockHolderSet?: Set<string>` param to `sortGoalsForPicker` in `extensions/goal-pool.ts`. Rank 0 only if `active && autoContinue && (!liveLockHolderSet || liveLockHolderSet.has(g.id))`. If set provided and goal NOT in it → rank 1 (non-running). `undefined` set → legacy (all active+autoContinue rank 0).
- [ ] 4.2 Unit tests: (a) running goal sorts first over stale, (b) stale sorts by recency with paused, (c) no set → legacy unchanged.

## 5. `goalSelectorLabel` + `buildGoalListText` plumbing

- [ ] 5.1 Add `liveLockHolderSet?: Set<string> | null` to `GoalSelectorLabelOptions` and `BuildGoalListTextOptions`. In `goalSelectorLabel`, compute `liveLockHolder`: null set → `undefined`; set present → `set.has(goal.id)`. Pass to `compactStatusLabel`.
- [ ] 5.2 In `buildGoalListText`, pass `liveLockHolderSet` to both `sortGoalsForPicker` and `goalSelectorLabel`.
- [ ] 5.3 Unit tests: label with set containing goal → `running`; without → `stale`; null set → `running` (legacy).

## 6. `computeLockInfo` (extends `computeHeldByOther`)

- [ ] 6.1 In `extensions/goal.ts`, rename/extend `computeHeldByOther` → `computeLockInfo(goals, cwd): { heldByOther: Map<string, string>; liveLockHolderSet: Set<string> }`. Use `readLockDetailed` + `isLockHeld`. Self-held live locks → `liveLockHolderSet` only. Other-held → both maps. Read errors → skip (don't add to set → treated as `undefined` legacy by display). Missing + `.locks/` dir exists → don't add to set (→ `false` stale by display). Missing + dir absent → set entire return to `null` sets (legacy fallback).
- [ ] 6.2 Add `.locks/` dir existence check: `fs.existsSync(lockDir(cwd))`. If false → return `{ heldByOther: new Map(), liveLockHolderSet: null }` (signals legacy fallback to all consumers).
- [ ] 6.3 Update all `computeHeldByOther` call sites (picker ~1733, `/goal-list` ~1827, `/goal-focus` ~1831) to destructure `{ heldByOther, liveLockHolderSet }` and pass to consumers.

## 7. Heartbeat lock-loss detection (M1/M2 fix)

- [ ] 7.1 Change `refreshLease` in `extensions/goal-lock.ts` to return `{ refreshed: boolean; lostLock?: boolean }`: success → `{ refreshed: true }`; owner mismatch or missing → `{ refreshed: false, lostLock: true }`; fs error during read → `{ refreshed: false }` (no `lostLock` — fail-open).
- [ ] 7.2 Update `startHeartbeatTimer` callback (goal.ts:735) to check the return. On `lostLock: true`: call `stopHeartbeatTimer()`, call `updateUI(ctx)` (refreshes footer+widget → shows `stale`), and `ctx.ui.notify("Goal focus lock lost — another session took over or the lease lapsed. Use /goal-resume to reacquire.", "warning")`.
- [ ] 7.3 Unit tests: (a) `refreshLease` success → `{ refreshed: true }`, (b) owner mismatch → `{ refreshed: false, lostLock: true }`, (c) missing → `{ refreshed: false, lostLock: true }`, (d) read error → `{ refreshed: false }` (no `lostLock`).

## 8. Footer status refresh passes liveness

- [ ] 8.1 In `syncStatusRefresh` (goal.ts:636), the interval callback calls `footerStatus(displayGoal)`. Add liveness: compute `isLockHeldBySelf(ctx.cwd, focusedGoalId)` (or read from a cached value) and pass to `footerStatus`. When the session lost its lock → footer shows `stale`.
- [ ] 8.2 Verify: the `statusRefreshCtx` is available in the closure. Access `statusRefreshCtx.cwd` for the liveness check.

## 9. Widget getter wiring

- [ ] 9.1 In `updateUI` (goal.ts:1005) and the widget constructor calls (~1019, ~1048), add `getLiveLockHolder: () => isLockHeldBySelf(ctx.cwd, focusedGoalId)` to the `GoalWidgetComponent` options. The widget uses this in `displayIcon`.
- [ ] 9.2 Verify: `isLockHeldBySelf` is already defined (goal.ts:749) and accessible from the closure.

## 10. Orphaned lock cleanup (E3)

- [ ] 10.1 Add `reapOrphanedLocks(cwd, activeGoalIds: Set<string>)` in `extensions/goal-lock.ts`: read `.locks/` dir, for each `*.lock` file parse goalId from filename, if goalId NOT in `activeGoalIds` → `fs.unlinkSync`. Fail-open. Skip `.tmp` files.
- [ ] 10.2 Call `reapOrphanedLocks` at the top of pool-scan paths: before `buildGoalListText`, before the picker build, before `resolveSessionFocus`. Pass the set of active goal IDs.
- [ ] 10.3 Unit tests: (a) orphaned lock for completed goal → reaped, (b) orphaned lock for deleted goal → reaped, (c) active goal lock → NOT reaped, (d) `.locks/` dir missing → no-op, (e) `.tmp` file → not touched.

## 11. Integration tests

- [ ] 11.1 Goal `status: active, autoContinue: true`, lock held by self (live) → picker shows `running`, footer shows `running`, widget shows `●`.
- [ ] 11.2 Goal `status: active, autoContinue: true`, lock absent, `.locks/` dir present → picker shows `stale`, footer shows `stale`, widget shows `⌽`.
- [ ] 11.3 Goal `status: active, autoContinue: true`, lock present but PID dead → picker shows `stale`, footer shows `stale`, widget shows `⌽`.
- [ ] 11.4 Goal `status: active, autoContinue: true`, `.locks/` dir absent → picker shows `running` (legacy), footer shows `running`, widget shows `●`.
- [ ] 11.5 Stale goal sorts after running goal regardless of `updatedAt`.
- [ ] 11.6 Heartbeat detects lock stolen by another session → timer stops, footer shows `stale`, notification surfaces.
- [ ] 11.7 Orphaned lock for completed goal reaped during pool scan.
- [ ] 11.8 `readLockDetailed`: corrupt lock file → `{ status: "error" }` → display shows `running` (legacy fallback, not stale).

## 12. Verification

- [ ] 12.1 `npm test` — all green (existing + new).
- [ ] 12.2 `npm run check` — tsc clean.
- [ ] 12.3 `openspec validate goal-display-liveness` passes.
- [ ] 12.4 Manual: open `/goal-focus` picker in a cwd with 4 dead-session goals + `.locks/` dir → all show `stale` (not `running`).
- [ ] 12.5 Manual: footer status bar shows `stale` for a goal whose lock was lost.
- [ ] 12.6 Manual: above-editor widget shows `⌽` for a stale goal.
- [ ] 12.7 Manual: heartbeat lock-loss → notification appears, timer stops, display updates.
