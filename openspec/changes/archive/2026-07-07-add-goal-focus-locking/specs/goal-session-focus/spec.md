## ADDED Requirements

### Requirement: Auto-focus restricted to session resume by default
The `resolveSessionFocus` auto-focus branch (auto-focus the only open goal when no explicit focus entry exists) SHALL fire only when ALL of: (a) the triggering `loadState` call was passed a resume-like reason, AND (b) the open-goal pool contains exactly one open goal, AND (c) that one goal is not locked by another live session. The auto-focus condition remains `open.length === 1` over the **full pool**, then additionally gated by the lock check on that single candidate. This preserves the existing `=== 1` semantics exactly (no new auto-focus when the pool has multiple open goals, even if some are locked).

**Reason routing** — `loadState` MUST accept an `autoFocusReason` argument threaded from each caller:
- `session_start` handler passes `event.reason` directly (the full enum).
- `session_tree` and any other non-`session_start` caller passes `null` (no auto-focus — tree navigation must not steal a goal).

**Resume-like reasons** (LD3 "Default: 'resume' only" — honored VERBATIM): `"resume"` only. `"reload"` is NOT resume-like under the default (LD3 is locked at literal "resume only"; `reload` excluded to avoid silently extending a locked decision). `"new"`, `"startup"`, and `"fork"` are NOT resume-like. `null` (from non-session_start callers like `session_tree`) is NOT resume-like. `PI_GOAL_AUTO_FOCUS=all` opts into legacy behavior on any reason (including `reload`).

#### Scenario: Resume session auto-focuses the only open unlocked goal
- **WHEN** a session starts with `reason === "resume"` and exactly one open goal exists in the pool (not locked by another session) and no explicit focus entry is in the session branch
- **THEN** that goal is focused

#### Scenario: Reload session does NOT auto-focus (LD3 literal)
- **WHEN** a session starts with `reason === "reload"` and exactly one open goal exists (unlocked)
- **THEN** the session starts unfocused (LD3 "resume only" honored verbatim; user may `/goal-focus` or set `PI_GOAL_AUTO_FOCUS=all`)

#### Scenario: New / startup / fork session does not auto-focus
- **WHEN** a session starts with `reason` in `{"new", "startup", "fork"}` and exactly one open goal exists in the pool
- **THEN** the session starts unfocused

#### Scenario: Tree navigation does not auto-focus
- **WHEN** the `session_tree` handler calls `loadState` (no resume reason available)
- **THEN** no auto-focus fires regardless of pool size — tree navigation must not steal a goal

### Requirement: PI_GOAL_AUTO_FOCUS env flag
The system SHALL read the `PI_GOAL_AUTO_FOCUS` environment variable to control auto-focus behavior:
- `PI_GOAL_AUTO_FOCUS=resume` (default) — auto-focus only on `reason === "resume"`.
- `PI_GOAL_AUTO_FOCUS=all` — auto-focus on any session start reason (legacy behavior).

#### Scenario: Default behavior
- **WHEN** `PI_GOAL_AUTO_FOCUS` is unset or empty
- **THEN** auto-focus fires only on `reason === "resume"`

#### Scenario: Opt into legacy behavior
- **WHEN** `PI_GOAL_AUTO_FOCUS=all`
- **THEN** auto-focus fires on `reason === "new"`, `"startup"`, and `"resume"`

### Requirement: Auto-focus gated by focus lock
Even when auto-focus would fire (resume reason, or `PI_GOAL_AUTO_FOCUS=all`), if the single open-goal candidate is locked by another live session, the system MUST NOT auto-focus it — the session starts unfocused.

#### Scenario: Single open goal locked by another session
- **WHEN** auto-focus would select goal A (the only open goal) but A's lock is HELD by another live session
- **THEN** the session starts unfocused (does not steal goal A)

#### Scenario: Multiple open goals — no auto-focus (unchanged)
- **WHEN** the pool has more than one open goal (regardless of how many are locked)
- **THEN** no auto-focus fires — the `open.length === 1` condition is not satisfied

### Requirement: Lock acquired at every focus ownership transition
Whenever a session transitions to focusing a goal — via `loadState`'s `resolveSessionFocus` (auto-focus OR branch-entry OR legacy migration), `/goal-focus`, `/goal-resume`, or new-goal creation (`replaceGoal`) — the system MUST attempt `acquireLock(focusedGoalId)` BEFORE any `queueContinuation` call. This is the ownership-claim step that makes the auto-run chokepoint meaningful: without it, a resuming session would focus its own goal but never acquire the lock, and the chokepoint would wrongly block the "resume → goal continues" flow.

- On SUCCESS: the lock is held by self; the chokepoint passes; auto-run proceeds; the heartbeat timer starts.
- On FAILURE (held by another LIVE session): focus is preserved (explicit intent), but auto-run is blocked by the chokepoint and the user sees the "held by session X" message.
- On FAILURE (own STALE lock from a prior pause+lapse): `acquireLock` reaps the stale lock and reacquires — `/goal-resume` self-heals.
- On FAILURE (fail-open fs error): see Fail-open requirement — manual work proceeds, auto-run blocked.

#### Scenario: Resume auto-focus acquires the lock
- **WHEN** a session starts with `reason === "resume"`, `loadState` auto-focuses the only open (unlocked) goal, and `acquireLock` succeeds
- **THEN** the lock is held by self, the heartbeat starts, and `queueContinuation` proceeds (the core "resume → continue" flow is preserved)

#### Scenario: Resume auto-focus on a goal held by another
- **WHEN** a session resumes, `loadState`'s branch entry resolves to goal A, but `acquireLock(A)` fails because A is held by another live session
- **THEN** goal A is focused (explicit intent preserved), auto-run is blocked, and the user sees "held by session X"

#### Scenario: `/goal-resume` self-heals after lease lapse
- **WHEN** a session paused a goal, its heartbeat stopped, the lease lapsed (own stale lock), and the session runs `/goal-resume`
- **THEN** `handleGoalResume` calls `acquireLock`, which reaps the own-stale lock and reacquires; `queueContinuation` proceeds (no silent no-op)

#### Scenario: New goal creation acquires its lock
- **WHEN** `replaceGoal` creates a new goal and focuses it
- **THEN** `acquireLock(newGoalId)` is called before `queueContinuation` so the heartbeat timer refreshes a lock that actually exists

### Requirement: Auto-run gated by lock held-by-self (single chokepoint)
The `queueContinuation` function itself SHALL be the single chokepoint for auto-run gating. At the top of `queueContinuation`, the system checks whether the focused goal's lock is held by THIS session; if not (no lock, held by another, or fail-open error), the continuation is NOT queued. This single guard covers ALL `queueContinuation` call sites uniformly — including `session_start`, `session_compact`, `session_tree`, `/goal-focus`, `/goal-resume`, and new-goal creation — without per-call-site edits. No auto-run trigger may bypass this check. (For this check to pass on the resume path, the focus ownership transition MUST have called `acquireLock` first — see "Lock acquired at every focus ownership transition" requirement.)

#### Scenario: Lock held by self → continuation queued
- **WHEN** any caller invokes `queueContinuation` and this session holds the focused goal's lock
- **THEN** the continuation is queued as before

#### Scenario: Lock not held → no continuation
- **WHEN** any caller invokes `queueContinuation` and this session does NOT hold the focused goal's lock (no lock file, held by another live session, or fail-open error)
- **THEN** no continuation is queued and the goal does not auto-run in this session

#### Scenario: `/goal-resume` after lock lapsed AND acquired by another → no dual-run
- **WHEN** a session paused a goal, the lock lapsed, ANOTHER live session acquired it, and the original session runs `/goal-resume`
- **THEN** `handleGoalResume`'s `acquireLock` fails (held by other), the chokepoint blocks, and the user sees the "held by session X" message (no silent dual-run)

### Requirement: Explicit focus preserves user intent
Explicit focus signals — a focus entry in the session branch, or legacy goal state migration — SHALL take precedence over the auto-focus lock check at focus RESOLUTION time (the user already chose; do not block the focus decision on a stale-looking lock). However, explicit focus does NOT bypass the auto-run gate: if the focused goal's lock is held by another LIVE session, `queueContinuation`'s chokepoint still blocks auto-run, and the system surfaces a user-facing message: "Focused on <goal> but not running — held by session <sessionId>. Use `/goal-focus` to take over."

#### Scenario: Branch focus entry wins at resolution
- **WHEN** the session branch has a focus entry pointing to goal A and A is in the pool
- **THEN** goal A is focused regardless of whether A is locked by another session (focus is set; auto-run is gated separately)

#### Scenario: Explicit focus on a goal held by another live session → focused but not running
- **WHEN** a branch focus entry resolves to goal A, but A's lock is HELD by another live session
- **THEN** goal A is focused (not blocked), auto-run does NOT fire, and the user sees the "held by session X" message

#### Scenario: Legacy goal migration wins
- **WHEN** legacy STATE_ENTRY migration yields a non-complete goal in the pool
- **THEN** that goal is focused (consistent with prior migration behavior)
