## 1. Helpers (goal-core.ts / new goal-display.ts)

- [x] 1.1 Add `shortGoalId(id: string): string` — returns substring after final `-`; pure.
- [x] 1.2 Add `formatRelativeTime(iso: string, now = Date.now()): string` — `just now` (<60s), `Xm`/`Xh`/`Xd ago`, `—` on missing/invalid, clamp future → `just now`.
- [x] 1.3 Add `formatAbsoluteShort(iso: string): string` — local `MM-DD HH:mm`, `—` on invalid.
- [x] 1.4 Extend `displayObjectiveTitle` to strip leading ` ``` ` / ` ```` ` / `> ` / surrounding `"` / `'` from the chosen title line.
- [x] 1.5 Add `compactStatusLabel(goal): string` — `running` | `paused·agent` | `paused` | `drafting`.

## 2. Picker label builder (goal-pool.ts)

- [x] 2.1 Add `resolveShortIdsForPool(goals): Map<id, displayId>` — collision-guarded: shared suffix → both fall back to full id.
- [x] 2.2 Rewrite `goalSelectorLabel(goal, focusedGoalId, opts)` to emit: `${marker}${sisyphusGlyph} ${shortId} | ${compactStatus} | ${absoluteShort} · ${relative} | ${sanitizedTitle}${lockPill}`. No `activePath`.
- [x] 2.3 Update `buildGoalListText` to share the row formatter, keep the `activePath` sub-line, and emit a one-line column legend in the preamble.
- [x] 2.4 Add `sortGoalsForPicker(goals): GoalRecord[]` — running first, then `updatedAt` desc (stable).

## 3. Lock-owner pill (goal.ts)

- [x] 3.1 In `focusGoalCommand`, precompute `heldByOther` per open goal via existing `readLock` + `isLockHeld` + owner-session check; pass into `goalSelectorLabel` opts.
- [x] 3.2 Add `shortSessionId(sessionId)` with same collision fallback as `shortGoalId`.
- [x] 3.3 Verify `confirmFocusOverride` post-selection flow is unchanged (pill is informational only).

## 4. Picker wiring (goal.ts)

- [x] 4.1 Replace the `byLabel` map construction to use full rendered label as key (not short id).
- [x] 4.2 Change `ctx.ui.select` title to `Focus open goal · ${open.length} open`.
- [x] 4.3 Apply `sortGoalsForPicker` to `open` before building labels.
- [x] 4.4 Keep the single-open fast-path and headless `!ctx.hasUI` path producing the same compact rows (share formatter).

## 5. Tests

- [x] 5.1 `shortGoalId`: typical, no-dash, collision set.
- [x] 5.2 `formatRelativeTime`: 30s, 2h, 3d, future clamp, invalid.
- [x] 5.3 `displayObjectiveTitle`: fence, blockquote, quote, normal prose.
- [x] 5.4 `goalSelectorLabel` snapshot: running, paused·agent, held-by-other, suffix-collision fallback.
- [x] 5.5 `buildGoalListText`: legend present, path sub-line present.
- [x] 5.6 `sortGoalsForPicker`: running-first + recency.
- [x] 5.7 Selection-mapping test: two colliding-suffix goals resolve to distinct ids via the full-label `byLabel` map.

## 6. Verification

- [x] 6.1 `npm run build` clean (tsc).
- [x] 6.2 `npm test` green.
- [x] 6.3 Manual: create 3 goals (1 running, 1 sisyphus paused, 1 held by a second session) and screenshot `/goal-focus` + `/goal-list`.
- [x] 6.4 Manual: confirm selecting a collision-fallback goal focuses the correct goal.
