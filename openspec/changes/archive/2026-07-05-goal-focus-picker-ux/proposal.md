## Why

The `/goal-focus` picker surfaces machine artifacts to humans: raw full goal IDs (`mr0q1gdu-svqf4i`), an uninformative filename row (`.pi/goals/active_goal_…md`), duplicate columns (`sisyphus` shown in both status and mode), leaked internals (`(agent)` stop-reason jargon), and zero time context — no created-at, no last-touched, no relative "2h ago". As open-goal counts grow, scanning the list to pick the right goal becomes guesswork.

## What Changes

- **Compact human ID**: picker/list rows display a short stable suffix (last segment of the goal ID, e.g. `qi4x4i`) instead of the full `mr62bc2x-qi4x4i` hash. Full ID stays available via `/goal-list` detail and file path.
- **Drop the filename row**: the `activePath` is no longer appended to every picker row. It remains part of the `/goal-list` text view and the focus-confirmation toast.
- **Single status pill**: collapse the duplicated `sisyphus` token. One column: `running`, `paused·agent`, `paused`, `drafting`, with the sisyphus marker folded into a `✊`/`s:` prefix or omitted entirely from the row.
- **Time context on every row**: absolute + relative timestamps derived from `updatedAt` (e.g. `2h ago`) shown on every picker and list row.
- **Objective sanitization**: `displayObjectiveTitle` strips leading code fences / quote markers so a goal whose objective starts with ` ``` ` no longer renders as a broken markdown block.
- **Column headers**: the picker title bar / list preamble labels each column once.
- **Predictable ordering**: rows are ordered (running first, then most-recently-updated) and the count is shown ("Focus open goal · 4 goals").
- **Lock-owner pill**: when a goal is held by another live session, the row shows a `🔒 held by <session-short>` pill instead of burying the owner in a post-selection confirm dialog.

## Capabilities

### New Capabilities
- `goal-focus-picker`: Human-facing contract for surfacing open goals in the `/goal-focus` selector and `/goal-list` text view — ID shape, columns, status pill, timestamps, lock-owner pill, ordering, and objective sanitization.

### Modified Capabilities
<!-- No existing specs in openspec/specs/. This is the first spec-driven change. -->

## Impact

- **Code**:
  - `extensions/goal-pool.ts` — `goalSelectorLabel`, `buildGoalListText` rewritten; new `shortGoalId`, `formatRelativeTime` helpers (likely in `goal-core.ts` next to existing `formatDuration` / `formatTokenValue`).
  - `extensions/goal-core.ts` — `displayObjectiveTitle` sanitization (strip leading fences/quotes); `statusLabel` returns compact pill string.
  - `extensions/goal.ts` — `focusGoalCommand` picker title gains goal count; label-to-id map key shifts from full label string to short-id (must keep the `byLabel` map collision-safe — see design.md).
- **APIs**: None. Pure presentation; `GoalRecord` shape and focus-lock API unchanged.
- **Dependencies**: None new. Uses existing `theme`, `ctx.ui.select`, `GoalRecord.createdAt`/`updatedAt`/`usage`/`activePath`.
- **Tests**: Snapshot/fixture tests for `goalSelectorLabel`, `buildGoalListText`, `displayObjectiveTitle` sanitization, `shortGoalId` collisions, `formatRelativeTime` edge cases.
- **Risk**: Low. Pure UX; no state, lock, or persistence change. One real risk: if the `byLabel` uniqueness guarantee breaks (two goals share a short suffix), selection could map to the wrong goal — design.md addresses with a disambiguation fallback.
