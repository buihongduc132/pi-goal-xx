# TDD Plan: add-goal-focus-locking

Source: `openspec/changes/add-goal-focus-locking/tasks.md` (9 groups, ~50 subtasks).
Strategy: RED-then-GREEN per unit; RED phase committed BEFORE any GREEN.
Test runner: `node --experimental-strip-types --test tests/*.test.ts` (no build).
Assertion lib: `node:test` + `node:assert/strict`.

## TDD Units (each = 1 RED test file/group + 1 GREEN impl)

### Unit A — Lock primitives (`extensions/goal-lock.ts`, new)
**Scope**: tasks 1.1–1.13.
**RED tests** (`tests/goal-lock.test.ts`, new):
- A1 `lockPath` returns `<cwd>/.pi/goals/.locks/<goalId>.lock` (1.3)
- A2 `readLock` returns null on missing / invalid JSON / corrupt (1.4)
- A3 `isPidAlive`: true on success, **true on EPERM** (cross-user alive), false on ESRCH/other (1.5) ← gemini fix
- A4 `isLockHeld`: PID alive AND lease fresh (1.6)
- A5 `isLockStale`: exists AND NOT held (1.7)
- A6 `writeLockAtomic`: tmp+rename, final file readable (1.8)
- A7 `acquireLock`: no lock → success; held by other → fail with `heldByOther`; stale → reap+acquire; boot-race loser (verify mismatch) → fail (1.9)
- A8 `releaseLock`: deletes; only-if-self when self provided (1.10)
- A9 `reapStaleLock`: stale deleted; held untouched (1.11)
- A10 `refreshLease`: re-writes expiresAt/heartbeatAt; fail-open on fs error (1.12)
- A11 fail-open: chmod read-only `.locks/` → warning, no throw (covers 7.4)
**GREEN**: implement `extensions/goal-lock.ts` exporting all symbols.

### Unit B — pi event verification (no impl, precondition)
**Scope**: tasks 1b.1, 1b.2.
**Action** (not a test — a grep precondition documented in plan):
- B1 grep `turn_end`, `session_shutdown` in `node_modules/@earendil-works/pi-coding-agent/dist` — confirm exist.
- B2 grep `SessionStartEvent.reason` enum — confirm `startup|reload|new|resume|fork`.
**Output**: a note in the plan commit; if any missing, STOP and surface (would invalidate the design).

### Unit C — Lease + heartbeat timer wiring
**Scope**: tasks 2.1–2.6.
**RED tests** (`tests/goal-lock-heartbeat.test.ts`, new — or fold into goal-lock.test.ts):
- C1 `leaseMs`/`heartbeatMs` defaults (180000/60000) in `GoalSettings` (2.1)
- C2 session id generated once per process via `crypto.randomUUID()` (2.2)
- C3 `refreshFocusedLease(ctx)` calls `refreshLease` on focused goal (2.3)
- C4 heartbeat timer starts on focus+active, clears on focus loss / shutdown, no leak (2.4, 2.6)
- C5 NO `turn_end`/`tool_execution_end`/write-hook refresh wired (negative test: grep source) (2.5)
**GREEN**: wire settings, session id, timer lifecycle.

### Unit D — Focus resolution gate + reason routing
**Scope**: tasks 3.1–3.10. **Changes `resolveSessionFocus` signature** + `loadState`.
**RED tests** (extend `tests/goal-pool.test.ts`):
- D1 `resume` + 1-open + unlocked → focuses (3.10)
- D2 `reload` + 1-open → does NOT focus (LD3 literal) (3.10)
- D3 `new`/`startup`/`fork` + 1-open → does NOT focus (3.10)
- D4 `null` (tree) + 1-open → does NOT focus (3.10)
- D5 `PI_GOAL_AUTO_FOCUS=all` → focuses on any reason incl reload (3.10)
- D6 the one candidate locked-by-other → unfocused (3.10)
- D7 explicit branch entry wins at resolution despite lock (3.10)
- D8 `loadState` accepts `autoFocusReason`; routes from session_start (reason) and session_tree (null) (3.2)
**GREEN**: extend `resolveSessionFocus` + thread `autoFocusReason` through `loadState` callers.

### Unit E — Auto-run chokepoint + acquire-at-transition
**Scope**: tasks 4.1–4.10, 4.10b–4.16. **Critical** (round-3 fatal flaw fix).
**RED tests** (`tests/goal-autorun-gate.test.ts`, new):
- E1 `queueContinuation` guard: no self-lock → no continuation queued (4.1)
- E2 session_start `resume` + 1-open unlocked → acquireLock succeeds → continuation QUEUED (4.10)
- E3 session_tree resolves via branch-entry → no acquireLock → chokepoint blocks → DOCUMENTED (4.10b)
- E4 `new`/`startup`/`fork` → no auto-focus → no continuation (4.11)
- E5 `/goal-resume` after pause+lapse (own stale) → acquireLock reaps+reacquires → continuation QUEUED (4.12)
- E6 `/goal-resume` after lapse+other-acquired → acquireLock fails → no continuation + held-by message (4.13)
- E7 new-goal (replaceGoal) → acquireLock → continuation QUEUED (4.14)
- E8 focus change A→B → releaseLock(A) + acquireLock(B) (4.15)
- E9 fail-open fs error on acquireLock → no continuation queued (4.16)
- E10 `state.goal` setter: null OR different id → releaseLock(previousId) fires before assignment (4.8b)
**GREEN**: add guard at `queueContinuation` top; wire acquire at session_start, handleGoalResume, setFocusedGoalId, replaceGoal; instrument `state.goal` setter.

### Unit F — `/goal-focus` override flow
**Scope**: tasks 5.1–5.7.
**RED tests** (`tests/goal-focus-override.test.ts`, new):
- F1 override refused (headless `!ctx.hasUI`) (5.7)
- F2 override confirmed → reaps held + acquires fresh (5.7)
- F3 override on stale lock → silent reap + acquire (no prompt) (5.7)
- F4 fast-path (single-open) on held goal → prompts (5.7)
- F5 prompt fires BEFORE setFocusedGoalId (ordering assertion via spy) (5.1)
**GREEN**: add lock check + prompt inside `focusGoalCommand`.

### Unit G — C4 auditor verification (make-or-break)
**Scope**: tasks 6.1–6.3. **Integration test, may need fallback.**
**RED test** (`tests/goal-auditor-c4.test.ts`, new):
- G1 spawn `runGoalCompletionAuditor` with `inheritFromCwd:true` while parent holds lock; assert auditor does NOT write a competing lock file; assert auditor's auto-run does not fire (6.1, 6.2)
- G2 if C4 hypothesis FAILS (auditor reason ≠ startup/new, or inherits focus entry), test documents the failure and the fallback (6.3): `PI_GOAL_SUBSESSION=1` skips goal machinery in auditor.
**GREEN**: if hypothesis holds, no impl needed (test passes via the lock). If fails, add `PI_GOAL_SUBSESSION` signal.

### Unit H — Broader integration tests
**Scope**: tasks 7.1–7.8.
**RED tests** (extend `tests/goal-lock.test.ts` + new `tests/goal-multisession.test.ts`):
- H1 boot race (two acquirers, one wins, one backs off) (7.1)
- H2 PID-dead → stale → reaped by next acquirer (7.2)
- H3 lease-lapsed → stale → reaped (7.3)
- H4 two-session: S1 focuses A, S2 `reason:new` → S2 unfocused (7.5)
- H5 two-session: S1 focuses A, S2 `reason:resume` → S2 unfocused (locked) (7.6)
- H6 S1 crashes (simulated) → S2 acquires on next start (7.7)
- H7 backward-compat: single-session common case still works (7.8)
**GREEN**: same impl as Units A/E — these are coverage tests.

### Unit I — Documentation
**Scope**: tasks 8.1–8.5. **No tests** (docs).
- README multi-session section, env var, settings, `.locks/` recovery, migration note.

## RED phase deliverable (task #2 of goal)

Commit order in RED phase (all tests FAILING):
1. `tests/goal-lock.test.ts` (Unit A)
2. `tests/goal-lock-heartbeat.test.ts` (Unit C) — or merged with A
3. extend `tests/goal-pool.test.ts` (Unit D)
4. `tests/goal-autorun-gate.test.ts` (Unit E)
5. `tests/goal-focus-override.test.ts` (Unit F)
6. `tests/goal-auditor-c4.test.ts` (Unit G)
7. `tests/goal-multisession.test.ts` (Unit H)

RED commit message: `test(goal-focus-locking): RED phase — failing tests for all lock requirements (TDD)`.
Confirm: `npm test` shows the new tests failing (impl symbols don't exist yet).

## GREEN phase deliverable (task #3 of goal)

Delegate to pi-acp-agents. Implementation modules:
- `extensions/goal-lock.ts` (new — Units A)
- `extensions/goal.ts` (edits — Units C, D, E, F)
- `extensions/goal-pool.ts` (edits — Unit D)
- `extensions/storage/goal-files.ts` (verify `.locks/` excluded — Unit A precondition)
- README (Unit I)

GREEN commit message: `feat(goal-focus-locking): GREEN — implement lease-based advisory lock + resume-only auto-focus`.

Confirm: `npm test` green + `npm run check` clean.

## Notes

- Code style: tabs (existing), `node:test`/`assert/strict`, no semicolons (check existing files).
- `resolveSessionFocus` signature change (Unit D) is the riskiest edit — many callers. Test coverage must catch all.
- EPERM handling (Unit A3) is the gemini fix — must be in RED.
- abort=explicit-release / pause=lazy-reap distinction (Unit E10) is the gemini+cubic fix.
- RED is a HARD GATE. Do not write impl in the RED commit.
