# Explore Turn 4 — SelectList Type Definitions

> Date: 2026-08-11  
> Phase: code-reading  
> Status: reading type defs

## [assistant]

```bash
find ~/.pi/agent/npm/node_modules/@mariozechner -name "*.d.ts" | xargs rg -l "SelectList"
```

Found: `/home/bhd/.pi/agent/npm/node_modules/@mariozechner/.pi-tui-EBpoeX41/dist/components/select-list.d.ts`

Read full file:

```typescript
import { type Component } from "../component.js";
import { type SelectListTheme } from "../themes.js";
export type SelectItem = {
  label: string;
  value: string;
  description?: string;
};
export declare class SelectList implements Component {
  private items;
  private maxVisible;
  private theme;
  private filteredItems;
  private selectedIndex;
  private scrollOffset;
  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme);
  setItems(items: SelectItem[]): void;
  setFilter(filter: string): void;
  getSelectedItem(): SelectItem | undefined;
  handleInput(data: string): boolean;
  render(width: number): string[];
}
```

Key findings:
- `SelectItem = { label: string; value: string; description?: string }`
- `SelectList` built-in: `maxVisible` param controls scrolling cutoff
- `setFilter(filter: string)` — live filtering, fuzzy by label
- `handleInput(data: string): boolean` — handles ↑↓ Enter internally
- `scrollOffset` internal — scroll is built-in, not manual

## Status at end of turn 4

Full SelectList API confirmed. Both filtering AND scrolling are built-in — just pass `maxVisible: 10` and call `setFilter()` on each keystroke.

Next: Turn 5 — Current goal list implementation
