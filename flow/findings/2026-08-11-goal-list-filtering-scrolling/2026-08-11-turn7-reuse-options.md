# Explore Turn 7 — "Why Don't We Reuse That Lib?"

> Date: 2026-08-11  
> Phase: synthesis  
> Status: user question + assistant response on reuse options

## [user]

> Why don't we reuse that lib?

## [assistant]

```
┌─────────────────────────────────────────────────────────────────────┐
│ WHAT'S ALREADY SHARED                                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Both pi-archon-workflow AND pi-goal-xx already depend on:          │
│                                                                     │
│  @mariozechner/pi-tui                                               │
│  ├── SelectList   ← filtering + scrolling                           │
│  ├── Input        ← search box                                      │
│  ├── Container    ← layout                                          │
│  ├── Text         ← labels                                          │
│  ├── Key          ← key constants                                   │
│  └── matchesKey   ← input matching                                  │
│                                                                     │
│  @mariozechner/pi-coding-agent                                      │
│  ├── DynamicBorder        ← box drawing                             │
│  └── getSelectListTheme   ← consistent styling                      │
│                                                                     │
│  These are ALREADY your dependencies!                               │
│  No new packages needed.                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ EXTRACTION OPPORTUNITY                                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Pattern in pi-archon-workflow that could be extracted:             │
│                                                                     │
│  searchableSelectListOverlay(                                       │
│    items: SelectItem[],                                             │
│    opts: {                                                          │
│      title: string,                                                 │
│      maxVisible?: number,                                           │
│      hint?: string,                                                 │
│      onRefresh?: () => Promise<SelectItem[]>,                       │
│      sections?: { title: string, items: SelectItem[] }[]            │
│    }                                                                │
│  ): Promise<string | null>                                          │
│                                                                     │
│  Encapsulates:                                                      │
│  ✓ Container + borders                                              │
│  ✓ Search input with / toggle                                       │
│  ✓ SelectList with filtering                                        │
│  ✓ ESC two-stage (exit search → close)                              │
│  ✓ Optional section headers                                         │
│  ✓ Optional refresh key (r)                                         │
│                                                                     │
│  Where to put it?                                                   │
│  ──────────────────────────────────────────────────────────         │
│                                                                     │
│  Option A: Extract to pi-tui-helpers (NEW shared package)           │
│  ├── searchable-select-list.ts                                      │
│  └── consumed by pi-archon-workflow + pi-goal-xx                    │
│                                                                     │
│  Option B: Extract to pi-coding-agent itself                        │
│  └── it already has DynamicBorder + getSelectListTheme              │
│                                                                     │
│  Option C: Keep inline but factor out common overlay builder        │
│  ├── extensions/lib/tui-helpers.ts (in pi-goal-xx)                  │
│  └── import from ./lib/tui-helpers                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Current dependency check

```bash
rg "from.*pi-tui|from.*pi-coding-agent" extensions --type ts -o
```

Output:
```
extensions/goal-widget.ts:from "@earendil-works/pi-tui"
extensions/goal-widget.ts:from "@earendil-works/pi-coding-agent"
extensions/widgets/task-list-overlay.ts:from "@earendil-works/pi-tui"
extensions/widgets/task-list-overlay.ts:from "@earendil-works/pi-coding-agent"
```

```bash
ls -la extensions/lib/ 2>/dev/null || echo "No lib/ directory yet"
```

Output: `No lib/ directory yet`

### Three Options

**Option 1: Local Helper (Fastest — Start Here)**

Create `extensions/tui-helpers.ts` in pi-goal-xx right now:

```
pi-goal-xx/
├── extensions/
│   ├── tui-helpers.ts         ← NEW: searchableSelectList()
│   ├── goal.ts                ← import from ./tui-helpers
│   └── widgets/
│       ├── goal-widget.ts     ← could also use it
│       └── task-list-overlay.ts ← could also use it
```

Pros: Start using it TODAY in `/goal-list`. Zero package management. Iterate fast in one place.  
Cons: Not shared with pi-archon-workflow yet. Duplicates if another extension needs it.

---

**Option 2: Extract to Shared Package (Best Long-term)**

Create `pi-tui-helpers` package alongside other packages:

```
~/Documents/Projects/bhd/
├── pi-goal-xx/
│   └── extensions/goal.ts      ← import from "pi-tui-helpers"
├── pi-tui-helpers/              ← NEW shared package
│   ├── package.json
│   └── src/
│       └── searchable-select-list.ts
└── pi-plugins/
    └── profile/git/github.com/buihongduc132/
        └── pi-archon-workflow/
            └── tui.ts          ← refactor to use pi-tui-helpers
```

Pros: Single source of truth. Both extensions benefit. Can version independently.  
Cons: Setup overhead (new package, publish to npm or git-source). Two-repo dance when iterating.

---

**Option 3: Contribute to Upstream**

Add `searchableSelectList()` to `@earendil-works/pi-coding-agent` itself (it already has `DynamicBorder` + `getSelectListTheme`).

Pros: Everyone benefits. Lives with the theme helpers.  
Cons: Slower — need upstream PR + release cycle. Might not fit upstream's scope.

---

### Recommendation

```
┌─────────────────────────────────────────────────────────────┐
│ START: Option 1 (Local Helper)                              │
│ ──────────────────────────────────────────────────────────  │
│ 1. Create extensions/tui-helpers.ts in pi-goal-xx           │
│ 2. Extract the overlay pattern from pi-archon-workflow      │
│ 3. Wire into /goal-list                                     │
│                                                             │
│ THEN: Option 2 (Shared Package) when stable                 │
│ ──────────────────────────────────────────────────────────  │
│ 4. Extract tui-helpers.ts → pi-tui-helpers package          │
│ 5. Refactor pi-archon-workflow to import from it            │
│ 6. Both extensions converge on one source of truth          │
└─────────────────────────────────────────────────────────────┘
```

## Status at end of turn 7

Three options identified. Recommendation: Option 1 first (local helper, zero friction), then Option 2 (shared package) once stable. Explore mode session ends here.
