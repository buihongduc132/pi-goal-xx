# Explore Turn 1 — explore-entry

> Date: 2026-07-16
> Phase: problem-space exploration + codebase mapping
> Status: assistant presented forks + questions, awaiting user steer

---

## [user]

> **[user]** (verbatim — trust chain L1)
>
> Now I want the goal lock to also persist the pi session that is working on it as well ; it would be array , any new session will be append below. MAKE IT object that having session id , last time that session working on the goal;
>
> --- *(explore-mode system prompt appended after — excerpted below)*
>
> > **IMPORTANT: Explore mode is for thinking, not implementing.** … NEVER write code or implement features.
> > Input: "Now I want the goal lock to also persist the pi session…"

---

## [assistant]

Investigated `extensions/goal-lock.ts` and grep'd for `acquireLock`/`releaseLock`/`GoalFocusLock`/`LockOwner`/`readLock(`/`refreshLease` usage across `extensions/`. Found callers in `goal.ts` and `goal-pool.ts`.

### Current state

`extensions/goal-lock.ts` — **exclusive lease mutex** per goal. One JSON sidecar `<cwd>/.pi/goals/.locks/<goalId>.lock`:

```
GoalFocusLock {
  goalId
  owner: { sessionId, pid, startTimeMs }   ← singular, the holder
  acquiredAt, expiresAt, heartbeatAt
}
```

Semantics: held iff PID alive + lease fresh. Stale → reaped. Only ONE session owns at a time.

Your ask adds a **second, orthogonal concept**: a *collaboration history* — array of `{sessionId, lastWorkedAt}`. These two are NOT the same thing:

```
┌──────────────────────────────────────────────────────────┐
│  MUTEX (current)              │  HISTORY (your ask)       │
├───────────────────────────────┼───────────────────────────┤
│ "Who holds focus NOW?"        │ "Who has EVER worked?"    │
│ exclusive, 1 owner            │ plural, append-only       │
│ liveness-checked (PID+lease)  │ log only, no liveness     │
│ reaped when stale             │ durable across holders    │
└───────────────────────────────┴───────────────────────────┘
```

### Key fork — where does the array live?

**Option A: same file (extend `GoalFocusLock`)**
```
GoalFocusLock {
  ...existing...
  sessions: [ { sessionId, lastWorkedAt } ]   // NEW
}
```
- Pros: 1 file, lock-holder is sole writer → no write contention. Acquire path already read-then-write.
- Cons: `reapOrphanedLocks` deletes `.lock` for deactivated goals → **history dies with the lock**. History conceptually entangled with ephemeral lease.

**Option B: separate sidecar `<goalId>.sessions.json`**
```
.pi/goals/.locks/<goalId>.lock          ← lease (unchanged)
.pi/goals/.locks/<goalId>.sessions.json ← [{sessionId, lastWorkedAt}]
```
- Pros: clean separation. History survives lock deletion, reactivation, manual cleanup. Matches "who ever touched this."
- Cons: 2 files per goal, 2 read paths. No lock protects array writes — but only holder writes anyway, so effectively serialized by the mutex.

↑ My lean: **B**. History is durable; mutex is ephemeral. Coupling them means orphan-reap silently erases what you're trying to persist. `reapOrphanedLocks` is the killer argument.

### Write triggers (when does array mutate?)

```
  acquireLock ──▶ UPSERT self {sessionId, lastWorkedAt: now}   ┐
  refreshLease ─▶ UPSERT self lastWorkedAt (every 60s heartbeat)┤── bump existing or push new
  releaseLock ──▶ UPSERT self lastWorkedAt (final stamp)        │
  any tool call?▶ too chatty, skip                             ┘
```

"Append below" → on **new** sessionId. Existing session → **update** `lastWorkedAt`, no dup row. (Otherwise array grows unbounded w/ every heartbeat.)

### Edge cases worth deciding

1. **Stale-reap preserve** — when B reaps A's stale lock and acquires, B must READ A's array and append B to it, else A's history is wiped. (Trivial in A; in B the file's untouched.)
2. **Back-compat** — `isValidLockShape` currently rejects unknown shapes. `sessions` must be **optional → default `[]`**, same pattern as the `startTimeMs: undefined → null` normalize in `readLockDetailed`. Legacy locks keep working.
3. **Owner dedup** — owner is in the array too, or array is "everyone BUT current owner"? Recommend **owner included** — one source of truth for history, simpler.
4. **Capping** — unbounded growth? Probably fine for a personal agent (handful of sessions/goal). Worth a soft cap (last N) only if you foresee many.
5. **Where displayed** — `/goal-list`, goal widget, trace? UX follow-up, not data-model.

### Questions before I'd crystallize a proposal

- **Q1 (the fork)**: same file (A) or separate sidecar (B)? My rec: B.
- **Q2 semantics of "worked on"**: "ever held the lease" (history of owners) vs "any session that called a goal tool"? Former is clean (mutex-driven); latter needs per-tool-call writes + breaks the "only holder writes" invariant.
- **Q3**: owner duplicated in array, or array = everyone-except-current-owner?

Want me to capture this as an OpenSpec proposal once you pick the fork, or keep poking at edges?

---

### Status at end of turn 1

- Two-file-layout fork surfaced (A vs B). Assistant lean = B (durability via `reapOrphanedLocks` argument).
- 3 open questions (Q1/Q2/Q3).
- Awaiting user steer on fork + semantics.
- Next: `./2026-07-16-turn2-least-resistance-eval.md` — user constraint flips the lean.

---

**Callback (added 2026-07-16 after teams resolution):**
Turn 2 + turn2a flipped the lean to A then back to B. See turn2b for final resolution.
This turn's lean (B) was correct on the merits; the constraint-driven detour through A
(turn 2) was reversed by gotcha-coverage (turn2a → LD3).
