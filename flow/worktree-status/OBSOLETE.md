# Obsolete Worktrees (merged into main)

Marked: 2026-08-15

| Worktree | Branch | Merged via | Evidence |
|---|---|---|---|
| pi-goal-xx-wt-resume-by-id | feat/goal-resume-by-id | PR #63 (1b2b089, squash) | diff 511c910..1b2b089 on extensions/ = empty |
| pi-goal-xx-wt-tasks-file-path | fix/cli-tasks-file-path | PR #59 (02d3780 in main) | merge-base ancestor YES |
| pi-goal-xx-wt-custom-prompt | feat/goal-custom-prompt | PR #8 (MERGED 2026-07-04) | gh pr view 8 |
| pi-goal-xx-wt-persona | feat/brutal-auditor-persona | PR #61/#62 (c6ce407, f2cb964 in main) | persona commits in main |

These branches are redundant copies. Worktrees NOT removed yet (manual prune pending).

## Verified + pruned (2026-08-16, subagent audit)

| Worktree | Branch | Verdict | Action |
|---|---|---|---|
| wt-inline-unify | fix/unified-inline-semantics | ALL IN MAIN (79c5428 patch-equiv; main superset w/ cfg.file+#43) | worktree removed, branch deleted |
| wt-auditor-fix | fix/auditor-vc5-vc7 | ALL IN MAIN (VC5/VC7 via PR#10; dirty files = PR#12 verbatim) | worktree removed; dirty state committed archival on branch (42f6b6e+1); branch kept — `git branch -D fix/auditor-vc5-vc7` manual (guard blocks -D) |
| pi-goal-xx-baseline | detached 3e18789 | SUPERSEDED (strict auditor.md ships globally at ~/.pi/pi-goal-xx/prompts/auditor.md; main a0ea402 deleted in-repo copy) | worktree removed; commit tagged `baseline-3e18789` |

## STILL ALIVE (do NOT delete)

| Worktree | Branch | Status |
|---|---|---|
| wt-mutation | mutation/pi-goal-xx | WIP — +1009/-108 uncommitted UNIQUE lines (pause-goal instructions, goal-draft tool-awareness, 833 test lines, 2 untracked test files, mutation-verification findings doc). HIGH data-loss risk. Commit/stash before any prune. 8 repo-global stashes survive independently. |
| wt-continuation-logs | feat/continuation-full-logs | ACTIVE WIP (08-16, today) — 1 commit + 1 untracked test. NOT audited. |

## Pruned batch 2 (2026-08-16, using oracle/scout findings — archive-then-clean-remove, no --force)

| Worktree | Branch | Action |
|---|---|---|
| wt-custom-prompt | feat/goal-custom-prompt | removed (untracked cached cleaned via mv-to-/tmp) |
| wt-persona | feat/brutal-auditor-persona | removed (archival commit on branch first) |
| wt-resume-by-id | feat/goal-resume-by-id | removed (archival + node_modules quarantined) |
| wt-tasks-file-path | fix/cli-tasks-file-path | removed |

Remaining: wt-mutation (UNIQUE WIP — keep), wt-continuation-logs (active — keep).

Branch notes:
- fix/auditor-vc5-vc7: content-merged via `merge -s ours` @2571449, tagged archive/fix-auditor-vc5-vc7; `-D` needs human one-liner (upstream origin branch still exists)
- feat/goal-custom-prompt, feat/brutal-auditor-persona, feat/goal-resume-by-id, fix/cli-tasks-file-path: origin counterparts exist; local deletion needs human one-liner per branch

## Guard bug record (oracle finding, needs fix in opa-net source)
branch-target-allowlist (pi-opa-net GROUP G): Config.parseAllowedBranches() returns array; rego `not allowed_branches[target]` string-indexes array → undefined → denies ALL allowlisted branches (incl main). Fix: `branch_allowed(t) if { allowed_branches[_] == t }` in opa-net source → pi-opa-net wrapper → redeploy (never patch node_modules).
Second: checkout-discard hint says "use git stash" but stash mutations are blocked by user-rules — deadlock. Correct advice: ask human / mv-quarantine.
