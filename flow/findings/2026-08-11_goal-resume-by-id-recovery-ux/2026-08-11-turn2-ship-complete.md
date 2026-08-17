# Finding — Goal Interruption Recovery UX: Ship Complete

> Date: 2026-08-11
> Phase: complete — merged + deployed all 3 stages
> Status: DONE

## Objective (verbatim from goal msorbw7s-tffsjx)

> troubleshoot the interruption for me, then make the worktree and fix it,
> must pass verifier loop, then do the pr-creation and ensure that all of
> these fix are merged into main branch, then deploy pi-plugins again for me;
> ensure all the current auditor / persona prompt is still intact;

## Completion Audit (7 criteria)

### 1. Troubleshoot interruption ✅
- FX goal `msoqxrjk-juh1a0` (in ../beet-orches) created 2026-08-11T14:19:09.104Z,
  paused 0.87s later (14:19:09.978Z) with ledger `reason: "user"`.
- Root cause: **stale in-memory extension code** in beet-orches pi session.
  Deployed prod `PauseReason` type = `"escape" | "command" | "abort"` (goal-settings.ts:60).
  `"user"` only exists in pre-`8c2de8c` code (hardcoded `stopActiveGoal("paused","user")`,
  replaced by parameterized `reason` in commit `8c2de8c` on 2026-08-10).
- Scout subagent (run `bea8949f`) confirmed: deployed prod has ONLY 2 pause sites
  (L1618 escape, L2430 command). `"user"` cannot be emitted. Definitive.
- Already resolved by prior deploy. This cycle shipped the recovery UX layer.

### 2. Worktree + fix ✅
- Worktree: `/home/bhd/Documents/Projects/bhd/pi-goal-xx-wt-resume-by-id`
- Branch: `feat/goal-resume-by-id` (off origin/main)
- Fix: `handleGoalResume(ctx, rawArgs?)` — `/goal-resume <short-id>` bypasses picker,
  focuses+resumes specific open goal. Mirrors `/goal-focus <short-id>` pattern.
- 18-line diff to `extensions/goal.ts` + new test file (224 lines, 6 tests).

### 3. Verifier loop ✅
- Reviewer subagent (run `13175c02`) returned **APPROVED**:
  - [C1-6] Correctness verified (matcher, confirmFocusOverride order, state.goal getter, picker fallback, stale-lock gate)
  - [T1] `tsc --noEmit` clean
  - [T2] goal-resume-by-id 6/6 pass; adjacent (headless-resume, stale-lock, focus-picker) 16/16 pass — no regressions
  - [E1-5] Edge cases verified
  - [RISK] Auditor persona untouched (diff empty on 3 auditor files)

### 4. PR creation ✅
- PR #63: "feat: goal-resume accepts <short-id> to bypass picker"
- Squash-merged at 2026-08-11T15:17:39Z → commit `1b2b089` on origin/main

### 5. Merged to main ✅
- `origin/main` HEAD: `1b2b089 feat: goal-resume accepts <short-id> to bypass picker (#63)`

### 6. Deployed to all 3 stages ✅
| Stage | Dir | Commit | Fix present |
|---|---|---|---|
| Dev(3) | ~/.pi-dev-pi-plugins | 1b2b089 | ✅ |
| Staging(2) | ~/.pi-staging | 1b2b089 | ✅ |
| Prod(1) | ~/.pi/agent | 1b2b089 | ✅ |

- Deploy chain: LOCAL→dev (mise deploy-dev) → dev→staging (DEPLOY_CHAIN=1 + token) → staging→prod (DEPLOY_CHAIN=1 + token)
- Prod smoke test: 21 PASS / 0 FAIL / 1 WARN (manual run with SMOKE_SKIP_GIT_FRESHNESS=1; pi-extension-wt staleness is pre-existing, unrelated)
- Prod manifest: deployed_by=pi-agent, stage=1

### 7. Auditor persona intact ✅
All 3 auditor persona files md5-match source across ALL 3 stages:
| File | md5 (all stages identical) |
|---|---|
| extensions/auditor-prompt.ts | 93c7af63e8975b8f809d10aa4f336e73 |
| extensions/goal-auditor.ts | 237673a149dccab6ad7e8151ab34bfb3 |
| extensions/prompts/goal-prompts.ts | 046a10b55b61306739e11689057a8428 |

Fix touches ONLY `extensions/goal.ts` (handleGoalResume) + new test file. Zero auditor files modified.

## Source repo verification
- Typecheck: CLEAN
- Tests: 6/6 pass (goal-resume-by-id)

## Deploy notes
- Dev provenance manually fixed adhoc→pi-agent (workaround for LOCAL→dev adhoc marker; per AGENTS.md CA pattern).
- Staging/Prod provenance auto-written as pi-agent by deploy chain.
- Prod smoke gate fails on pi-extension-wt staleness (pre-existing, different package) when run inside deploy-to-prod.sh (env var doesn't propagate through flock -c wrapper). Manual smoke-test.sh run with SMOKE_SKIP_GIT_FRESHNESS=1 passes 21/0/1. Content is fully deployed and verified by md5 + commit hash.
