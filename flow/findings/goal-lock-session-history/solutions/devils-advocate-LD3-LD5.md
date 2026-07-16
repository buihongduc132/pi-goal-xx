# Devil's Advocate Review — LD3 / LD4 / LD5 (Option B flip)

> Reviewer: @devils-advocate (teams worker)
> Date: 2026-07-16
> Scope: Does Option B (separate `.sessions.json` sidecar) actually resolve
> G5.1/G5.2/G5.3/G4.1/G4.4, or does it MOVE the problem? Plus new gotchas B introduces.
> Grounded in: `extensions/goal-lock.ts` (actual code), locked-decisions.yaml, turn2a gotchas.
>
> **NOTE on workflow:** leader's findings files (turn1/turn2/turn2a/locked-decisions/
> open-threads) were NOT present in this teammate's branch workspace — only `solutions/`.
> Teams `contextMode: branch` did not carry uncommitted leader work. Review conducted from
> the task description (which embeds the gotcha/decision substance verbatim) + actual source.
> **Flag this to leader: findings must be committed before delegating branch-context workers,
> or use `contextMode: fresh` + inline context.**

## Verdict summary

| # | Challenge | Verdict | One-line |
|---|-----------|---------|----------|
| 1 | Orphan sidecar cleanup | **INVALIDATE** | `reapOrphanedLocks` only matches `.lock`; `.sessions.json` never reaped → unbounded dead-goal files. |
| 2 | G4.1 RMW race | **CONFIRM (with caveat)** | Sidecar has effectively ONE writer (the holder); reaper doesn't touch it. But B's acquire must read A's sidecar — see #3. |
| 3 | Crash handoff A→B | **PARTIAL** | Atomic write saves us from *corruption*, but A's final `lastWorkedAt` can be lost (≤60s stale). Acceptable, must be documented. |
| 4 | New gotchas from B | **PARTIAL** | Two-file consistency window; reap-scope fragility; release/reap ordering. All fixable, none free. |
| 5 | LD5 owner-excluded simpler? | **CONFIRM (defensible)** | Read-time merge is trivial and infrequent; write-side dedup hazard is real. LD5 holds — but only if "current owner" is ALWAYS derivable from `.lock`. |

**Bottom line:** Option B resolves G5.1/G5.2/G5.3 **by accident** (reap's `.lock`-only
matching), not by design. The flip is correct BUT underspecified: without explicit rules
for (a) sidecar orphan cleanup, (b) reap/release NOT touching the sidecar, (c) B reading
A's sidecar on acquire, B re-introduces the very problems it was meant to solve. **Do not
implement LD3 as-is — add the 3 missing rules below (→ propose LD6/LD7/LD8).**

---

## Challenge 1 — Orphan sidecar cleanup → INVALIDATE

**The claim:** LD3 gives history "its own durability boundary" so it survives release/reap.

**The reality:** `reapOrphanedLocks` (extensions/goal-lock.ts:344-376) iterates `.locks/`
and deletes entries where `entry.endsWith(".lock")` AND goalId not in active set. A
`.sessions.json` file **never matches `.endsWith(".lock")`** → it is NEVER reaped.

Consequences:
- Every goal that is ever deactivated leaves a permanent `.sessions.json` corpse.
- Over months/years, `.locks/` accumulates one dead history file per retired goal.
- `reapOrphanedLocks` was the "self-cleaning" safety net for `.lock`; the sidecar has no
  equivalent. The durability "win" of B is also a **leak**.

**This is not a minor edge case.** It's the direct, unavoidable consequence of putting
history in a separately-named file that the existing reaper doesn't know about. The
gotcha-coverage (G5.1 mitigation: "separate file") solved "reap deletes history" by making
reap IGNORE history — which is the opposite of "handled."

**Fix (propose LD6 — sidecar lifecycle):**
- `reapOrphanedLocks` MUST also reap `<goalId>.sessions.json` when goalId not in active set.
- Symmetric: extend the `.endsWith()` check to a list: `.lock`, `.sessions.json`.
- OR: nest history under a per-goal subdir `.locks/<goalId>/` so reaping a goalId = `rm -r`.
  (Cleaner long-term; bigger refactor.)

Severity if unfixed: **Rank 4** (slow leak, not correctness, but unbounded and invisible
until disk fills). The "personal agent, handful of goals" mitigation does NOT apply — this
is per-retired-goal, not per-active-goal.

---

## Challenge 2 — Does separate file solve G4.1 (RMW race)? → CONFIRM (with caveat)

**G4.1 original worry:** reaper + acquirer race on the same file, lost-update.

**Under LD3 + LD2 (only holder writes sidecar):**
- The sidecar has exactly ONE writer at any time: the current lease holder.
- The reaper (`reapStaleLock`, `reapOrphanedLocks`) only touches `.lock` files — it does
  NOT read or write `.sessions.json`. (Verified in source: both reap functions call
  `lockPath()` / match `.lock`.)
- Two sessions cannot simultaneously hold the lease (that's the whole point of the mutex).
- Therefore the sidecar has no concurrent writers → **no RMW race on the sidecar.**

**Caveat — this holds ONLY IF:**
1. Every sidecar write site is gated by "I am the current holder" (sessionId ==
   lock.owner.sessionId). This is G3.1's enforcement — must be at the WRITE site, not
   assumed. If a non-holder ever writes the sidecar, the single-writer invariant breaks
   and G4.1 returns.
2. The lease mutex itself is correct (it is — acquireLock re-reads to verify ownership).

So G4.1 is resolved for the sidecar **by inheritance from the lease mutex**, not by the
file split per se. The file split is necessary (so the reaper doesn't clobber it) but not
sufficient (the holder-only-write rule is the actual guarantee). **G3.1 enforcement is
load-bearing for G4.1's resolution.** If G3.1 is skipped, G4.1 is NOT resolved.

**G4.4 (spread-miss regression):** same logic. Single writer → no stale-snapshot overwrite
from a peer. A torn SELF-write is covered by atomic rename. CONFIRM — but again contingent
on G3.1 + atomic write (G5.2 mitigation).

---

## Challenge 3 — Crash handoff: A crashes, B acquires → PARTIAL

**Scenario:** A holds lease, writes sidecar periodically. A crashes (kill -9 / OOM / power).
A's `.lock` goes stale. B's `acquireLock` reaps it and acquires. B now wants to carry A's
history forward.

**Questions the design does NOT answer:**
1. Does B read A's sidecar on acquire? (Must, else B starts with empty history → G5.3
   returns in a new form: "history = current lease only.")
2. What if A's last sidecar write was torn?

**Answer to (2) — atomic write saves us:** `writeLockAtomic` (tmp + rename) means a torn
write leaves EITHER the prior-valid file OR no file (tmp orphaned, final untouched). So B
reads either A's last-good state or empty. No corruption. **G5.2 mitigation holds.**

**Answer to (1) — gap:** The flip to B does not specify that `acquireLock` must read the
sidecar. If acquireLock only writes `.lock` (as today) and the sidecar is written separately
on first heartbeat, then between B's acquire and B's first sidecar write, the sidecar still
reflects A's data — which is actually FINE (A's history is what we want preserved). The risk
is the reverse: if B's first action is to OVERWRITE the sidecar with `[B]` (fresh array),
A's history is wiped. **The upsert-on-acquire (LD4) must read-merge-write, not
construct-fresh.** This is the same spread-miss hazard (G4.4) but at the acquire boundary.

**Residual loss:** A's final heartbeat (the torn one) is lost. A's `lastWorkedAt` is stale
by up to one lease-refresh interval (60s). For a "who worked on this, roughly when" resume
feature, this is acceptable. **Document it.**

**Fix (propose LD7 — acquire reads sidecar):** `acquireLock` (or a wrapper) reads
`.sessions.json`, upserts self, writes. Never constructs a fresh array when a sidecar
exists. Empty/no-file is the only legitimate "fresh start."

Severity if unfixed: **Rank 4** (history silently resets on every lease transfer = G5.3
in disguise). This is the failure mode B was supposed to prevent.

---

## Challenge 4 — New gotchas Option B introduces → PARTIAL (3 new, all fixable)

### NB1 — Two-file consistency window
Between B's `acquireLock` success and B's first sidecar write, the on-disk state is:
`.lock` says owner=B; `.sessions.json` says last-writer=A. A reader computing "all sessions
ever" from both files sees a transient where B is owner but not yet in history. Since LD5
excludes current owner from the array, this is actually CONSISTENT (owner=B is in `.lock`,
A is in array). But a reader that doesn't consult `.lock` (e.g., a future tool that only
reads sidecars) would miss B. **Mitigation:** document that "current owner" lives ONLY in
`.lock`; the sidecar is "everyone who has RELEASED." Readers needing "all" must merge.

### NB2 — Reap-scope fragility (the accident)
G5.1 is resolved only because `reapStaleLock`/`reapOrphanedLocks` match `.lock` and ignore
`.sessions.json`. This is **implicit** — a future contributor adding "clean up associated
sidecar on reap" would re-introduce G5.1. **Fix:** explicit comment + test asserting reap
does NOT touch `.sessions.json`. This invariant is load-bearing; make it visible.

### NB3 — releaseLock / reapStaleLock ordering vs sidecar
`releaseLock` (extensions/goal-lock.ts:312-340) deletes `.lock`. Under LD3, the releasing
session should FIRST stamp itself into the sidecar (freeze lastWorkedAt), THEN delete
`.lock`. If it deletes `.lock` first and crashes before the sidecar write, self's final
entry is missing — minor (last heartbeat is within 60s). If it writes sidecar first then
crashes before deleting `.lock`, the lock goes stale and is reaped later by B — fine.
**Recommended order:** sidecar-write-then-unlink-lock. Document. (Low severity either way;
calls for a spec, not a panic.)

**Net:** B introduces 3 new edge cases, all spec-level (cheap to fix with comments +
ordering rules), none requiring architectural rework. Acceptable — but they MUST be
specified or the implementation will guess wrong.

---

## Challenge 5 — Is LD5 (owner excluded) actually simpler? → CONFIRM (defensible, not obvious)

**LD5 claim:** excluding current owner from the array avoids G4.2 (two sources of truth)
and G4.3 (lastWorkedAt vs heartbeatAt desync).

**Devil's advocate counter:** excluding the owner forces every "all sessions ever" reader
to merge `[owner] + sessions[]`. Is the read-time cost worth the write-side safety?

**Analysis:**
- **Read frequency:** /goal-list, goal widget, trace — all user-triggered, infrequent.
  Merge cost = O(1) prepend + a `heartbeatAt` comparison. Negligible.
- **Write frequency:** acquire/refresh(60s)/release — but the owner's live state is in
  `.lock.heartbeatAt` (already written every refresh). Excluding owner from the sidecar
  means refresh does NOT need to touch the sidecar at all — only acquire (on first hold)
  and release (freeze). **LD5 makes refresh a no-op on the sidecar.** This is a real win:
  the hot path (60s heartbeat) does zero sidecar writes.
- **G4.2/G4.3 resolution:** with owner excluded, there's no duplicate of owner data → no
  drift. CONFIRM.

**But — LD5 has a hidden dependency:** it only works if "current owner" is ALWAYS readable
from `.lock`. If `.lock` is missing/stale/reaped but the sidecar exists (NB1 window,
or post-deactivation), there is no "current owner" to merge. The sidecar alone gives
"everyone who ever released" — which for a dead goal is actually the complete history.
So LD5 degrades gracefully: live goal → owner in `.lock` + released sessions in sidecar;
dead goal → sidecar is the whole story. **CONFIRM LD5 holds.**

**One nuance worth locking:** when a session is the current owner AND appears in the
sidecar from a PRIOR hold (it held, released, re-acquired), the sidecar entry is stale
relative to the live owner. LD4 (upsert by sessionId) means re-acquire would UPDATE the
sidecar entry — but LD5 says current owner is excluded. Contradiction? Resolution: on
acquire, if self is already in the sidecar (prior hold), the entry stays frozen with the
PRIOR lastWorkedAt; the current hold is tracked only via `.lock`. On release, upsert
freezes the NEW lastWorkedAt. So during a hold, the sidecar shows the PREVIOUS tenure's
end-time, not the current. Document this or readers will be confused ("why does my
lastWorkedAt show 2h ago when I'm active now?").

---

## New gotchas the flip ITSELF introduces (meta)

### M1 — The flip was justified by G5.1, but G5.1's mitigation is implicit
The gotcha-coverage ranked G5.1 as Rank 5 ("reap destroys history"). The flip to B
"resolves" it by making reap ignore the sidecar. But this resolution is **not encoded in
any decision** — LD3 just says "separate file." The actual invariant ("reap MUST NOT touch
sidecar") is unstated. This is the same class of drift that caused the original bug
(decisions under-specified → implementer guesses). **Add to LD3 or new LD: "reap functions
must never read/write/delete `.sessions.json`."**

### M2 — No decision addresses "who reads the sidecar on acquire"
LD2 says writes happen at acquire/refresh/release. It does NOT say acquire READS the
existing sidecar to preserve history. Without that, the upsert in LD4 has nothing to upsert
INTO on a fresh acquire (B doesn't know A's history exists). This is Challenge 3's root.
**LD7 needed.**

### M3 — Orphan cleanup (Challenge 1) has no owner
No LD addresses dead-goal sidecar cleanup. `reapOrphanedLocks` is the natural home but it's
not specified. **LD6 needed.**

---

## Proposed new locked decisions (for leader to ratify)

- **LD6 — Sidecar orphan cleanup.** `reapOrphanedLocks` reaps both `.lock` AND
  `.sessions.json` for goalIds not in the active set. (Or: per-goal subdir model.)
- **LD7 — Acquire reads sidecar.** `acquireLock` (or wrapper) reads `.sessions.json` before
  writing; upserts self into existing array; never constructs a fresh array when a sidecar
  exists. Prevents silent history reset on lease transfer.
- **LD8 — Reap/release invariant: sidecar untouched by reap, release writes-then-unlinks.**
  `reapStaleLock`/`reapOrphanedLocks` MUST NOT touch `.sessions.json` (preserves G5.1
  resolution). `releaseLock` writes self to sidecar BEFORE unlinking `.lock`.

Plus reinforcement: **G3.1 (write-site ownership guard) is load-bearing for G4.1/G4.4
resolution under B.** If implementation skips G3.1, the "single writer" invariant breaks
and the RMW race returns. Flag this to the enforcement-designer worker.

---

## What I did NOT challenge (and why)

- **LD4 (upsert by sessionId):** correct, uncontroversial. UUID sessionIds (verified:
  `SELF_SESSION_ID = crypto.randomUUID()` in extensions/goal.ts:253) mean G2.1 is a
  non-issue. LD4 stands as-is.
- **The flip direction (A→B):** correct. G5.1/G5.2/G5.3 genuinely require decoupling
  history lifetime from lease lifetime. B is the right call. The problem is B is
  **underspecified**, not wrong.
- **Schema version (OT6):** fine. Low-risk additive.

---

## Recommendation to leader

1. **Do not implement LD3 as-is.** Ratify LD6/LD7/LD8 first (this review provides drafts).
2. **Make the reap-doesn't-touch-sidecar invariant EXPLICIT** (comment + test). It is
   load-bearing and currently implicit.
3. **Cross-check with rmw-architect worker:** their G4.1 solution may propose flock/CAS on
   the sidecar. That's UNNECESSARY if G3.1 (holder-only-write) is enforced — the lease
   mutex already serializes. Adding flock would be over-engineering. Push back if they
   propose it.
4. **Cross-check with enforcement-designer worker:** G3.1 is now doubly load-bearing
   (resolves G3.1 AND upholds G4.1/G4.4 resolution). It must be a hard runtime guard, not
   a convention.
5. **Fix the teams-workflow gap:** findings files weren't in my branch. Commit findings
   before delegating branch-context workers, or use fresh+inline.

The flip is sound. The spec is incomplete. Three small decisions (LD6/LD7/LD8) close the
gap. Without them, B re-introduces G5.1 (via orphan leak) and G5.3 (via acquire-not-reading)
in new clothing.
