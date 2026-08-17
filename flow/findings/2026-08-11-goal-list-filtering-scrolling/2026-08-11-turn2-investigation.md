# Explore Turn 2 — Investigation and Discovery

> Date: 2026-08-11  
> Phase: codebase-investigation  
> Status: searching for pi-worktree

## [assistant]

Attempted to locate `../pi-worktree`:

```bash
cd ../pi-worktree && find . -type f -name "*.ts" -o -name "*.tsx" | grep -E "(filter|select|list)" | head -20
```

Result: Directory not found (`/bin/bash: line 1: cd: ../pi-worktree: No such file or directory`)

Searched for worktree-related directories:

```bash
fd -t d "worktree" ~ --max-depth 3 2>/dev/null | head -10
```

Found:
- `/home/bhd/agent-studio/crates/git-worktree-manager/`

```bash
fd -g "*worktree*" ~/Documents/Projects --type d --max-depth 3 | head -10
```

Found:
- `/home/bhd/Documents/Projects/bhd/loopa/worktrees/`
- `/home/bhd/Documents/Projects/bhd/noco-mesh-infra.worktrees/`

No `pi-worktree` directory found. Shifted strategy to search for existing TUI filtering patterns in pi extensions.

Searched pi extensions for SelectList usage:

```bash
rg -l "SelectList|worktree.*filter" ~/.pi/agent --type ts --max-count 5
```

Found: `/home/bhd/.pi/agent/extensions/pi-archon-workflow/tui.ts`

## Status at end of turn 2

`pi-worktree` not found; discovered `pi-archon-workflow` uses SelectList for filtering/scrolling.

Next: Turn 3 — Reading pi-archon-workflow pattern
