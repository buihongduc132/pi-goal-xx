# References

> Sources consulted during this explore session.

## Source files
- `extensions/goal-lock.ts` — lease-based advisory focus lock; `GoalFocusLock` / `LockOwner`
  interfaces, `acquireLock` / `refreshLease` / `releaseLock` / `readLockDetailed` /
  `reapStaleLock` / `reapOrphanedLocks`. This is the file the proposal will modify.
- `extensions/goal.ts` — primary consumer of the lock API (`acquireLock`, `releaseLock`,
  `readLock`, owner-self checks vs `SELF_SESSION_ID`). Determines which call sites the
  new `sessions` field will ride on. Note line 253: `SELF_SESSION_ID = crypto.randomUUID()`
  (UUID v4 — relevant to G2.1 dedup safety).
- `extensions/goal-pool.ts` — secondary reference to the lock API (grep hit); not yet
  read in detail.

## Code patterns
- `readLockDetailed` discriminated return (`found | missing | error`) — pattern to match
  when reading the new field: shape-check `sessions` on the `found` branch only, treat
  legacy locks w/o `sessions` as `[]`.
- `startTimeMs: undefined → null` normalize in `readLockDetailed` (D4) — same back-compat
  pattern the new optional `sessions?` field should follow.
- Atomic write (`tmp → rename`, `writeLockAtomic`) — `sessions` rides this free; no new
  atomicity machinery needed.
- TOCTOU guards in `reapStaleLock` / `releaseLock` (re-read right before unlink) —
  relevant because `acquireLock`'s "read → reap → write" sequence must carry the old
  array forward so a freshly-acquired session preserves prior owners' history.

## Documents
- `flow/findings/goal-focus-collision/` (2026-07-04) — earlier explore that designed the
  lock itself. Context for why the lease is exclusive-by-design and why durability of
  history must ride on the lease rather than be a separate concurrent-writer store.

## Decisions cross-referenced
- LD1 (Option A same-file) — SUPERSEDED by LD3. See `./2026-07-16-locked-decisions.yaml`.
- LD2 (lease-holder-only writes, no tool-call writes) — still locked.
- LD3 (separate sidecar) — supersedes LD1.
- LD4 (upsert by sessionId) — verified safe by UUID v4 SELF_SESSION_ID.
- LD5 (owner excluded from array) — verified by devil's-advocate.
- LD6/LD7/LD8 — added in turn2b (teams resolution): orphan reap, acquire-read-sidecar,
  explicit invariant reap-never-touches-sidecar + releaseLock ordering.

## Solutions (teams-workflow outputs, 2026-07-16)
- `./solutions/G5.2-G4.1-G4.4-rmw-serialization.md` — @rmw-architect: atomic write +
  fsync + single-writer (piggyback on lease mutex) + spread-miss structural fix.
- `./solutions/G3.1-G2.x-enforcement-and-schema.md` — @enforcement-designer: write-site
  ownership guard + UUID-grade sessionId check + wall-clock + read-boundary normalization.
- `./solutions/devils-advocate-LD3-LD5.md` — @devils-advocate: confirmed flip correct
  but underspecified; ratified LD6/LD7/LD8.
