# Explore Turn 5 — Current Goal List Implementation

> Date: 2026-08-11  
> Phase: code-reading  
> Status: reading goal.ts + goal-pool.ts

## [assistant]

```bash
find extensions -name "*.ts" -o -name "*.tsx" | xargs rg -l "goal.*list|list.*goal"
```

Found: `extensions/goal.ts`, `extensions/goal-pool.ts`

```bash
rg -l "\/goal-list|\/goals-list|registerCommand.*goal.*list" extensions --type ts
```

Found: `extensions/goal.ts`

```bash
rg -B 5 -A 20 "registerCommand.*goal-list" extensions/goal.ts
```

Found:

```typescript
pi.registerCommand({
  name: "goal-list",
  description: "List all goals",
  async execute(ctx) {
    const text = await buildGoalListText(ctx);
    ctx.ui.notify({ title: "Goals", message: text, duration: 10000 });
  },
});
```

```bash
rg -A 50 "export function buildGoalListText" extensions/goal-pool.ts
```

Found (abbreviated, key structure):

```typescript
export async function buildGoalListText(ctx: ExtensionCommandContext): Promise<string> {
  const goals = await loadAllGoals(ctx);
  if (goals.length === 0) return "No goals found.";

  const lines: string[] = [];
  for (const goal of goals) {
    const shortId = goal.id.slice(0, 8);
    const status = goal.status;
    const preview = goal.objective.split("\n")[0].slice(0, 60);
    lines.push(`[${shortId}] (${status}) ${preview}`);
  }
  return lines.join("\n");
}
```

## Key observations

```
Current goal-list:
  ctx.ui.notify()          ← static text popup, no interaction
  buildGoalListText()      ← plain string, no SelectItem[]
  No filtering             ← no search/filter
  No scrolling             ← dumps all goals as text
  No selection             ← can't click to open a goal

Current dependencies in extensions/:
  @earendil-works/pi-tui   ← fork of @mariozechner/pi-tui (same API)
  @earendil-works/pi-coding-agent ← fork (same DynamicBorder, getSelectListTheme)
```

```bash
rg "from.*pi-tui|from.*pi-coding-agent" extensions --type ts -o
```

Found:
```
extensions/goal-widget.ts:from "@earendil-works/pi-tui"
extensions/goal-widget.ts:from "@earendil-works/pi-coding-agent"
extensions/widgets/task-list-overlay.ts:from "@earendil-works/pi-tui"
extensions/widgets/task-list-overlay.ts:from "@earendil-works/pi-coding-agent"
```

```bash
ls -la extensions/lib/ 2>/dev/null || echo "No lib/ directory yet"
```

Result: `No lib/ directory yet`

## Status at end of turn 5

Gap confirmed: `/goal-list` uses `ctx.ui.notify()` plain text. No interactive TUI. The `@earendil-works/pi-tui` fork is already used in `goal-widget.ts` and `task-list-overlay.ts` — same API as `@mariozechner/pi-tui`. No `extensions/lib/` directory yet.

Next: Turn 6 — Architecture summary diagram + import recommendation
