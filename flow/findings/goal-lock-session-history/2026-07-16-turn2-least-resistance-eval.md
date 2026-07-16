# Explore Turn 2 — least-resistance-eval

> Date: 2026-07-16
> Phase: constraint-driven re-evaluation
> Status: assistant converged on Option A, offered proposal, user hasn't accepted yet

---

## [user]

> **[user]** (verbatim — trust chain L1)
>
> No tools calls , just need to know like "whom working on this" to easily resume it later ; --- give me least resistance while durable , reliable approach for me ;

---

## [assistant]

Re-eval with constraint "ever-held-the-lease, no tool writes":

**→ Option A (same file). Least resistance wins.**

My earlier B-lean (reap erases history) is moot: `reapOrphanedLocks` only fires when goal deactivated — don't care. `reapStaleLock` fires before B's acquire writes, but acquire does **read → reap → write**, so B carries forward A's array. History survives owner rotation.

```
GoalFocusLock {
  ...existing...
  sessions?: Array<{ sessionId: string; lastWorkedAt: string }>  // optional, back-compat
}
```

**Why A is the right call now:**
| | A (same file) | B (sidecar) |
|---|---|---|
| Diff size | ~15 lines, 1 file | ~80 lines, new read/write/reap paths |
| Write contention | none (mutex = 1 writer) | none (same) |
| Owner rotation | acquire reads+appends+writes | separate, must keep in sync |
| Durability | survives stale-reap (read-before-reap) | survives everything |
| Back-compat | add `?`, default `[]` | separate file, transparent |

Durability gap (B survives goal deactivation) is **irrelevant** to "resume later" — you don't resume deactivated goals.

**Mutation points — all in `goal-lock.ts`, all existing paths:**

```
acquireLock  → upsert self.lastWorkedAt = now    (read old array first → append → write)
refreshLease → bump self.lastWorkedAt = now      (every 60s heartbeat — that's the "last worked")
releaseLock  → stamp self.lastWorkedAt = now     (final, before giving up)
```

`lastWorkedAt` = last heartbeat while holding lease. For resume: "A worked on this 2h ago, B 10min ago → ping B."

**Reliability comes free:** atomic write, fail-open fs, identity-checked owner all already exist. The array just rides along on the existing lease write.

**One real decision:**
- `sessions` **includes current owner** (dups the `owner` field) — one source of truth, no special-case.
- vs excludes owner (array = previous owners only) — `owner` is canonical for "now", array for "history".

I'd include owner. Simpler reads.

**Edge that bites if missed:** `refreshLease` rewrites whole file every 60s. If `sessions` field dropped from the rewrite (spread-miss), history silently lost. Must spread **after** reading existing, not construct fresh:
```ts
const updated = { ...existing, sessions: upsert(existing.sessions, self, now) };
```
not
```ts
const updated = { ...existing, expiresAt, heartbeatAt };  // sessions carried via spread — OK but verify shape
```

Ready → proposal?

---

### Status at end of turn 2

- User constraint (no tool calls; least-resistance + durable + reliable) **resolves Q1 → A**, **Q2 → lease-holder history only**.
- Q3 (owner dedup) **still open** — assistant recommends "include owner", awaiting confirmation.
- Implementation gotcha flagged: spread-miss in `refreshLease` rewrite.
- Proposal offered, not accepted.
- Next: `./2026-07-16-turn2a-gotcha-same-file-coupling.md` — gotcha coverage invalidates this choice.

---

**Callback (added 2026-07-16 after teams resolution):**
The "least resistance → A" conclusion here was OVERTURNED by gotcha-coverage in turn2a.
Same-file (A) is fundamentally broken for the user's stated use case ("resume later")
because stale-lock reap deletes the `.lock` file → wipes ALL session history (G5.1).
The user's "durable + reliable" constraint overrides the "least resistance" preference.
See LD3 (supersedes LD1) + turn2b for the resolution.
