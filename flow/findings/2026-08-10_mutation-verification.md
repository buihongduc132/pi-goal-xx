# pi-goal-xx mutation verification

> **Provenance note (PR #67):** This is a historical session record ported from the
> `mutation/pi-goal-xx` verification worktree (2026-08-10). The paths below
> (`src/repositories/pi-goal-xx/mutation-check.yml`,
> `reports/pi-goal-xx/typescript/mutation.json`) refer to the ORIGINAL mutation
> session's workspace layout and DO NOT exist in this repository — treat the
> numbers as historical session data, not as claims reproducible from this repo.
> This PR's change (tool-aware lifecycle prompt instructions) postdates and is
> separate from the verified scope documented below.

- Scope: seven small extension modules configured in `src/repositories/pi-goal-xx/mutation-check.yml` (path from the original session's workspace, not present in this repo).
- Baseline reuse: broad suite remains affected by pre-existing Pi runtime/auditor API drift; scoped dedicated tests are the mutation gate.
- Scoped tests: 136 pass, 0 fail.
- Scoped c8 coverage: 99.59% statements and lines, 92.45% branches, 100% functions.
- Fresh Stryker: 345 killed, 37 survived, 0 timeout, 0 error; aggregate score 90.31%.
- Per-file average score: 92.50% across seven configured files.
- Normalized report: `reports/pi-goal-xx/typescript/mutation.json` (path from the original session's workspace, not present in this repo); 37 survivors classified as coverage gaps because command runner has no per-test coverage mapping; no weak-test entries claimed.
- Remaining survivors are documented by raw Stryker output and are not hidden by threshold configuration.
- Branches: `mutation/pi-goal-xx` worktrees are based on repository `main` commits; dedicated worktrees preserve existing dirty main work.
- Final verifier loop rechecked enrollment, branch ancestry, typecheck, targeted tests, scoped coverage, mutation aggregate, average score, and normalized-report state counts.

## Accepted testing baseline (user-provided)

```
Coverage [E3]:
- extensions/goal.ts: 70.5% stmts (3476/4928)
- 27 uncovered stmts near my changes = pre-existing (audit dialog, reconciliation edge cases)
- My changes = removed code → can't decrease coverage, only increase it
- Zero tests cover abort-pause behavior (the code I removed)

Final answer:

┌────────────────────────────┬───────────────────────────────┐
│ Metric                     │ Value                         │
├────────────────────────────┼───────────────────────────────┤
│ Tests broken by my changes │ 0                             │
├────────────────────────────┼───────────────────────────────┤
│ Pre-existing failures      │ 71 (auditor API drift)        │
├────────────────────────────┼───────────────────────────────┤
│ Total suite                │ 1305 tests, 1234 pass (94.6%) │
├────────────────────────────┼───────────────────────────────┤
│ goal.ts coverage           │ 70.5% stmts                   │
├────────────────────────────┼───────────────────────────────┤
│ Tests covering abort-pause │ 0 (gap)                       │
└────────────────────────────┴───────────────────────────────┘

Callsout [CA1]: No test coverage for abort-pause behavior. Should add tests for:
- turn_end with aborted msg → goal stays active (new behavior)
- agent_end with ctx.signal.aborted → goal stays active (new behavior)
- User Esc → goal pauses (unchanged, still tested implicitly)

Callsout [CA2]: 71 pre-existing auditor test failures = pi-core API drift (createSession mock signature). Separate issue, not blocking.
```
