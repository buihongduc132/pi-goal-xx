# References

> Finding: goal-list-filtering-scrolling  
> Date: 2026-08-11

## Source Files Read

| File | Why |
|------|-----|
| `~/.pi/agent/extensions/pi-archon-workflow/tui.ts` | Source of SelectList + filter pattern |
| `~/.pi/agent/npm/node_modules/@mariozechner/.pi-tui-EBpoeX41/dist/components/select-list.d.ts` | SelectList type definitions |
| `extensions/goal.ts` | Current /goal-list implementation |
| `extensions/goal-pool.ts` | buildGoalListText() implementation |
| `extensions/goal-widget.ts` | Existing @earendil-works/pi-tui usage |
| `extensions/widgets/task-list-overlay.ts` | Existing @earendil-works/pi-tui usage |

## Packages

| Package | Role |
|---------|------|
| `@mariozechner/pi-tui` | Upstream TUI primitives (SelectList, Input, Container, Key, Text, matchesKey) |
| `@earendil-works/pi-tui` | Fork used by pi-goal-xx — same API |
| `@mariozechner/pi-coding-agent` | DynamicBorder, getSelectListTheme |
| `@earendil-works/pi-coding-agent` | Fork used by pi-goal-xx — same API |

## Directories Searched

- `~/.pi/agent/extensions/`
- `~/.pi/agent/npm/node_modules/@mariozechner/`
- `~/Documents/Projects/bhd/` (worktree search)
- `~/agent-studio/crates/` (worktree search, no match)
- `extensions/` (pi-goal-xx)
