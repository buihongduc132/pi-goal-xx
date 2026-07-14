# Lane A — feat-stack skip report (2026-07-14)

Repo: `buihongduc132/pi-goal-xx`. Scope: 4 `feat/*` branches assigned to Lane A.
Verdict: **all 4 branches are redundant — their feature work is already on `main` via squash-merge PRs.** No new stacked PR is needed (it would be an empty diff for the feature work). This file documents each branch per the "document skipped branches" mandate.

## How "already on main" was determined

For each branch: located the squash-merge commit on `main` that absorbed the branch's commits; confirmed the feature files exist on `main`; confirmed `main` is at-or-ahead of the branch on feature content (NOT a strict line-count superset — see "Caveat" below).

> **Caveat (honest):** `main` is **not** a literal line-count superset of every file. `feat/unified-prompt-config` carries 6 `console.*` defensive log lines in `extensions/goal.ts` (4 `console.warn` + 2 `console.error`, e.g. `"heartbeat refresh failed..."`, `"syncGoalTools error"`) that `main` does **not** have, because `main` deliberately replaced ad-hoc `console.warn` with structured tracing (`logGoalTrace` / `traceStep` / `goalTraceLogPath`) via PRs #26 (`feat(tracing): unified crash-safe logging`) and #28 (`feat(tracing): OTel-compatible JSONL`). This is intentional logging-architecture evolution, **not lost feature work**. All `unified-prompt-config` *feature/intent* code (unified 6-mode prompt resolver, command-hook-loader, contract-templating, tool-prompt-wrapper, settings UI, auditor delegation) is present on `main`. So the correct statement is: **"100% of each branch's feature work is on `main`; minor incidental logging drift exists and was superseded by structured tracing."**

## Per-branch verdicts

| Branch | Commits ahead of base | base date | main ahead | Squash PR on main | Feature on main? | Recommendation |
|---|---|---|---|---|---|---|
| `feat/surface-start-goal` | 2 | 2026-07-12 (`1111059`) | 9 | `cd42dd8 feat(goal): surface start_goal tool hidden from subagents (#29)` | ✅ yes | redundant — leave alone; leader may delete stale branch |
| `feat/drafting-prompt-override` | 3 | 2026-07-10 (`3a7dd08`) | 22 | `4ce37ac feat(drafting): migrate goal-prompt-resolver to unified resolver with override mode (#20)` | ✅ yes | redundant — leave alone; leader may delete stale branch |
| `feat/goal-custom-prompt` | 3 | 2026-07-04 (`74061cb`) | 55 | `3590236 feat(goal-prompt): configurable custom prompt injection (#8)` | ✅ yes | redundant — leave alone; leader may delete stale branch |
| `feat/unified-prompt-config` | 24 | 2026-07-05 (`3590236` = PR #8) | 54 | `f813f68 feat: unified-prompt-config (#9)` + `f499485 chore(openspec): archive unified-prompt-config (#11)` | ✅ yes | redundant — leave alone; leader may delete stale branch |

## Completion % and merge/skip

- None of the 4 branches is "<=80% complete" in the sense of *unfinished* — each is a **finished, already-merged** feature. They are skipped because they are **redundant** (superseded by `main`), not because they are incomplete.
- Per the DOD, <=80% branches must NOT be merged. There are no such branches in Lane A's scope — all 4 are 100% and already on `main`. Nothing is merged, nothing is clobbered. No `fix/*` branch (Lane B scope) was touched.
- `main` builds clean: `npx tsc --noEmit` → exit 0.
- `main` tests green: `npm test` → **0 fail** (test-runner count is nondeterministic across runs: observed 1156–1189 tests; consistently 0 fail / 0 cancelled).

## Recommendation summary

- **No PR.** A stacked PR would carry only the already-merged feature work → empty/duplicate. The correct consolidation outcome is the finding itself.
- **Branch cleanup (leader decision):** the 4 local `feat/*` branches and their worktrees are stale. Safe to delete once the leader confirms (not done here — deletion is a leader-owned call). The remote already reflects `main`.
- **Lane B (`fix/*`) untouched** as required.
