## Context

pi-goal-xx persists goals to `<cwd>/.pi/goals/` (cwd-shared) while focus state is per-session and auto-derived from that disk pool on `session_start`. The chain `loadState → resolveSessionFocus → queueContinuation` has no gate between "I discovered a goal on disk" and "I started running it."

When a second pi session opens in the same cwd (worktree, parallel verification, ad-hoc), `resolveSessionFocus` auto-focuses the only open goal (`goal-pool.ts:54-55`) and `session_start` queues a continuation (`goal.ts:3663`) — stealing the goal from the session that was actively working on it. The worker-isolation escape hatch only fires for `PI_TEAMS_WORKER === "1"`; manual worktree and ad-hoc sessions are fully exposed.

The inheritance fix (PR #4) added a new vector: `createAgentSession({cwd, inheritFromCwd: true})` loads `pi-goal-xx` via `DefaultResourceLoader`, and its `session_start` handler runs `loadState` — so the auditor sub-session can auto-focus and collide with its parent (C4).

Stakeholders: anyone running multiple pi sessions in one cwd, anyone using worktree-per-feature, and the auditor (post-inheritance).

Reference: `flow/findings/goal-focus-collision/` (full explore transcript with evidence and locked decisions LD1–LD3).

## Goals / Non-Goals

### Goals
- G1. Prevent a fresh session from auto-focusing + auto-running a goal another live session is actively working on.
- G2. Detect crashed/hung sessions and release their locks so the goal becomes available again (no manual cleanup).
- G3. Make the lock advisory: explicit user action (`/goal-focus`) can override with confirmation.
- G4. Restrict auto-focus to `session reason: "resume"` by default (user is coming back to their own session), with an env flag to opt back into broader auto-focus.
- G5. Solve C4 (auditor sub-session collision) without special-casing — converging mechanisms (resume-only auto-focus + lock check).

### Non-Goals
- N1. Serializing concurrent writes to the same goal file (C2). The lock prevents dual-focus in the common case but does not guarantee write serialization under all races. Out of scope.
- N2. Settings cross-contamination (C3). User-declared out of scope — settings remain cwd-shared.
- N3. Handling suspended-laptop/sleep edge cases specially (LD1). No suspend detection, no long-lease logic. A sensible default lease; least-resistant path.
- N4. Worktree-specific detection. The lock is cwd-general; worktree is just one shape of multi-session.

## Decisions

### D1: Lock file format and location

**Decision**: One JSON sidecar per locked goal at `<cwd>/.pi/goals/.locks/<goalId>.lock`:
```json
{
  "goalId": "abc123",
  "owner": {
    "sessionId": "<uuid>",
    "pid": 12345
  },
  "acquiredAt": "2026-07-04T10:00:00Z",
  "expiresAt": "2026-07-04T10:05:00Z",
  "heartbeatAt": "2026-07-04T10:04:12Z"
}
```

**Rationale**: Sidecar per-goal (not one global lock file) — natural concurrency (different goals, different files), no parse-everything-to-find-one, and a crashed session leaves at most one stale file per goal it held. JSON for human readability when debugging. The `.locks/` subdir keeps them out of the active-goal pool scan (`readActiveGoalFiles` scans `.pi/goals/active_goal_*.md`, not subdirs).

`owner.branch` is intentionally **omitted** (deferred). It was debug-only value but required a `git rev-parse` call per acquire or a session-metadata lookup — pure overhead for the core requirement. The LD2 override prompt identifies the owner by `sessionId` + `pid` alone, which is sufficient. If debug need arises later, add it as an optional best-effort field.

**Alternatives**:
- Single `.pi/goals/.lock` index file — contention bottleneck, parse-the-whole-thing per check.
- A `lockedBy` field on the goal file itself — couples lock state to goal state; crash leaves the goal file in a weird state.
- `mkdir`-as-lock (atomic create-or-fail) — stricter than rename, but the metadata (pid, expiresAt) needs to live somewhere anyway, so we'd still write a sidecar. File-rename is simpler and good enough for human-paced session starts.

### D2: Two-signal liveness (PID alive AND lease fresh)

**Decision**: A lock is HELD iff BOTH `process.kill(pid, 0)` succeeds (process alive) AND `now < expiresAt` (lease not lapsed). Either failing makes the lock STALE and reapable.

**Rationale**: Each signal alone has a known blind spot:
- PID alone: a dead PID can be reused by an unrelated process → false "alive."
- Lease alone: a hung session (infinite loop, deadlock) keeps the lease alive via the timer even though it's not making progress — wait, no: a hung session's timer also stops firing, so the lease lapses. Lease alone is actually robust against hangs. BUT lease alone can't detect "process gone, lease not yet lapsed" fast — you'd wait the full TTL.
- Combined: crash detected near-instantly (PID dead), hang detected within lease TTL (lease lapses), PID-reuse caught by lease (lease lapsed while PID was dead, so even if reused, the lock is stale).

| Failure mode | PID alive? | Lease fresh? | Result |
|---|---|---|---|
| Healthy, working | ✅ | ✅ | LOCKED |
| Clean shutdown | (lock deleted) | (lock deleted) | FREE |
| SIGKILL / OOM | ❌ | maybe | STALE (PID) |
| Hung | ✅ | ❌ | STALE (lease) |
| PID reused | ✅ wrong | ❌ | STALE (lease saves) |

**Alternatives**:
- Lease-only — simpler, but slower crash detection (must wait TTL even when PID is provably dead).
- PID-only — fast crash detection but no hang detection at all.

### D3: Lease window = 3 min, heartbeat timer = 60s (timer-only refresh)

**Decision**: `expiresAt = now + 3min` at acquisition, refreshed by a single 60-second `setInterval` timer while focused & active. No event-driven refresh (`turn_end`, `tool_execution_end`, write-hooks) — timer-only.

**Rationale** (LD1 "least resistant path"): The 60s timer refreshes the 180s lease ~3× within its window, covering BOTH idle presence and long tool executions. Adding `turn_end` or `tool_execution_end` refresh would create a second/third code path, extra event subscriptions, and extra lock-file writes per turn — all for ZERO liveness benefit the timer does not already provide. The simplest design that meets UR2 (release on crash/hang) is a timer + lease + PID check. Event-driven refresh was rejected as over-engineering. Tunable in settings if 3 min proves wrong.

**Alternatives**:
- 30s lease / 10s timer — faster detection but risks lapping during GC pauses or slow tool calls.
- 30 min lease — tolerates suspension (rejected per LD1).
- Refresh on `turn_end` / `tool_execution_end` / write-hooks — rejected as over-engineering (see above).

### D4: Auto-focus restricted to resume-like reasons by default; env flag `PI_GOAL_AUTO_FOCUS`

**Decision**: `resolveSessionFocus`'s `open.length === 1` auto-focus branch only fires when `loadState`'s `autoFocusReason` argument is resume-like. `session_start` passes `event.reason` (the full pi enum: `"startup" | "reload" | "new" | "resume" | "fork"`); `session_tree` and any other non-session_start caller pass `null`.

**Resume-like reasons** (LD3 "Default: 'resume' only" — honored VERBATIM):
- `"resume"` — user returning to their own session.

**Non-resume reasons** (no auto-focus under default — including `reload`):
- `"reload"` — NOT resume-like under the default. LD3 is locked at literal "resume only", so `reload` is excluded. (Side effect: a mid-work extension hot-reload will NOT auto-refocus; the user must `/goal-focus` again, or set `PI_GOAL_AUTO_FOCUS=all`. If this proves annoying in practice, `reload` can be promoted to resume-like via a NEW locked-decision update — but that requires explicit user sign-off, not a silent plan extension.)
- `"new"`, `"startup"`, `"fork"` — a brand-new session should not steal a goal. (`fork` is a child/sub-session spawn — explicitly excluded; this also helps the C4 auditor case.)
- `null` (from `session_tree` and other non-session_start callers) — tree navigation must not steal.

New env flag:
- `PI_GOAL_AUTO_FOCUS=resume` (default) — auto-focus only on resume-like reasons.
- `PI_GOAL_AUTO_FOCUS=all` — opt back into auto-focus on any reason (legacy behavior).

**Rationale** (LD3): The "I just opened pi for an unrelated task and it stole my goal" case is the core complaint. Killing auto-focus on `new`/`startup`/`fork`/tree-nav eliminates it. `resume` and `reload` are safe because they are the user's OWN session continuing.

**Alternatives**:
- Kill auto-focus entirely — breaks the "reopen, goal continues" UX.
- Treat `reload` as resume-like by default — would prevent focus-drop on extension hot-reload, but EXCEEDS LD3's literal "resume only"; rejected as a silent locked-decision extension (requires explicit user sign-off if desired).
- Auto-focus but check lock first — works, but new/startup sessions have no branch focus entry, so auto-focus there is still surprising.

### D5: Explicit override asks before stealing (advisory lock)

**Decision**: `/goal-focus` (the selector command, including its single-open-goal fast-path at `focusGoalCommand`) on a goal locked by another LIVE session → prompt: "Session <sessionId> (pid <pid>) looks alive — take over anyway? (this will steal the lock)". On STALE locks, no prompt — silent reap + acquire. Owner identity uses `sessionId` + `pid` only (branch field deferred — see D1). Headless (`!ctx.hasUI`) → refuse with a warning (cannot prompt).

**Rationale** (LD2): The lock is advisory; the user is the authority. Auto-steal is hostile to the active session; refuse blocks the user when they genuinely know the other session is stuck. Asking balances both.

**Alternatives**:
- Refuse — user can't recover a stuck session without manually deleting the lock file.
- Warn-and-steal — silent takeover surprises the active session's owner.

### D6: Auto-run gated at the `queueContinuation` chokepoint; lock acquired at every ownership transition

**Decision (chokepoint)**: The auto-run gate lives at the TOP of `queueContinuation` itself — a single check: "does THIS session hold the focused goal's lock?" If no (no lock file, held by another live session, or fail-open error), the continuation is NOT queued. This single guard covers ALL ~8 call sites uniformly (`session_start`, `session_compact`, `session_tree`, `/goal-focus`, `/goal-resume`, new-goal creation, mid-run `turn_end`/`agent_end`) without per-call-site edits.

**Decision (acquire — critical pairing)**: For the chokepoint to PASS on the resume/auto-focus path, `acquireLock` MUST be called at every focus ownership transition — including `loadState`'s direct `focusedGoalId = resolveSessionFocus(...)` assignment (goal.ts:978, which bypasses `setFocusedGoalId`). Without this, a resuming session would focus its own goal but never acquire the lock, and the chokepoint would wrongly block the "resume → continue" flow (the exact UX the plan must preserve).

Acquire is wired at:
- `session_start` handler — after `loadState`, call `acquireLock(focusedGoalId)` before `queueContinuation` (covers resume auto-focus + branch-entry + legacy migration)
- `handleGoalResume` — `acquireLock` before `queueContinuation` (self-heals own-stale locks from pause+lapse)
- `setFocusedGoalId` — `releaseLock(old)` + `acquireLock(new)` (covers `/goal-focus` and explicit focus changes)
- `replaceGoal` — `acquireLock(newGoalId)` (covers new-goal creation)

On acquire FAILURE: focus is preserved (explicit intent), but auto-run is blocked by the chokepoint and the user sees "Focused on <goal> but not running — held by session <sessionId>. Use `/goal-focus` to take over."

**Rationale** (simplicity audit): The first plan draft gated each call site individually — that was both over-engineered (N edits) and incomplete (the `/goal-resume:1697` and `replaceGoal:1444` call sites were missed, which would have allowed dual-run after a pause+lapse). A single chokepoint is smaller, complete, and trivially auditable. The acquire-on-transition pairing was added after round-3 verification caught that `loadState` bypasses `setFocusedGoalId` — without it, the chokepoint would block the legitimate resume flow.

**Interaction with explicit focus**: Branch-entry and legacy-migration focus still RESOLVE to the goal (not blocked by a stale-looking lock), then attempt `acquireLock`; if that goal is locked by another LIVE session, the chokepoint blocks auto-run and the user sees the held-by message.

**Alternatives**:
- Per-call-site gating — rejected (over-engineered + leaky; misses resume/create).
- Check-self chokepoint WITHOUT acquire-on-transition — rejected (round-3 fatal flaw: blocks resume-and-continue).
- No gating — the original bug (UR1).

### D7: Fail-open scope — no crash + manual work proceeds; auto-run still gated

**Decision**: Fail-open means the session does not CRASH on fs errors, and manual/explicit goal work (user-driven tool calls, `/goal-focus`) proceeds. **Auto-run is NOT fail-open**: if the session cannot prove it holds the lock (write failed), the chokepoint still blocks `queueContinuation` — the session cannot assert ownership of a goal it failed to lock. The auto-run gate is a correctness invariant (no lock, no auto-run) that fail-open does not relax.

**Rationale**: Round-3 verification caught a contradiction — the original fail-open text ("goal proceeds without a lock, no auto-run gating") directly conflicted with the auto-run gate ("fail-open error → no continuation"). This decision resolves it: fail-open prevents crashes; the auto-run gate remains a hard correctness invariant.

**Alternatives**:
- Fail-open treats fs-error as "pretend held" → auto-run proceeds — rejected (defeats the lock's purpose in the error case; a permissions misconfig would silently allow dual-run).
- Fail-open blocks everything (crash) — rejected (one bad `.locks/` perms shouldn't brick goal work).

## Risks / Trade-offs

**[Risk] Reap race — two sessions reap the same stale lock simultaneously**
→ Mitigation: `acquireLock` does atomic write (tmp + rename) then verify (re-read; if ownerId != self, FAIL). The loser's verify fails and it backs off. Tiny window between rename and read is negligible for human-paced starts.

**[Risk] Stale lock files accumulate if `session_shutdown` doesn't fire (SIGKILL)**
→ Mitigation: stale locks are reaped lazily by the next acquirer (reap-on-acquire). Accumulation is bounded by the number of goals ever focused. A periodic `.locks/` sweep on `loadState` is an optional enhancement.

**[Risk] PID reuse — dead PID is reused by unrelated process before lease lapses**
→ Mitigation: D2's AND-logic. If lease is lapsed, lock is stale regardless of PID. PID reuse only fools a PID-only check; combined check is safe.

**[Risk] Backward compat — users relying on auto-focus-on-startup see behavior change**
→ Mitigation: `PI_GOAL_AUTO_FOCUS=all` restores legacy behavior. Documented in README and migration note.

**[Risk] Lock file permission / cross-user cwd**
→ Mitigation: standard file permissions; if write fails, log warning and proceed without lock (fail-open). Locking is an optimization for the common multi-session case, not a security boundary.

**[Trade-off] Lease default (3 min) is a guess**
→ Tunable in settings. If it lapses during legitimate long pauses, users will notice and we adjust. LD1 accepts this.

**[Trade-off] Advisory — cooperative only**
→ A session that ignores the lock (third-party tool writing goal files directly) bypasses everything. Out of scope; the lock coordinates cooperating pi-goal-xx sessions.

## Migration Plan

1. Ship the change. Old lock files don't exist, so no migration of disk state.
2. Behavior change: auto-focus no longer fires on `new`/`startup`. Users who relied on it set `PI_GOAL_AUTO_FOCUS=all`.
3. Document in README under a new "Multi-session goal focus" section + add the env flag to the env-var table.
4. Rollback: revert the commit. No persistent state to clean up (`.locks/` dir is a cache; safe to `rm -rf`).

## Open Questions

- **OQ1 (RESOLVED)**: Should `accountProgress`/`writeActiveGoalFile` refresh the lease? **Answer: No.** D3 chose timer-only refresh (60s `setInterval`). The timer refreshes the 180s lease ~3× within its window regardless of writes, covering accounting writes. No write-hook needed. Closed.
- **OQ2 (RESOLVED)**: Branch field in lock metadata? **Answer: Deferred.** D1 omits `owner.branch` — debug-only value that required `git rev-parse` overhead. Owner identity uses `sessionId` + `pid` only. If debug need arises, add as optional best-effort later.
- **OQ3 (OPEN — make-or-break via task 6)**: Does C4 (auditor sub-session collision) need explicit handling, or is it solved by convergence? **Refined hypothesis**: C4 safety comes from the **lock**, not primarily from the resume-only reason gate. Even if `inheritFromCwd` passes a parent FOCUS_ENTRY to the auditor (making "explicit focus wins" resolve the goal regardless of `reason`), the auditor's `acquireLock` FAILS (parent holds the lock), so the auditor never writes a competing lock and the chokepoint blocks its auto-run. The resume-only reason gate is a SECONDARY defense (excludes auto-focus on `startup`/`new`/`fork`). Verify via task 6: spawn an auditor with `inheritFromCwd:true` while parent holds the lock; confirm (a) auditor does not write a competing lock, (b) auditor's auto-run is blocked. If both hold, C4 is solved by the lock. If not, fallback (task 6.3): explicit `PI_GOAL_SUBSESSION=1` to skip goal machinery entirely in the auditor.
