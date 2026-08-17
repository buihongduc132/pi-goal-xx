# Plan — Cross-project Goals dashboard (running / paused / completed)

> Date: 2026-07-08
> Status: draft (proposal — least-resistance path)
> Deliverable: a **new, standalone project** (working name `goal-dashboard`)
> Reuses: *patterns* from `../openspec-dashboard` (not its codebase or DB)
> Data source: any repo with `<root>/.pi/goals/`

## Direction (user, verbatim)

> Check the ../openspec-dashboard (check it flow/plans / intentions) and also the current project ; How to implement a neatest / simplest dashboard for like managing and visualizing the goals running / pause / completed in different project ?
>
> Choose least resistance path , put the plan into flow/plans/ for me ;

> No , goal-xx will be completely separate project , we can reuse pattern from openspec dashboard but these are not same one;

## Goal

One place to see every pi goal across every project, grouped by lifecycle
state (**running / paused / completed**), with enough per-goal detail to know
what it is, how far it got, and when it last moved. Read-only first.

## Decision: standalone app, borrow patterns from openspec-dashboard

The dashboard is a **reference, not a base**. We copy the shapes that work and
leave the weight behind:

**Borrow (patterns):**
- Next.js App Router structure, server components reading the filesystem
  server-side (openspec-dashboard `src/lib/filesystem-projection/`).
- The list/board/badge/card UI conventions and nav shell.
- The "copy reference" idea — a goal card can be handed to an agent as text.

**Leave behind (weight we don't need):**
- **Postgres + Drizzle.** openspec-dashboard persists OpenSpec entities to a DB
  and syncs; goals are fast-moving runtime state (token counts + task progress
  flip every turn). Persisting them = migrations + a sync loop + staleness for
  zero gain. We read the filesystem live instead.
- Its `projects` table (see registry replacement below).

### The one thing we must replace: the project registry

openspec-dashboard knew "which projects exist" from its `projects` table
(`rootPath` column). A standalone app has no such DB. Replace it with the
lightest possible thing — a **config file** listing project roots:

```jsonc
// goal-dashboard.config.json  (or GOAL_DASHBOARD_ROOTS env)
{
  "projects": [
    { "name": "pi-goal-xx", "root": "/home/bhd/Documents/Projects/bhd/pi-goal-xx" },
    { "name": "openspec-dashboard", "root": "/home/bhd/Documents/Projects/bhd/openspec-dashboard" }
  ],
  // optional convenience: auto-discover instead of / in addition to the list
  "autoDiscoverGlob": "/home/bhd/Documents/Projects/**/.pi/goals"
}
```

v1: explicit list (simplest, deterministic). `autoDiscoverGlob` is a nice-to-have
that walks for `.pi/goals` dirs so new projects show up without editing config.

### Key simplifying choice: live filesystem read, NO database

Scan `.pi/goals/` on each request, server-side. Always fresh, zero schema,
trivially deletable. Add caching/DB later only if scan latency ever bites (it
won't at this scale — a handful of small JSON files per project).

## Data model (source of truth on disk)

Per project, at `<root>/.pi/goals/`:

| File | Meaning |
| --- | --- |
| `active_goal_<ts>_<id>.md` | Live goal. JSON header, then `# Goal Prompt` body. |
| `archived/goal_<ts>_<id>.md` | Stopped/finished goal. Same JSON header + `stopReason`, `archivedPath`. |
| `goal_events.jsonl` | Append-only event stream (see below). |
| `.locks/` | Focus-lock files (ignore for v1). |

JSON header fields we consume (verified against real files in `pi-goal-xx`):

```
version, id, objective (title text), status, autoContinue, sisyphus,
usage { tokensUsed, activeSeconds },
createdAt, updatedAt, stopReason?, activePath|archivedPath,
taskList { tasks: [ { id, title, status, completedAt?, evidence?, verificationContract? } ] }
```

**Status is the JSON `status` field, not the directory.** Values:
`active` → **running**, `paused` → **paused**, `complete` → **completed**.
A paused goal can live in `archived/` (with `stopReason`), so never infer state
from the folder — always read `status`.

`goal_events.jsonl` event `type`s seen: `goal_created`, `task_complete`,
`completion_requested`, `audit_started`, `audit_result` (`{ verdict }`).
Fold these for: last-activity timestamp and latest audit verdict
(approved / disapproved) shown as a badge on completed goals.

## Architecture

```
goal-dashboard/                        (new standalone repo/dir)
  goal-dashboard.config.json           project roots (registry replacement)
  src/lib/goals/{types,parse,scan}.ts  pure, testable core
  src/lib/registry.ts                  read config → resolved project roots
  src/app/api/goals/route.ts           GET → scan all roots, aggregate
  src/app/page.tsx                     the board (server component)
  src/components/goals/*               card / column / filter bar

GET /api/goals  (read-only)
  └─ registry() → project roots
  └─ for each root: scanGoals(root)
       ├─ read active_goal_*.md   → parseGoalFile()
       ├─ read archived/*.md      → parseGoalFile()
       ├─ fold goal_events.jsonl  → latest audit verdict + last event ts
       └─ dedupe by id (active wins) → GoalSummary[]
  └─ { goals, scannedAt, projectErrors[] }

/  (board)
  └─ 3 columns: Running | Paused | Completed
       card: project · objective(1st line) · task progress · tokens · updatedAt · audit badge
  └─ filter chips: by project, by sisyphus, search
```

## Phases

### Phase 0 — Scaffold the standalone project
- `npx create-next-app` (App Router, TS, Tailwind) in a new sibling dir.
- Copy the minimal UI primitives (card/badge/button) and nav shell conventions
  from openspec-dashboard — files, not a dependency. No Drizzle, no Postgres.
- Add `goal-dashboard.config.json` + `src/lib/registry.ts`.

**Exit:** `npm run dev` serves an empty shell; `registry()` returns configured roots.

### Phase 1 — Parser + scanner (headless, TDD)
**Files:** `src/lib/goals/{types,parse,scan}.ts` + tests + fixtures.
- `parseGoalFile(raw)` → `GoalSummary` (split JSON header from body at
  `# Goal Prompt`; tolerate legacy `currentStatus`; never throw — bad file →
  `{ error }` entry).
- `foldEvents(jsonl, byId)` → attach `lastEventAt`, `auditVerdict`.
- `scanGoals(root, fs)` → dedupe active vs archived by `id` (active wins).
- Fixtures: copy 2–3 real files from `pi-goal-xx/.pi/goals/` (1 active,
  1 archived-complete, 1 paused).

**Exit:** unit tests green; a mangled file yields an error entry, not a crash.

### Phase 2 — Aggregation API
**Files:** `src/app/api/goals/route.ts` + test.
- Iterate registry roots; missing/unreadable `.pi/goals/` → skip into
  `projectErrors[]`, never 500 the whole response.
- Response: `{ goals: GoalSummary[], scannedAt, projectErrors }`.

**Exit:** `/api/goals` returns real goals from ≥2 roots.

### Phase 3 — Board UI
**Files:** `src/app/page.tsx`, `src/components/goals/*`.
- Server component fetches the aggregation; render 3 status columns.
- Card: project name, objective first line, `done/total` task pill,
  `tokensUsed`, relative `updatedAt`, audit verdict badge on completed.
- Client filter bar: project multiselect + sisyphus toggle + text search.
- Optional: copy-reference control so a card can be handed to an agent.

**Exit:** the board shows goals from ≥2 projects in the right columns.

### Phase 4 (optional, later)
- Auto-refresh (poll `/api/goals` every N s) for a live wall-board.
- Goal detail drawer: full objective, task list, event timeline, trace link.
- `autoDiscoverGlob` support in the registry.
- Only if latency bites: cache scans / add a DB.

## Why this is the least-resistance path (for a separate project)
- **Reuses proven patterns**, skips the parts we don't need (DB/ORM/sync).
- **No database** — live read off configured roots; zero migration, always fresh.
- **No changes to `pi-goal-xx`** or any scanned repo — the dashboard is a pure
  reader; producers keep writing `.pi/goals/` unchanged. Fully decoupled.
- The only real design decision — the registry — is solved by a one-file config,
  not infrastructure.

## Open questions
1. Where does the new project live / what's its name? (`../goal-dashboard`?)
2. Registry: explicit config list only for v1, or ship `autoDiscoverGlob` too?
   (Recommend: explicit list v1, glob as a fast follow.)
3. Observe-only forever, or eventually add pause/resume/complete actions from
   the board? (v1 = observe-only.)
4. Should this plan doc also live in the new repo once scaffolded? (Currently in
   `pi-goal-xx/flow/plans/`.)
