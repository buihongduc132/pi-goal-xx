# Finding: Goal List Filtering + Scrolling

> Date: 2026-08-11  
> Topic: How to add filtering + scrolling to /goal-list using pi-tui  
> Status: explore-complete (no implementation)

## Dir Listing

| File | Threads | Decided | Remain |
|------|---------|---------|--------|
| turn1-user-request.md | 1 | 0 | 1 |
| turn2-investigation.md | 1 | 1 | 0 |
| turn3-reading-archon-tui.md | 1 | 1 | 0 |
| turn4-selectlist-types.md | 1 | 1 | 0 |
| turn5-current-goal-list.md | 1 | 1 | 0 |
| turn6-architecture-summary.md | 2 | 1 | 1 |
| turn7-reuse-options.md | 3 | 1 | 2 |
| references.md | — | — | — |

Totals: Threads 10 · Decided 6 · Remain 3

## Blockers (must decide before implementation)

| # | Question | Options |
|---|----------|---------|
| B1 | Where does the helper live? | Option 1 (local `extensions/tui-helpers.ts`) vs Option 2 (new `pi-tui-helpers` package) vs Option 3 (upstream) |
| B2 | Start with `/goal-list` interactive or new `/goal-select` command? | Replace existing or add new command |

## Deferrals (ships despite open)

| # | Item | Why deferred |
|---|------|-------------|
| D1 | Refactor pi-archon-workflow to consume shared helper | Downstream of B1; not needed for goal-list feature |
| D2 | Section headers in overlay (group by status) | Nice-to-have; SelectList supports it but adds complexity |
| D3 | `onRefresh` callback (live reload goals) | Optional; start without it |
