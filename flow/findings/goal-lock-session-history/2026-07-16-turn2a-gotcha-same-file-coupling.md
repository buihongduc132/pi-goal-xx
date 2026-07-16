# Appendix to Turn 2 — gotcha-same-file-coupling

> Gotcha coverage for: Turn 2 (`./2026-07-16-turn2-least-resistance-eval.md`)
> Sub-agent: @oracle (gotcha-reviewer-a), ACP spawn
> Items reviewed: LD1, LD2, OT1, OT2, Turn-2 spread-miss

The oracle's one-line synthesis: *Every Rank-5 gotcha is the same root cause — a cumulative record was placed inside an ephemeral mutex file. Fix the file separation (or redefine `sessions` as active-set, not history) and the Rank-5/Rank-4 cluster largely dissolves.*

## Findings (ranked)

### Rank 5 (Sophisticated)

**G5.1 — Reaper deletes the whole file; `sessions` history is destroyed on EVERY reap, not just the stale session's.**
- *What:* Stale-lock reap = `unlink(.lock)`. Because history lives in the same file, reaping one dead owner wipes the `lastWorkedAt` of *every* session that ever held the goal.
- *Why missed:* LD1 frames same-file as "convenient." It is also a shared fate. The reaper's contract was "remove a stale mutex"; it is now "destroy all session history."
- *Severity:* High. Defeats any "resume / who-worked-on-this" use the second a lock goes stale (the common case — crashes are exactly when you want history).
- *Mitigation:* History must live in a *separate* file (`.locks/<goalId>.history.json`) with append-only semantics, OR the reaper must rewrite-and-preserve instead of unlink. If same-file is non-negotiable, reap = read→strip-owner→rewrite, never delete.

**G5.2 — Torn write / no-fsync crash now corrupts the mutex *and* the history simultaneously.**
- *What:* A crash mid-`JSON.stringify`+`writeFile` (or write-without-fsync + power loss) produces a truncated/partial file. Pre-`sessions`, this only bricked the lease (reapable, self-healing). Post-`sessions`, it also destroys the historical record that was supposed to survive.
- *Why missed:* Failure isolation narrowed when the file gained a second, more durable-intent payload. The old "torn write is fine, reaper handles it" invariant no longer holds for the new data.
- *Severity:* High on crash paths; Medium generally.
- *Mitigation:* Atomic write (temp file + `rename`), and `fsync` the directory. If history must survive, it cannot share a non-atomic write path with a frequently-rewritten mutex.

**G5.3 — Conflated durability: "history" with lease-ephemeral lifetime is not history.**
- *What:* The array's intended meaning (which sessions worked this goal, when) requires *persistence across lease churn*. But it's bound to acquire/refresh/release, and (per G5.1) deleted on reap. So it only ever reflects the *current* lease's session — a single entry, repeatedly.
- *Why missed:* "No per-tool-call writes" (LD2) optimizes for write cost but ignores that the *lifecycle boundary* (lease) is the wrong granularity for a cumulative record.
- *Severity:* High (design-level). The feature silently degenerates to "who currently holds it," which `owner` already provides.
- *Mitigation:* Define whether `sessions` is active-set or history. If history → separate durable store. If active-set → don't call it history, and OT1's dedup is the whole feature.

### Rank 4 (Significant)

**G4.1 — Read-modify-write lost-update race between reaper and acquirer (no CAS/file lock).**
- *What:* acquireLock/refreshLease/releaseLock all do read→mutate-`sessions`→write. The reaper runs concurrently and deletes (or rewrites). Classic last-writer-wins: acquirer's write resurrects a reaped file, or reaper's delete lands between acquirer's read and write.
- *Why missed:* "Personal agent, single holder" assumes single writer. But the reaper is an independent writer on the *same* file, and reap is explicitly concurrent.
- *Severity:* Medium-High (intermittent, hard to repro — the worst kind).
- *Mitigation:* File lock (`flock`/`lockfile`) around every RMW, or atomic rename with content hash CAS. Without it, "lease-holder semantics only" (LD2) is unenforceable.

**G4.2 — Two sources of truth for "current owner": `owner` field vs. array entry. Denormalization drift.**
- *What:* OT1 puts the owner *also* in `sessions` "for single source of truth" — but that creates *two* locations of the same fact. Any code path that updates one and not the other (acquire updates `owner`, forgets array; or vice versa) yields a contradiction with no defined arbiter.
- *Why missed:* "Single source of truth" was the *intent*; the mechanism (duplication) produces the opposite. Denormalization is the hazard, not the fix.
- *Severity:* Medium. Bugs are silent until a consumer picks the wrong field.
- *Mitigation:* Pick one authoritative location. If array is canonical, derive `owner` = `sessions.find(active)`. If `owner` is canonical, array is derived/history-only and must not restate current owner.

**G4.3 — `lastWorkedAt` (array) vs `heartbeatAt` (owner) redundancy desync.**
- *What:* For the current owner, `sessions[owner].lastWorkedAt` should equal `owner.heartbeatAt` (both = "last heartbeat"). Two fields, same meaning, independent write sites → they will drift. Consumers reading one vs the other get different "last activity."
- *Why missed:* Field naming hides that they're the same datum at different granularities.
- *Severity:* Medium.
- *Mitigation:* `lastWorkedAt` should be defined only for *non-current* sessions (frozen at release). For the current owner, `heartbeatAt` is the value; don't duplicate.

**G4.4 — Spread-miss *regression* (stale array overwrites fresh) — Turn-2 variant.**
- *What:* Turn-2 covers `sessions` *dropped* on rewrite. The mirror hazard: `{ ...lock, sessions: oldSnapshot }` where `oldSnapshot` was read before another writer appended. Result: silent rollback of recent entries, not just loss — *corruption* of ordering/recency.
- *Why missed:* Turn-2 frames it as omission; the data-loss-by-overwrite path is equally likely and worse (looks valid, is wrong).
- *Severity:* Medium-High.
- *Mitigation:* Same as G4.1 (serialize RMW). Spread-miss is a symptom; the cause is unsynchronized RMW.

### Rank 3 (Moderate)

**G3.1 — "Lease-holder semantics only" is unenforced at the write site.**
- *What:* LD2 says array mutates *only* at acquire/refresh/release. But nothing prevents a non-holder from calling `refreshLease` (e.g., a session trying to steal or a bug) — does it append itself? If refreshLease updates `sessions` before verifying ownership, any caller pollutes the array.
- *Why missed:* The claim is a design rule, not a runtime guard.
- *Severity:* Medium.
- *Mitigation:* Guard every `sessions` mutation behind an ownership check (sessionId == owner.sessionId) at the *write* site, not just in the happy path.

**G3.2 — Blind append vs upsert → duplicate entries on re-acquire.**
- *What:* OT2 says "unbounded append." If acquireLock appends without checking for an existing sessionId, a session that loses-and-regains a lease (common under contention/reap churn) gets N entries.
- *Why missed:* "Handful of sessions" assumes stable ownership; re-acquire is the realistic failure mode.
- *Severity:* Medium (corrupts any count/dedupe consumer).
- *Mitigation:* Upsert by sessionId, not append.

**G3.3 — `releaseLock`'s effect on the array entry is undefined.**
- *What:* On release: (a) delete entry? → no history. (b) freeze `lastWorkedAt`? → entry persists, survives release but not reap (inconsistent with G5.1). (c) stamp release time? → `lastWorkedAt` misnamed. The design picks none explicitly.
- *Why missed:* Lifecycle spec covers acquire/refresh but not release's interaction with the new field.
- *Severity:* Medium (determines whether the feature works at all).
- *Mitigation:* Specify explicitly. Recommend (b): freeze on release, never delete from release path; deletion is reap-only — but then fix G5.1.

**G3.4 — No schema version; forward/back compat undefined.**
- *What:* Adding `sessions` to an existing lock format with no `version`/`schema` field. Old readers rewrite and strip it (Turn-2, generalized). New readers hitting an old file: init `[]`? error? Undefined. Migration path absent.
- *Why missed:* Treated as additive-only; additive fields are only safe if all writers are forward-aware and all readers are null-safe — neither is guaranteed across an evolving agent.
- *Severity:* Low-Medium.
- *Mitigation:* Add `version: 1`, default `sessions: []` on read, never write without preserving unknown fields (forward-compat passthrough).

### Rank 2 (Minor)

**G2.1 — Session-ID reuse collides in dedup.**
- *What:* If session IDs aren't globally unique across restarts (e.g., derived from PID/time), a new session can match a stale array entry → dedup merges two distinct sessions, lastWorkedAt from the wrong run.
- *Why missed:* Assumes session IDs are immutable unique keys.
- *Severity:* Low (depends on ID generation).
- *Mitigation:* UUIDs for sessionId; or key on `{sessionId, pid, startTimeMs}` tuple.

**G2.2 — Clock skew / non-monotonic time breaks `lastWorkedAt` ordering.**
- *What:* NTP step-backward or cross-host skew makes `lastWorkedAt` regress; any "most recent session" ordering flips. Personal-agent mitigates cross-host but not NTP.
- *Why missed:* Assumes wall clock is monotonic.
- *Severity:* Low.
- *Mitigation:* Use `startTimeMs`-anchored monotonic deltas, or accept last-write-wins and don't promise ordering.

**G2.3 — `sessions?` optional forces null-check everywhere.**
- *What:* Every reader must handle `undefined | [] | [...]`. One missed guard → TypeError. The `?` propagates a branch through all consumers.
- *Why missed:* Treated as schema convenience; it's a distributed null-handling tax.
- *Severity:* Low.
- *Mitigation:* Normalize to `[]` at the read boundary; internal code never sees `undefined`.

### Rank 1 (YAGNI / non-issue flagged)

**G1.1 — OT2's "unbounded growth" worry is backwards.**
- *What:* The real risk is the *opposite*: growth is *over*-bounded by reap deleting the whole file (G5.1). Under same-file design, the array can never grow beyond one lease's worth anyway — it's reset on every reap. "Cap the array" solves a problem that can't occur; the actual problem (ephemerality) is unaddressed.
- *Why missed:* Growth analysis assumed the file persists; it doesn't.
- *Severity:* N/A as a bug — but it's a *misdirection*: effort on OT2 distracts from G5.1/G5.3.
- *Mitigation:* Drop OT2 from scope; redirect attention to durability (Rank 5).

## Cross-turn references

- Also relevant to: Turn 1 §"Key fork — where does the array live?" and §"Edge cases worth deciding" (the same-file vs separate-file fork was initially resolved to B there, then reversed to A in Turn 2).
- Resolution: see updated `../2026-07-16-locked-decisions.yaml` — LD3 supersedes LD1, returning to Option B (separate sidecar) because G5.1/G5.3/G5.2 contradict the "resume later" use case under same-file.

---

**Callback (added 2026-07-16 after teams resolution):**
All 15 gotchas here were RESOLVED via teams-workflow (turn2b). Rank-5/4 cluster dissolved
once LD3 (separate sidecar) + LD6/LD7/LD8 (orphan reap, acquire-read-sidecar, explicit
invariants) were locked. See turn2b for the full resolution map.
