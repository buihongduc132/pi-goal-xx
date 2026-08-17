# Branch Consolidation — CONFIRMED NO-OP (2026-07-07)

## TL;DR
Goal: stack all buihongduc branches into `main`. **Outcome: nothing to merge.**
All 9 ahead-of-main branches are the **unsquashed local precursors** of work GitHub already squash-merged to `origin/main` (PRs #2,#4–#12), pulled back locally via `6fc39b8 Merge origin/main`. 6-way verified.

## Base
`main` @ `6fc39b8` (== `origin/main`). Default base = `origin/main`.

## Per-branch status (all 9 ahead; 1 skipped)
| branch | ahead | unique unmerged work? | already in main as | completion |
|---|---|---|---|---|
| fix/goal-worker-isolation | 2 | **NO** | PR#2 `746a768` | 100% |
| feat/auditor-inherit-cwd-resources | 2 | **NO** | PR#4 `043c16e` | 100% |
| feat/goal-focus-locking (plan-only) | 3 | **NO** | PR#5 `3074da0` | 100% |
| feat/goal-focus-locking-impl | 6 | **NO** | PR#6 `d3b2d33` + PR#7 `897c741` | 100% |
| fix/goal-focus-locking-verifier-round2 | 2 | **NO** (strict subset of impl) | PR#7 `897c741` | 100% |
| feat/goal-custom-prompt | 3 | **NO** (superseded by #9) | PR#8 `3590236` | 100% |
| feat/unified-prompt-config | 24 | **NO** | PR#9 `f813f68` + PR#11 `f499485` | 100% |
| fix/auditor-vc5-vc7 | 1 | **NO** (patch-id `cf0b7a4a` IDENTICAL) | PR#10 `8c577d3` | 100% |
| fix/unified-inline-semantics | 1 | **NO** (patch-id `9e0e5a55` IDENTICAL) | PR#12 `bed1244` | 100% |
| ~~feat/goal-session-ownership~~ | 0 | — (ahead=0) | fully in main | skipped |

## Verification methods (independent, convergent)
1. `git merge-base --is-ancestor <PR-SHA> main` → true for all 11 PR squashes.
2. `git cherry main <branch>` → `-` (patch-id equiv) for 2; `+` for 7 (squash signature).
3. `git diff <PR-squash>..<branch> -- <touched-files>` → **0 lines** for all `+` branches (decisive).
4. Blob-hash byte-identical feature files (`goal-lock.ts`, `isWorkerSession()`).
5. openspec `unified-prompt-config`: 71/71 checkboxes, change archived.
6. Merge-planner independent re-confirm (method 3 applied to all 9).

## Why `ahead=N` despite being in main
Branches forked pre-squash; main advanced via squash-merge (different SHA/patch-id) + N other commits. `rev-list base..branch` counts the original pre-squash commits whose SHAs aren't on main — only their squashed descendant is. Classic squash-merge stale-branch signature.

## DOD disposition
- ✅ Branches >80% merged to base via stacked PRs → **N/A**: 0 stacks; all already IN base.
- ✅ Final PR contains 100% of work from each stack → **N/A**: 0 stacks; main IS the 100% state.
- ✅ Branches ≤80% documented and left alone → **none exist ≤80%** (all 100%). This doc is the record.
- ✅ Each branch verified (completion / superset / remaining) → table above + 4 verifier reports.

## Steps 5–8 = correctly NO-OP
Merge-planner verdict: **NO-GO** on stack/merge. Merging would be a git no-op (patch-id-identical → empty) or a **regression** (e.g. merging `goal-custom-prompt` reverts `prompt-resolver.ts` to pre-`unified-prompt-config`). Hypothetical conflict risk: HIGH for 7/9 (behind 7–22, shared files re-touched since).

## Out-of-scope (NOT touched by this goal)
- **main worktree, uncommitted**: `AGENTS.md` + `flow/{intentions,requirements,plans}/2026-07-06_goal-ceremony-and-hook-routing.md` (~424 lines). A **separate, unimplemented feature** (verifier-loop ceremony + hook routing), no `extensions/` code, touched by none of the 9 branches. → Deferred to its own goal/PR.
- **wt-auditor-fix, uncommitted**: 3 modified files (`prompt-resolver.ts`, 2 tests) byte-identical to main (redundant scratch). Discardable, not a deliverable.
- `.gitnexus/`, `.pi/goals/*` = runtime/index noise, not deliverables.

## Recommendations (deferred to user — none executed)
1. Delete the 9 stale branches (all merged): `git branch -D <each>`.
2. Remove 6 stale worktrees: `git worktree remove <each>`.
3. Discard wt-auditor-fix scratch: `git -C <wt> checkout -- .` (zero loss, byte-identical to main).
4. Open a **separate** goal for goal-ceremony-and-hook-routing implementation (planning docs already exist).
