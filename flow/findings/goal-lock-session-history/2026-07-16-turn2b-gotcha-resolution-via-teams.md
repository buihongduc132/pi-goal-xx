# Appendix to Turn 2a — gotcha-resolution-via-teams

> Coverage for: all gotchas from `./2026-07-16-turn2a-gotcha-same-file-coupling.md`
> Mechanism: teams-workflow delegation (3 workers in parallel)
> Date: 2026-07-16
> Output: `../solutions/` (3 design docs), ratified as LD6/LD7/LD8

## Teams workflow

Spawned 3 teammates in parallel via `teams delegate`, `contextMode: branch`:

| Worker | Gotcha cluster | Output |
|---|---|---|
| @rmw-architect | G5.2, G4.1, G4.4 (durability + RMW race + spread-miss) | `solutions/G5.2-G4.1-G4.4-rmw-serialization.md` |
| @enforcement-designer | G3.1, G2.1, G2.2, G2.3 (ownership guard + schema) | `solutions/G3.1-G2.x-enforcement-and-schema.md` |
| @devils-advocate | Challenge LD3/LD4/LD5 (does Option B actually resolve G5.x?) | `solutions/devils-advocate-LD3-LD5.md` |

## Resolution map — gotcha → status

| Gotcha | Rank | Status | How |
|---|---|---|---|
| G5.1 (reap destroys history) | 5 | RESOLVED | LD3 (separate file) + LD8(a) (explicit invariant reap never touches sidecar) |
| G5.2 (torn write double-failure) | 5 | RESOLVED | LD3 + `writeSessionsAtomic`: tmp→fsync(tmp)→rename→fsync(dir); `final` never torn at any crash point |
| G5.3 (conflated durability) | 5 | RESOLVED | LD3 decouples history lifetime from lease lifetime + LD7 (acquire reads sidecar preserves cross-session history) |
| G4.1 (RMW lost-update race) | 4 | RESOLVED | Single-writer invariant: only holder writes sidecar (piggyback on lease mutex). Reaper never touches sidecar. No flock/CAS needed. |
| G4.2 (owner dedup denormalization) | 4 | RESOLVED | LD5 — owner excluded from array |
| G4.3 (lastWorkedAt vs heartbeatAt desync) | 4 | RESOLVED | LD5 — current owner's activity is `.lock.heartbeatAt`; sidecar has only released sessions |
| G4.4 (spread-miss regression) | 4 | RESOLVED | (a) read fresh inside RMW fn; (b) write fn signature takes `SessionEntry[]`, not `Partial<...>` — spread-miss structurally impossible |
| G3.1 (lease-holder-only unenforceable) | 3 | RESOLVED | `upsertSessionHistory` guard at WRITE site: `readLock + isLockHeld + sessionId===owner.sessionId`; fail-open (warn + no-op) |
| G3.2 (blind append → dupes) | 3 | RESOLVED | LD4 — UPSERT by sessionId |
| G3.3 (releaseLock array semantics undefined) | 3 | RESOLVED | LD3 + LD8(b): releaseLock writes self to sidecar BEFORE unlinking `.lock` |
| G3.4 (no schema version) | 3 | RESOLVED | OT6 — `version: 1` on both files; tolerate missing on read |
| G2.1 (sessionId reuse collision) | 2 | NON-ISSUE | SELF_SESSION_ID is `crypto.randomUUID()` (UUID v4); add defensive format assertion |
| G2.2 (clock skew breaks ordering) | 2 | ACCEPTED | Wall-clock ISO matches existing lease fields; history array NOT sorted — consumers sort on read |
| G2.3 (optional forces null-checks) | 2 | RESOLVED | `readSessionHistory` normalizes to `[]` at boundary; internal code never sees `undefined` |
| G1.1 (growth worry backwards) | 1 | MOOT | Separate sidecar (LD3) means growth is real but bounded by LD6 orphan reap |

## New decisions ratified (LD6/LD7/LD8)

The devil's-advocate review found 3 critical gaps in LD3/LD4/LD5 that the implementation
would have silently missed:

- **LD6** — `reapOrphanedLocks` must reap `.sessions.json` orphans, not just `.lock`. Without
  this, every retired goal leaves a permanent history-file corpse (Rank 4 leak).
- **LD7** — `acquireLock` must READ the sidecar before writing; upsert into existing array;
  never construct fresh array when sidecar exists. Without this, lease transfer silently
  wipes prior history (G5.3 in disguise).
- **LD8(a)** — explicit invariant: `reapStaleLock`/`reapOrphanedLocks` MUST NEVER touch
  `.sessions.json` (load-bearing for G5.1 resolution; was implicit, now explicit).
- **LD8(b)** — `releaseLock` writes sidecar BEFORE unlinking `.lock`.

## Cross-worker conflict resolved

| Worker A claim | Worker B claim | Resolution |
|---|---|---|
| rmw-architect: acquireLock stamps self into history on acquire | enforcement-designer: acquire does NOT write history (owner excluded per LD5) | LD5 + LD7: acquire READS sidecar (preserve prior sessions); does NOT write self (owner excluded while active). Self added on release only. Both designs compatible. |
| rmw-architect: G4.1 may need flock/CAS | devils-advocate: flock is over-engineering; lease mutex already serializes | devils-advocate correct — piggyback on lease mutex; no flock. If G3.1 enforced, single-writer holds. |

## Workflow gap CA (callout)

Devil's-advocate flagged: `contextMode: branch` did NOT carry uncommitted leader work
(turn1/turn2/turn2a/locked-decisions/open-threads). Workers only had `solutions/` + the
inline task description. For future teams delegations on findings-in-progress: either
commit findings before delegating, OR use `contextMode: fresh` + full inline context.

## Status

All 15 ranked gotchas resolved or accepted. LD1 superseded; LD2/LD3/LD4/LD5 verified;
LD6/LD7/LD8 ratified. Findings ready for proposal/implementation.
