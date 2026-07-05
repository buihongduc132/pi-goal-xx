## ADDED Requirements

### Requirement: Picker rows display a short human ID
The `/goal-focus` picker and the `/goal-list` text view SHALL render each open goal using a short identifier derived from the suffix of the goal's stable id (the substring after the final `-`), instead of the full id, EXCEPT when two open goals collide on that suffix — in which case both SHALL fall back to their full id so selection remains unambiguous.

#### Scenario: Typical single goal
- **WHEN** the open goals pool contains one goal with id `mr62bc2x-qi4x4i`
- **THEN** the picker row begins with `qi4x4i` (not the full id)

#### Scenario: Suffix collision triggers full-id fallback
- **WHEN** two open goals share the suffix `qi4x4i` (e.g. `mr62bc2x-qi4x4i` and `aa11bb22-qi4x4i`)
- **THEN** both rows display their full id, AND the label-to-id selection map resolves each row to the correct goal

#### Scenario: No collision for similar-but-distinct suffixes
- **WHEN** open goals have suffixes `qi4x4i` and `qi4x4j`
- **THEN** each row displays its own short suffix

### Requirement: Picker rows surface absolute and relative timestamps
Every `/goal-focus` picker row and every `/goal-list` row SHALL display a timestamp derived from the goal's `updatedAt` field, formatted as a short local absolute time (`MM-DD HH:mm`) followed by a relative time (e.g. `2h ago`, `just now`, `3d ago`).

#### Scenario: Recently updated goal
- **WHEN** a goal's `updatedAt` is 30 seconds before render
- **THEN** the row shows `just now` as the relative portion

#### Scenario: Hours-old update
- **WHEN** a goal's `updatedAt` is 2 hours before render
- **THEN** the row shows `2h ago` as the relative portion

#### Scenario: Missing or invalid timestamp
- **WHEN** a goal's `updatedAt` is empty, non-parseable, or in the future
- **THEN** the row shows `—` for the timestamp, and a future timestamp is clamped to `just now`

### Requirement: Single status pill with no duplicated columns
The picker row SHALL present exactly one status segment per goal, using the compact values `running`, `paused·agent`, `paused`, or `drafting`. The sisyphus mode marker SHALL appear at most once per row, as a leading glyph, and MUST NOT be duplicated in the status segment.

#### Scenario: Sisyphus running goal
- **WHEN** a sisyphus goal is active with auto-continue
- **THEN** the row shows the `✊` leading glyph and the status segment `running` (the word `sisyphus` does not appear in the status segment)

#### Scenario: Agent-paused non-sisyphus goal
- **WHEN** a non-sisyphus goal is paused with `stopReason === "agent"`
- **THEN** the status segment is `paused·agent` and no `✊` glyph is shown

### Requirement: Picker rows omit the active file path
The `/goal-focus` picker row SHALL NOT append the goal's `activePath` (the `.pi/goals/active_goal_<timestamp>_<id>.md` filename). The `/goal-list` text view SHALL continue to surface the path on a dedicated sub-line so it remains discoverable.

#### Scenario: Picker row has no filename
- **WHEN** the picker renders a goal whose `activePath` is `.pi/goals/active_goal_2026070414501834_mr62bc2x-qi4x4i.md`
- **THEN** the rendered picker row contains no `.pi/goals/` substring

#### Scenario: List view keeps the path
- **WHEN** `/goal-list` text view renders the same goal
- **THEN** the path appears on its own indented sub-line beneath the goal row

### Requirement: Objective title sanitization strips markdown noise
`displayObjectiveTitle` SHALL strip leading code fences (` ``` `, ` ```` `), blockquote markers (`> `), and surrounding quote characters (`"`, `'`) from the extracted title line before truncation, so a goal whose objective begins with a code fence or quote does not render as a broken markdown block.

#### Scenario: Objective begins with a code fence
- **WHEN** a goal objective's first content line is ` ``` ` followed by prose
- **THEN** the rendered title is the prose line, with no leading fence characters

#### Scenario: Objective begins with a blockquote
- **WHEN** the first content line is `> do the thing`
- **THEN** the rendered title is `do the thing`

### Requirement: Lock-owner pill shown pre-selection
When a goal in the `/goal-focus` picker is held by another live session, the picker row SHALL display a lock pill containing a short form of the holding session's id, so the user sees the contention before selecting. The existing post-selection takeover confirmation flow is unchanged.

#### Scenario: Goal held by another live session
- **WHEN** goal `qi4x4i` is held by live session `ses_abc123` (not the current session)
- **THEN** the picker row appends a `🔒 <session-short>` pill

#### Scenario: Goal held by the current session
- **WHEN** the lock owner is the current session
- **THEN** no lock pill is shown

#### Scenario: Stale lock
- **WHEN** the lock exists but the holding session is dead or the lease has lapsed
- **THEN** no lock pill is shown (the lock is reaped silently on focus)

### Requirement: Deterministic row ordering
The `/goal-focus` picker SHALL order rows deterministically: goals in `running` state (active + auto-continue) first, then all others by `updatedAt` descending. The picker title SHALL include the open-goal count.

#### Scenario: Running goal sorts first
- **WHEN** open goals include one `running` and two `paused` goals
- **THEN** the `running` goal appears as the first row regardless of `updatedAt`

#### Scenario: Non-running goals sort by recency
- **WHEN** two paused goals have `updatedAt` values 1 hour apart
- **THEN** the more recently updated goal appears above the older one

#### Scenario: Title shows count
- **WHEN** 4 open goals exist
- **THEN** the picker title is `Focus open goal · 4 open`
