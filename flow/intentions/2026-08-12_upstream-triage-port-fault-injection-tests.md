# Intention: upstream triage + port of fault-injection tests (55d4b46)

- date: 2026-08-12
- upstream: tmonk/pi-goal-x
- upstream range triaged: v0.19.0 → v0.27.4 (68 commits, no shared git ancestor — fork base is a squash `210d2cb`)

## User decision

Full upstream diff triaged into 6 groups (A widget fixes, B perf, C reliability, D features, E rewrites, F tooling).
User: take ONLY `55d4b46` (fault tests), skip everything else. No functional/behavioral change to our fork.

## Why 55d4b46 only

- Tests-only commit — zero runtime surface change.
- Directly relevant to our crash-forensics history (`flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md`, `flow/bugs/2026-07-14_pi-process-exits-after-completion.md`): proves atomic-write + ledger + lock invariants under simulated crashes.

## Why the rest was skipped

| Group | Reason |
|---|---|
| Widget/scrollback + questionnaire fixes | Built on pi-tui 0.84; we're on 0.74. Requires SDK bump first — rejected for now |
| Pool snapshot perf | Upstream has cache layer; ours has no caches (fresh disk reads) — perf need unproven here |
| Ledger checkpoint/`/goal-status`/lock-retry | Collides with our lease-based lock + different ledger impl; port concepts later if needed |
| Runtime overhaul / dashboard rewrite / review-plan optimisations | Wholesale rewrites incompatible with our auditor/lock/prompt-config layers |
| Esc-stops-work, `/goal-unfocus` | We deliberately reworked these paths (`d7fd46a`, focus-lock series) |
| CI/packaging/engines | Upstream CI = their repo; ours differs (mise tasks, deploy pipeline) |

## Adaptations made (upstream API → our API)

1. `storage/goal-lock.ts` `acquireGoalLock(ctx, id).release()` → `extensions/goal-lock.ts` `acquireLock(cwd, id, self, leaseMs)` + `releaseLock(cwd, id, self)` (lease-based, `LockOwner{sessionId,pid}`).
2. `invalidateGoalPoolCache()` / `invalidateGoalLedgerCache()` dropped — our persistence layer has no in-process caches.
3. `loadLedgerState()` → `reconstructGoalLedger(readGoalLedger(ctx).events)` (no checkpoint system).
4. Upstream test 5 (`diffGoalRefreshState` cross-process cache pickup) NOT ported — we have no `/goal-refresh` cache-diff feature.
5. Stale-lock fixture rewritten for our lock file format (`{goalId, owner, acquiredAt, expiresAt, heartbeatAt}`).

## Result

- `tests/fault-injection.test.ts` — 5 tests, 3 suites, all pass:
  1. torn goal-file write never observed as partial (malformed detection, pool exclusion, atomic restore)
  2. multi-process concurrent writes never tear (one complete writer wins, real child processes)
  3. torn ledger tail counted malformed, valid events intact, reconstruction uncorrupted
  4. stale lock (dead pid + lapsed lease) reclaimed promptly
  5. live-holder contention fails fast + bounded + reports holder (real child process)
- `tsc --noEmit` clean. Full suite failures before/after = pre-existing flaky auditor tests (verified same file set run-to-run variance), unrelated.

## Open threads

- SDK 0.74→0.84 bump remains the gate for widget/questionnaire/scrollback fixes — revisit separately.
- Goal-prompt re-injection spam (continuation prompt full objective every turn) still open — upstream `58a17a6` (configurable objective length) noted as candidate when that work happens.
