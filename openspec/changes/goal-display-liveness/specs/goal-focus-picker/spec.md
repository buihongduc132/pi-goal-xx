## MODIFIED Requirements

### Requirement: Single status pill with no duplicated columns
The picker row SHALL present exactly one status segment per goal. The status segment SHALL be derived from the goal's on-disk fields (`status`, `autoContinue`, `stopReason`) AND the goal's focus-lock liveness signal. The compact values SHALL be: `running` (active + autoContinue + a live lock holder exists), `stale` (active + autoContinue but NO live lock holder), `paused·agent` (paused + stopReason agent), `paused` (paused), or `drafting` (active + autoContinue false / drafting). The sisyphus mode marker SHALL appear at most once per row, as a leading glyph, and MUST NOT be duplicated in the status segment.

A "live lock holder" means a lock file exists at `<cwd>/.pi/goals/.locks/<goalId>.lock` AND `isLockHeld` returns true (owning PID alive AND lease not lapsed). The holder MAY be the current session (self) or another session — both count as live. When the liveness signal cannot be determined (`cwd` unavailable, `.locks/` directory absent, or `readLock` returns an error), the legacy `running` display SHALL be used as a fallback (do not display `stale` when liveness is unknown).

#### Scenario: Sisyphus running goal with live lock
- **WHEN** a sisyphus goal is active with auto-continue and a live focus lock exists (held by self or another session)
- **THEN** the row shows the `✊` leading glyph and the status segment `running` (the word `sisyphus` does not appear in the status segment)

#### Scenario: Active goal whose session has died — stale
- **WHEN** a goal has on-disk `status: active` and `autoContinue: true`, but the lock file's owning PID is dead (ESRCH) or the lease has lapsed (`now >= expiresAt`), or no lock file exists and the `.locks/` directory IS present
- **THEN** the status segment is `stale` (not `running`) — the user is not misled into thinking live work is in progress

#### Scenario: Active goal with no locking infrastructure — legacy fallback
- **WHEN** a goal has on-disk `status: active` and `autoContinue: true`, no lock file exists, AND the `.locks/` directory does not exist (locking was never used in this cwd)
- **THEN** the status segment is `running` (legacy fallback — liveness is unknown, not confirmed-dead)

#### Scenario: ReadLock fails with fs error — legacy fallback
- **WHEN** `readLock` returns an error status (EACCES, disk error, corrupt JSON that failed parsing) for a goal that has on-disk `status: active` and `autoContinue: true`
- **THEN** the status segment is `running` (legacy fallback — an unreadable lock does not imply the holder is dead)

#### Scenario: Agent-paused non-sisyphus goal
- **WHEN** a non-sisyphus goal is paused with `stopReason === "agent"`
- **THEN** the status segment is `paused·agent` and no `✊` glyph is shown (lock liveness is irrelevant for paused goals — their status comes from the disk file)

#### Scenario: Paused goal ignores lock state
- **WHEN** a goal has `status: paused` and its lock is stale or absent
- **THEN** the status segment is `paused` (or `paused·agent` if stopReason matches) — paused goals never show `stale`, because pause is an intentional on-disk state, not a liveness claim

### Requirement: Deterministic row ordering
The `/goal-focus` picker SHALL order rows deterministically: goals in `running` state (active + autoContinue + live lock holder) first, then all others (`stale`, `paused`, `paused·agent`, `drafting`) by `updatedAt` descending. The picker title SHALL include the open-goal count.

#### Scenario: Running goal sorts first
- **WHEN** open goals include one `running` (live lock held) and two `paused` goals
- **THEN** the `running` goal appears as the first row regardless of `updatedAt`

#### Scenario: Stale goal does NOT sort first
- **WHEN** open goals include one `stale` goal (active + autoContinue but no live lock) and one `running` goal
- **THEN** the `running` goal appears first; the `stale` goal sorts by `updatedAt` alongside other non-running goals

#### Scenario: Non-running goals sort by recency
- **WHEN** two non-running goals (paused or stale) have `updatedAt` values 1 hour apart
- **THEN** the more recently updated goal appears above the older one

#### Scenario: Title shows count
- **WHEN** 4 open goals exist
- **THEN** the picker title is `Focus open goal · 4 open`

## ADDED Requirements

### Requirement: Liveness signal computed for display
The picker, `/goal-list` builder, footer status refresh, and above-editor widget SHALL compute a per-goal liveness signal by reading the focus lock (`readLockDetailed(cwd, goalId)`) and evaluating `isLockHeld(lock)` for every open goal with on-disk `status: active` and `autoContinue: true`. The signal is tri-state: `true` (live lock holder exists — self or other), `false` (lock file missing with `.locks/` dir present, OR lock exists but is stale), or `undefined` (cannot determine — `cwd` null, `.locks/` dir absent, or `readLockDetailed` returned error). The signal SHALL be passed to all display functions via an optional parameter; `undefined` preserves the legacy `running` display. This computation is pure-read (no reap, no release, no write).

#### Scenario: Self-held live lock
- **WHEN** the current session holds a live lock on goal A (own PID alive, lease fresh)
- **THEN** the liveness signal for A is `true` and A displays `running` in picker, footer, and widget

#### Scenario: Other-session live lock
- **WHEN** another live session holds the lock on goal B
- **THEN** the liveness signal for B is `true` and B displays `running` (with the `🔒 <session>` pill in the picker, per existing behavior)

#### Scenario: Dead session — stale lock
- **WHEN** goal C's lock file exists but the owning PID is dead or the lease has lapsed
- **THEN** the liveness signal for C is `false` and C displays `stale` in picker, footer, and widget

#### Scenario: Dead session — lock reaped, dir present
- **WHEN** goal D has no lock file (reaped after lapse) but the `.locks/` directory exists
- **THEN** the liveness signal for D is `false` and D displays `stale`

#### Scenario: No locking infrastructure
- **WHEN** the `.locks/` directory does not exist in the cwd
- **THEN** the liveness signal is `undefined` for all active goals and they display `running` (legacy fallback)

#### Scenario: Read error — cannot determine
- **WHEN** `readLockDetailed` returns `{ status: "error" }` (EACCES, disk error)
- **THEN** the liveness signal is `undefined` and the goal displays `running` (legacy fallback — do not false-positive stale on an unreadable lock)

### Requirement: readLock discriminates missing from error
The `readLock` function (renamed `readLockDetailed` or augmented with a detailed variant) SHALL return a discriminated union distinguishing: (a) `{ status: "found", lock: GoalFocusLock }` — file exists and parsed successfully, (b) `{ status: "missing" }` — file does not exist (ENOENT), (c) `{ status: "error" }` — file exists but could not be read or parsed (EACCES, corrupt JSON, disk error). The liveness signal computation uses this distinction: "missing" + `.locks/` dir present → liveness `false` (stale); "error" → liveness `undefined` (legacy fallback). A legacy `readLock(cwd, goalId): GoalFocusLock | null` wrapper SHALL be retained for existing callers that treat null uniformly (mapped: found→lock, missing+error→null).

#### Scenario: Lock file exists and parses
- **WHEN** the lock file at `.locks/<goalId>.lock` contains valid JSON matching the lock shape
- **THEN** `readLockDetailed` returns `{ status: "found", lock }`

#### Scenario: Lock file does not exist
- **WHEN** no lock file exists at `.locks/<goalId>.lock` (ENOENT)
- **THEN** `readLockDetailed` returns `{ status: "missing" }`

#### Scenario: Lock file exists but is corrupt
- **WHEN** the lock file exists but contains invalid JSON or does not match the lock shape
- **THEN** `readLockDetailed` returns `{ status: "error" }` (NOT "missing" — the file is there but broken; a broken lock may indicate an active session that wrote a partial file)

#### Scenario: Lock file exists but permission denied
- **WHEN** the lock file exists but `readFileSync` throws EACCES
- **THEN** `readLockDetailed` returns `{ status: "error" }` (cannot determine liveness — do not false-positive stale)

### Requirement: Footer status bar reflects liveness
The footer status bar (refreshed via `statusRefreshTimer` at 1s interval) SHALL display `stale` instead of `running` when the currently-focused goal has on-disk `status: active && autoContinue` but the current session does not hold a live lock for it. The `statusLabel` and `footerStatus` functions SHALL accept an optional `liveLockHolder?: boolean | undefined` parameter, mirroring `compactStatusLabel`. When the session holds its own lock (the common case), `running` is displayed unchanged.

#### Scenario: Session holds its own lock — running
- **WHEN** the current session is focused on an active goal and holds a live lock (heartbeat fresh)
- **THEN** the footer shows `running`

#### Scenario: Session lost its lock — stale
- **WHEN** the current session is focused on an active goal but does NOT hold a live lock (lease lapsed and stolen, or lock file missing/corrupt)
- **THEN** the footer shows `stale`

#### Scenario: Liveness unknown — legacy fallback
- **WHEN** the `.locks/` directory does not exist or `readLock` returned an error
- **THEN** the footer shows `running` (legacy fallback)

### Requirement: Above-editor widget reflects liveness
The goal widget (`displayIcon` in `goal-widget.ts`) SHALL display a stale indicator when the focused goal has on-disk `status: active && autoContinue` but no live lock holder. The stale indicator SHALL be a muted `⌽` icon with label `stale`, replacing the running `●` accent icon with label `goal running`. The widget constructor/getters SHALL receive the liveness signal from the hosting session.

#### Scenario: Running goal with live lock
- **WHEN** the focused goal is active with auto-continue and a live lock is held
- **THEN** the widget shows `●` accent icon with label `goal running` (or `◆`/`sisyphus running` for sisyphus)

#### Scenario: Stale goal — no live lock
- **WHEN** the focused goal is active with auto-continue but no live lock holder exists
- **THEN** the widget shows `⌽` muted icon with label `stale`

#### Scenario: Paused goal — unchanged
- **WHEN** the focused goal is paused
- **THEN** the widget shows the existing paused/blocked icon (liveness is irrelevant for paused goals)
