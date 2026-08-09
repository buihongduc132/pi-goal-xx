# goal-lock-session-history

> Date range: 2026-07-16 → 2026-07-16
> Status: ready-for-proposal (all threads closed, all gotchas resolved)

## Topics

### explore-entry (2026-07-16)
User asked to extend the goal focus lock (`extensions/goal-lock.ts`) to persist a history of
which pi sessions have worked on each goal — array of `{sessionId, lastWorkedAt}` appended
on each new session. Explored two file-layout forks: (A) extend `GoalFocusLock` in same
`.lock` file vs (B) separate `.sessions.json` sidecar. Initial assistant lean was B (history
dies with `reapOrphanedLocks`); user constraint ("no tool calls, just 'who worked on this' to
resume later; least resistance while durable + reliable") flipped the lean to **A** — single
file, mutation rides on existing lease write paths (`acquireLock` / `refreshLease` /
`releaseLock`).

### gotcha-coverage (2026-07-16)
@oracle gotcha review revealed same-file (A) is fundamentally broken for the user's stated
purpose: stale-lock reap deletes the `.lock` file → wipes ALL session history (G5.1); history
bound to lease lifecycle degenerates to "who currently holds it" (G5.3); torn-write double-
failure (G5.2). Converged back to **Option B** (separate sidecar) — durable + reliable wins
over least-resistance. Closed threads OT1-OT6. LD3 supersedes LD1.

### gotcha-resolution-via-teams (2026-07-16)
3 teammates in parallel: @rmw-architect (G5.2/G4.1/G4.4 RMW + atomic write),
@enforcement-designer (G3.1/G2.x ownership guard + schema), @devils-advocate (challenge
LD3/LD4/LD5). Devil's-advocate found 3 critical gaps the implementation would have missed:
LD6 (orphan sidecar reap), LD7 (acquire must read sidecar), LD8 (explicit invariant: reap
never touches sidecar + releaseLock ordering). All 15 ranked gotchas resolved or accepted.
Cross-worker conflict (acquireLock writes or not) resolved by LD5+LD7: acquire reads but
doesn't add self.

## Pick up next time
1. `./2026-07-16-locked-decisions.yaml` — LD1 superseded; LD2-LD8 locked. **Read first.**
2. `./2026-07-16-turn2b-gotcha-resolution-via-teams.md` — resolution map for all 15 gotchas.
3. `./solutions/` — 3 design docs with pseudocode (TS matching existing style).
4. Tasks (from earlier step-50 pass, now expanded): implement Option B sidecar + LD6-LD8.
5. Workflow gap: `contextMode: branch` didn't carry uncommitted findings — commit before
   delegating OR use fresh+inline.
