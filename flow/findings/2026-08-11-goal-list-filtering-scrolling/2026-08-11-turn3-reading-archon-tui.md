# Explore Turn 3 — Reading pi-archon-workflow TUI Implementation

> Date: 2026-08-11  
> Phase: code-reading  
> Status: extracting pattern

## [assistant]

Read `/home/bhd/.pi/agent/extensions/pi-archon-workflow/tui.ts` (full file, 730 lines).

Key imports identified:

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@mariozechner/pi-tui";
```

Searched for SelectList instantiation pattern:

```bash
rg -A 5 "SelectList" ~/.pi/agent/extensions/pi-archon-workflow/tui.ts | head -40
```

Found:

```typescript
const selectList = new SelectList(
  items,
  Math.min(items.length, 15),
  getSelectListTheme(),
);
selectList.setFilter("");
```

Searched for filter application:

```bash
rg -B 3 -A 10 "searchInput.handleInput|setFilter" ~/.pi/agent/extensions/pi-archon-workflow/tui.ts | head -50
```

Found filtering flow:

```typescript
if (searchFocused) {
  if (matchesKey(data, Key.enter)) {
    const selected = selectList.getSelectedItem();
    if (selected) doneCb(selected.value);
    else focusSearch(false);
    return;
  }
  searchInput.handleInput(data);
  selectList.setFilter(searchInput.getValue());
  tui.requestRender();
  return;
}
```

## Status at end of turn 3

Extracted SelectList usage pattern from pi-archon-workflow. Key discovery: `SelectList` from `@mariozechner/pi-tui` has built-in filtering via `setFilter()`.

Next: Turn 4 — Reading SelectList TypeScript definitions
