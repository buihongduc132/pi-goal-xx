# Explore Turn 3 — Lock design

> Date: 2026-07-04
> Phase: solution design
> Status: lock mechanism designed; 4 open questions raised for user

## [user]

> **[user]** (verbatim — trust chain L1):
>
> Setting thing is not the problem ;
>
> auto focus + auto run + stealing is the problem ;
>
> How to make it smarter like: if there is current running and active goal worker , do not steal it ; if the worker crash or something without clean up , the lock should be release in some way;
>
> worktree and stuff , it is prose instruction for the main one , just ignore it ;

### Scope narrowing [S1–S3]

- **S1** Settings sharing (C3) — OUT of scope. User: "Setting thing is not the problem."
- **S2** Core problem — auto-focus + auto-run + stealing (C1, C5).
- **S3** Worktree — IGNORE. User: "worktree and stuff, it is prose instruction for the main one, just ignore it." Lock must be cwd-general (worktree is just one shape of multi-session).

## [assistant]

Designed a lease-based advisory lock with two independent liveness signals.

### Verification before design

Confirmed [E6] from turn 2: the inheritance fix introduced a new collision vector. `createAgentSession` with `inheritFromCwd` loads `pi-goal-xx` → its `session_start` → `loadState()` → could auto-focus + lock the goal being audited. The lock design must handle "sub-session in same cwd" too.

### The lock

```
   <cwd>/.pi/goals/.locks/<goalId>.lock      ← sidecar, one file per goal
   ┌────────────────────────────────────────┐
   │ {                                      │
   │   goalId: "abc123",                    │
   │   owner: {                             │
   │     sessionId: "<uuid>",               │  ← who
   │     pid: 12345,                        │  ← liveness signal 1
   │     branch: "feat/x"                   │  ← debug aid (optional)
   │   },                                   │
   │   acquiredAt: "2026-07-04T10:00:00Z",  │
   │   expiresAt: "2026-07-04T10:05:00Z",   │  ← liveness signal 2 (lease)
   │   heartbeatAt: "2026-07-04T10:04:12Z"  │  ← last seen alive
   │ }                                      │
   └────────────────────────────────────────┘
```

### Liveness: two signals, AND-logic [L1]

```
   isLockHeld(lock):
     PID alive? (process.kill(pid, 0))
     AND
     Lease fresh? (now < expiresAt)
     
     both true  → LOCKED (don't steal)
     either false → STALE (reap + acquirable)
```

| Failure mode | PID alive? | Lease fresh? | Result |
|---|---|---|---|
| Healthy, working | ✅ | ✅ | LOCKED |
| Clean shutdown (released) | — | — | no lock file |
| SIGKILL / OOM (process gone) | ❌ | maybe | STALE (PID dead) |
| Hung (deadlock, infinite loop) | ✅ | ❌ | STALE (lease lapsed) |
| PID reused by unrelated process | ✅ (wrong!) | ❌ | STALE (lease saves us) |
| Laptop closed (suspended) | ✅ | ❌ | STALE — flagged as edge case for user |

### Heartbeat [H1–H2]

- **H1** Event-driven refreshes (extend `expiresAt`): `turn_end`, `tool_execution_end`, `writeGoal(goalId)`.
- **H2** Timer-driven refresh (backstop): every 60s while goal focused & active. Covers idle-but-alive (reading, thinking, away briefly).

### Acquisition flow [A1]

```
   resolveSessionFocus (REVISED)
   ┌───────────────────────────────────────────────┐
   │  candidates = openGoalsFromPool(pool)         │
   │                                               │
   │  focusable = candidates.filter(g =>           │
   │    !isLockHeldByOther(g, selfSessionId)       │
   │  )                                            │
   │                                               │
   │  // explicit branch focus still wins:         │
   │  if (focusEntry && pool.has(focusEntry.id))   │
   │    return focusEntry.id                       │
   │                                               │
   │  // legacy migration still wins:              │
   │  if (legacyGoal && pool.has(legacyGoal.id))   │
   │    return legacyGoal.id                       │
   │                                               │
   │  // AUTO-FOCUS only among unlocked goals:     │
   │  if (focusable.length === 1)                  │
   │    return focusable[0].id                     │
   │                                               │
   │  return null   ← don't steal                  │
   └───────────────────────────────────────────────┘
```

The `=== 1` auto-focus logic stays but operates on the *unlocked* subset. If only open goal is locked by another session, new session starts unfocused.

### Acquisition timing [A2]

Lock acquisition sits BETWEEN focus-resolution and continuation-arming. **No lock → no auto-run.** Today `session_start → loadState → queueContinuation` has no gate.

### Release paths [R1–R2]

```
   NORMAL RELEASE                    CRASH RELEASE
   session_shutdown                  (no handler fires)
    → releaseLock(goal)               
    → delete .lock                   lease expires after TTL
   focus change to B                 next acquirer reaps
    → releaseLock(A)                 stale .lock
    → acquireLock(B)
```

Focus-change release [R2] is subtle: `setFocusedGoalId(B)` must `releaseLock(A)` first, else session accumulates locks on every goal it ever looked at.

### Reap-on-acquire [RA1]

```
   acquireLock(goalId, self):
     1. read existing .lock
     2. if exists AND isHeld: FAIL
     3. if exists AND isStale: delete (reap)
     4. atomic write: tmp + rename
     5. verify: re-read; if ownerId != self, FAIL
```

Step 5 is the tie-breaker for the boot race (S1/S2 acquire simultaneously).

Honest limitation: tiny window between step 4 rename and step 5 read. Negligible for human-paced session starts. `mkdir`-as-lock would be stricter but file-rename is simpler and good enough.

### Lease window (proposed)

```
   lease = 3 minutes
   heartbeat timer = 60 seconds
   → hung/crashed session detected within 3 min
   → idle session stays alive forever (timer)
   → long compile (< 3 min) safe
   → tool_execution_end refreshes, so only truly stuck tools lapse
```

### What this does NOT solve [N1–N2]

- **N1** C2 (lost update on goal file) — STILL PRESENT. Lock prevents dual-focus but doesn't serialize writes if somehow two sessions both think they own it (e.g., reap race loser didn't verify).
- **N2** C3 (settings cross-contamination) — out of scope [S1].
- C4 (auditor sub-session collision) — **potentially solved for free**. If parent holds lock, auditor's auto-focus fails → auditor starts unfocused → no collision. Elegant but UNVERIFIED. Worth checking during implementation.

### Open questions raised for user [Q1–Q4]

- **Q1** Suspended-laptop case — lock lapses after 3 min of suspension. On resume, session finds someone else took over. Acceptable, or longer lease?
- **Q2** Explicit override — `/goal-focus A` in S2 while S1 holds lock: (a) refuse, (b) warn+allow, (c) ask?
- **Q3** The `=== 1` auto-focus itself — should fresh session auto-focus ANY goal, or only on `reason: "resume"`?
- **Q4** Capture as openspec change proposal?

## Status at end of turn 3

Lock design complete (lease-based, two-signal liveness, reap-on-acquire, acquisition gates auto-run). 4 open questions for user. C4 potentially solved for free (unverified). C2 acknowledged as still-present.

→ Next: user locks decisions on Q1–Q4. See `2026-07-04-turn4-decisions-locked.md`.
