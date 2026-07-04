## Context

The `/goal-focus` picker is built on a single rendering function — `goalSelectorLabel(goal, focusedGoalId)` in `extensions/goal-pool.ts` — that returns one flat string per goal. That string is consumed in two places:

1. `focusGoalCommand` (goal.ts ~L1803): `ctx.ui.select("Focus open goal", labels)` — the interactive TUI picker.
2. `buildGoalListText` (goal-pool.ts) — the headless/text fallback for `!ctx.hasUI`.

Both currently produce: `"${marker} ${goal.id} | ${statusLabel(goal)} | ${mode} | ${objective}${path}"`.

- `goal.id` is the full `mr62bc2x-qi4x4i` form (UUID-ish, 8-char prefix + 6-char suffix joined by `-`).
- `statusLabel` prepends `sisyphus ` to every status AND there is a separate `mode` column → `sisyphus` appears twice.
- `path` appends `activePath` (the `.pi/goals/active_goal_<ts>_<id>.md` filename) — noise on every row.
- `displayObjectiveTitle` (goal-core.ts) takes the first non-section line of the objective. If that line is a markdown code fence or quote, the rendered picker corrupts.
- `GoalRecord` already carries `createdAt` and `updatedAt` (ISO strings) plus `usage.activeSeconds`/`tokensUsed`, but the picker never uses them.
- The `byLabel` map (goal.ts ~L1804) keys option string → goal id. Any change to label format must preserve uniqueness of that map, or selection resolves to the wrong goal.

Constraints:
- pi's `ctx.ui.select` is a string-array API. We cannot add column-aligned tables; the "columns" are text segments inside each row string. Padding for alignment is best-effort and must tolerate terminal width and emoji width variance (✊, 🔒).
- The focus-lock API (`readLock`, `isLockHeld`, `confirmFocusOverride`) is out of scope for change — only how its result is surfaced.
- Pure-presentation change: no `GoalRecord` schema change, no migration, no file-format change.

## Goals / Non-Goals

**Goals:**
- Every picker/list row surfaces: short ID, status pill, time (absolute + relative), sanitized objective title.
- No duplicated columns; sisyphus marker appears at most once per row.
- Filename (`activePath`) hidden from the dense picker row; still reachable in `/goal-list` and the focus toast.
- Selection correctness preserved even if two goals share a short suffix.
- Lock owner visible pre-selection when a goal is held by another live session.
- Deterministic, defensible ordering: running → most-recently-updated.

**Non-Goals:**
- Replacing `ctx.ui.select` with a richer table widget (out of this extension's control).
- Adding fuzzy search / filter / multi-select to the picker (pi host API doesn't support it).
- Changing `GoalRecord` persistence shape or the focus-lock protocol.
- Changing `statusLabel` consumers that want the verbose form (status widget, completion auditor) — they will be migrated to read the new compact form only where it improves UX.

## Decisions

### D1 — Short ID = last suffix segment, collision-guarded
`shortGoalId(goal.id)` returns the substring after the final `-` (e.g. `mr62bc2x-qi4x4i` → `qi4x4i`). That segment is the human-memorable part.

- **Collision guard**: if two open goals collide on the short suffix, fall back to the full id for both. Computed once per picker render into a `Set<shortId>`; duplicates → emit full id. This keeps the `byLabel` map keyed on the rendered label (which is unique by construction because the full id is unique).
- **Alternatives considered**:
  - First segment (`mr62bc2x`): rejected — random, no better memorability than the suffix.
  - First 4 chars of full id: rejected — higher collision rate, loses the human suffix entirely.
  - Hash-derived ordinal (`#1`,`#2`): rejected — not stable across reloads, conflicts with persistent ordering goal.

### D2 — `byLabel` map keyed on full rendered label
Keep the existing pattern: `new Map(labels.map((l,i) => [l, open[i].id]))`. Because labels embed the (collision-guarded) id, the map is guaranteed unique. Do NOT key on short id alone — that loses uniqueness under D1 fallback.

- **Alternative**: switch to `ctx.ui.select` returning an index instead of a string. Rejected — `ctx.ui.select` returns the selected label string; there is no index-returning variant in scope.

### D3 — Single status pill, sisyphus folded into prefix
Replace `statusLabel` row output with a compact pill: `running`, `paused·agent`, `paused`, `drafting`. Sisyphus mode shown as a leading `✊` glyph on the row (before the short id), not as a separate column and not duplicated in the status string.

- A new `compactStatusLabel(goal)` is added; the legacy `statusLabel` stays for non-picker consumers (status widget, footer) that may still want the verbose form. Migrating them is a follow-up, not part of this change.
- **Alternative**: drop sisyphus marker entirely. Rejected — sisyphus goals have materially different execution semantics (strict ordered steps); the user needs the affordance.
- **Alternative**: spell out `sisyphus` in the status. Rejected — reintroduces the duplication problem.

### D4 — Timestamps: absolute + relative, from `updatedAt`
Add `formatRelativeTime(updatedAt)` (e.g. `2h ago`, `just now`, `3d ago`). Row shows `<absolute short> · <relative>`, e.g. `07-04 14:50 · 2h ago`. Absolute uses local time `MM-DD HH:mm`. Both come from `GoalRecord.updatedAt`.

- Why `updatedAt` not `createdAt`: the picker is about "which goal am I currently working on"; last activity is the signal users scan for.
- Edge: `updatedAt` in the future (clock skew) → clamp relative to "just now".
- Edge: `updatedAt` missing/invalid → show `—`.

### D5 — Drop `activePath` from picker row
`goalSelectorLabel` no longer appends `activePath`. `buildGoalListText` keeps a second line `  <activePath>` (it already does) so the filename is still discoverable in `/goal-list`. The focus-confirmation toast (`oneLineSummary`) keeps mentioning the goal id, not the path.

### D6 — Objective sanitization in `displayObjectiveTitle`
Extend `displayObjectiveTitle` to strip leading ` ``` `, ```` `, `> `, and surrounding `"`/`'` from the chosen title line before truncation. Operates on the already-extracted title line only; does not change objective persistence.

- **Alternative**: sanitize at write time. Rejected — mutates user intent; sanitization is a display concern.

### D7 — Lock-owner pill pre-selection
In `focusGoalCommand`, before building labels, compute `heldByOther(goalId)` for each open goal by calling the existing `readLock` + `isLockHeld` + `lock.owner.sessionId !== SELF_SESSION_ID` check (already used in `confirmFocusOverride`). If held, append `🔒 <session-short>` to the row. `confirmFocusOverride` still runs after selection (no behavior change to the takeover flow) — the pill is purely informational.

- Session-short = last 6 chars of `sessionId`, same collision fallback as D1.

### D8 — Ordering: running first, then `updatedAt` desc
Stable sort: `(status === 'active' && autoContinue ? 0 : 1)` then `-updatedAt`. Done at render time only; does not change `openGoals()` order elsewhere.

### D9 — Column header via picker title, not row
`ctx.ui.select` only takes a title + flat options. The title becomes `"Focus open goal · 4 open"` and the column meaning is conveyed by consistent row layout + a one-line legend in `buildGoalListText` preamble (text view only). No fake header row in the interactive picker (would be selectable noise).

## Risks / Trade-offs

- **[Short-ID collision → wrong goal selected]** → D1 fallback to full id on collision; `byLabel` keyed on full rendered label (D2). Test: two goals sharing suffix.
- **[Glyph width variance breaks alignment]** ✊ / 🔒 are double-width on some terminals → columns drift. Mitigation: do not pad columns to fixed widths; use ` · ` separators that tolerate drift. Acceptable trade-off vs. the duplication noise today.
- **[Status pill rename confuses existing users]** `paused (agent)` → `paused·agent`. Minor. Documented in change; the verbose form stays in the footer widget.
- **[`updatedAt` stale or future]** → D4 clamps; shows `—` / `just now`. Low risk.
- **[Lock pill adds a network/disk read per row]** `readLock` is a local file read already used in hot paths. N is small (open goals, typically <10). Negligible.
- **[Headless text view diverges from picker]** Both call the same label builder; `buildGoalListText` adds the filename sub-line and a legend. Kept in sync by sharing the core formatter.
