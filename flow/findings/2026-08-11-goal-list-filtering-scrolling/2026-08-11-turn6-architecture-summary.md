# Explore Turn 6 — Architecture Summary + Import Recommendation

> Date: 2026-08-11  
> Phase: synthesis  
> Status: assistant summary of findings

## [assistant]

```
┌─────────────────────────────────────────────────────────────────────┐
│ PI-ARCHON-WORKFLOW FILTERING PATTERN                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Components Used (from @mariozechner/pi-tui):                       │
│  ┌──────────────────────────────────────────┐                       │
│  │ SelectList                               │                       │
│  │   - items: SelectItem[]                  │                       │
│  │   - maxVisible: number (e.g., 15)        │                       │
│  │   - theme: SelectListTheme               │                       │
│  │   - setFilter(filter: string)            │                       │
│  │   - handleInput(keyData: string)         │                       │
│  │   - onSelect / onCancel callbacks        │                       │
│  └──────────────────────────────────────────┘                       │
│                                                                     │
│  Search/Filter Flow:                                                │
│  ┌───────────┐  "/" key  ┌──────────────┐                           │
│  │  Browse   │──────────▶│ Search Mode  │                           │
│  │   Mode    │           │ (Input focus)│                           │
│  │           │◀──────────│              │                           │
│  └───────────┘  ESC      └──────────────┘                           │
│                                                                     │
│       ↑↓ navigate          type → setFilter()                       │
│       Enter → select       Enter → select                           │
│       r → refresh                                                   │
│                                                                     │
│  Key Code Pattern:                                                  │
│  • searchFocused: boolean (tracks mode)                             │
│  • searchInput: Input component                                     │
│  • selectList.setFilter(searchInput.getValue())                     │
│  • Live filtering as you type                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ YOUR GOAL LIST (CURRENT STATE)                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Current Implementation:                                            │
│  • /goal-list → ctx.ui.notify() plain text                          │
│  • buildGoalListText() → multiline string                           │
│  • No filtering, no scrolling                                       │
│  • Shows ALL goals at once                                          │
│                                                                     │
│  Goal Data Shape:                                                   │
│  ┌──────────────────────────────────────┐                           │
│  │ GoalRecord {                         │                           │
│  │   id: string                         │                           │
│  │   objective: string                  │                           │
│  │   status: "active"|"paused"|...      │                           │
│  │   createdAt: string                  │                           │
│  │   updatedAt: string                  │                           │
│  │   usage: { tokensUsed, activeSeconds}│                           │
│  │   activePath?: string                │                           │
│  │ }                                    │                           │
│  └──────────────────────────────────────┘                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### How to Import the Filtering Pattern

**1. Import TUI Components** (already available as `@earendil-works/pi-tui`):

```typescript
import {
  Container,
  Input,
  Key,
  SelectList,
  Text,
  matchesKey,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
```

**2. Transform Goals → SelectItems**:

```typescript
function goalsToSelectItems(
  goals: GoalRecord[],
  focusedGoalId: string | null
): SelectItem[] {
  return goals.map(goal => ({
    value: goal.id,
    label: `[${goal.id.slice(0, 8)}] (${goal.status}) ${goal.objective.split("\n")[0].slice(0, 60)}`,
    description: goal.objective.split("\n")[0],
  }));
}
```

**3. Instantiate SelectList with maxVisible: 10**:

```typescript
const selectList = new SelectList(
  goalsToSelectItems(goals, focusedGoalId),
  10,                    // ← scroll kicks in above 10 items
  getSelectListTheme(),
);
selectList.setFilter("");
```

**4. Wire filter to Input**:

```typescript
searchInput.handleInput(data);
selectList.setFilter(searchInput.getValue());
tui.requestRender();
```

## Status at end of turn 6

Full pattern documented. Dependencies already present. No new packages needed.
