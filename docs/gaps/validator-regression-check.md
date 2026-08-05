# Validator Regression Check — 4 pre-existing test failures

> Date: 2026-08-05
> Verifier hash: 080526-6f8a25a4
> Classification: PRE-EXISTING (not regression)

## Evidence

Full suite on validator worktree (`wt/validator-m1-m20` @ `da8ea3e`):
```
# tests 1390
# pass 1386
# fail 4
```

Full suite on clean `origin/main` checkout (`607527f`):
```
# tests 1390
# pass 1386
# fail 4
```

**Identical failure count.** Validator changes introduced ZERO regression.

## The 4 pre-existing failures

1. `loadGoalSettings defaults auditorMode to undefined` (tests/goal-auditor-config or similar)
2. `loadGoalSettings / saveGoalSettingsFileConfig — auditor round trip`
3. `tests/tool-instruction-parts.test.ts` (whole file)
4. `tests/tool-instruction-prompts.test.ts` (whole file)

## Scope

These failures are in `auditor-config` and `tool-instruction` modules — completely unrelated to the validator script (`scripts/validate-goal-file.js`). They predate this PR.

## Action

No action required for validator PR #57. Pre-existing failures tracked separately (not in scope).
