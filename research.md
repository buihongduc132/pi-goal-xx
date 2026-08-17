# Research: Solutions for 6 Stuck Patterns

## Summary

Each stuck pattern has a solution that avoids the problem entirely by changing the workflow entry point, not by patching around the failure. The solutions leverage existing pi tooling: git merge-from-main, targeted test gates, test-first planning, deploy manifest reads, scatter-gather intercom, and goal task-list tracking. Every pattern also gets an explicit prevention mechanism (how to catch it earlier next time).

## Findings

### Pattern 1 — Worktree Merge Conflicts

**Root cause (why it keeps happening):** Git refuses to checkout/merge a branch that is already checked out in another worktree (`fatal: 'main' is already checked out`). Worktrees share `.git` but have independent working trees, so merging INTO a branch held elsewhere is structurally impossible. The agent repeatedly attempts the merge inside the worktree because the worktree is where its session cwd lives.

**Concrete fix:** **Merge from the main repo, not inside the worktree.**

```bash
# In the MAIN repo (not the worktree):
git merge <feature-branch>
# Resolve conflicts in main repo context (full history, all refs available)
git push  # or let deploy pipeline handle it
```

Or **cherry-pick** for surgical changes:
```bash
git cherry-pick <commit>  # from main repo, single commit at a time
```

Or use the **deploy pipeline as the merge mechanism** — `mise run deploy-worktree` (LOCAL→4) uses rsync, not git merge. The worktree is a working area; promotion to dev/staging/prod goes through `sync_profile()` which is file-copy, not git-merge. Conflicts are impossible because rsync is source→target overwrite.

**Prevention mechanism:** Pre-flight check before ANY merge: `git worktree list` + `git branch --show-current` in both directories. If target branch is checked out elsewhere → rebase + push (`git push --force-with-lease`) or merge from the repo that holds the branch. Codify one line in AGENTS.md: "NEVER merge into a branch checked out in another worktree — merge from the holder repo or rebase+push."

**Trade-offs:**
- ✅ Gain: No merge conflicts in worktrees. Full git history available for resolution.
- ✅ Gain: Deploy pipeline already bypasses git merge entirely (rsync-based).
- ❌ Lose: Can't test merge resolution in isolation before pushing.
- ❌ Lose: If you need the worktree to be a "merge-ready branch", you must merge from main.

---

### Pattern 2 — Test Runner Assumptions

**Root cause (why it keeps happening):** Agent assumes vitest is universal. Repos mix `node:test`, vitest, jest, bun test. Running vitest against a `node:test` codebase = zero collected tests or mass import failures → "100 files failing" false alarm. The runner is visible in `package.json` scripts but never read first.

**Concrete fix:** **Use the project's actual test runner and gates.**

This project (pi-goal-xx) uses Node's built-in test runner:
```bash
# Correct command (from package.json):
node --experimental-strip-types --test --test-force-exit tests/*.test.ts

# Or the npm script:
npm test

# Type check gate:
npm run check  # tsc --noEmit
```

**For targeted validation** (avoid the "100 files fail" problem):
```bash
# Run ONE test file:
node --experimental-strip-types --test tests/specific-file.test.ts

# Run tests matching a pattern:
node --experimental-strip-types --test --test-name-pattern="keyword" tests/*.test.ts
```

**For pre-audit validation** (already available in pi-goal-xx):
- Use `preAuditHooks` settings to gate on test pass before auditor runs
- Use `verificationContract` on tasks to require test evidence

**Prevention mechanism:** Mandatory first action for any test task: read `package.json` `.scripts` + `rg -l 'from "node:test"|from "vitest"' tests/` to classify the runner BEFORE invoking anything. Document each repo's runner in its QUICK_REFERENCE.md ("Tests: node --test, NOT vitest"). Never invoke a test binary by name without confirming the script entry.

**Trade-offs:**
- ✅ Gain: Tests actually pass. Correct runner = correct results.
- ✅ Gain: Targeted runs give fast feedback on specific changes.
- ❌ Lose: Node test runner has fewer features than vitest (no watch mode built-in, less fancy assertions).
- ❌ Lose: Must know which runner the project uses (read `package.json` first).

---

### Pattern 3 — Plan vs Test Contract Drift

**Root cause (why it keeps happening):** Plans are written before tests are read. Tests (often written first in TDD) encode the real contract Y; the plan encodes X. The agent implements Y to pass tests but the plan doc is never updated — nothing forces the write-back, so the plan rots silently and the next session re-implements X.

**Concrete fix:** **Test-first planning (read tests BEFORE writing the plan).**

Workflow change:
1. Read existing test files for the module being changed
2. Extract the contract from tests (what do they assert?)
3. Write the plan to match the test contract, not the other way around
4. If the plan requires changing the contract, update tests FIRST, then plan

**Using pi-goal-xx verification contracts:**
```json
{
  "taskList": [
    {
      "title": "Implement X",
      "verificationContract": "tests/x.test.ts passes with 0 failures. Run: npm test -- --test-name-pattern='X'"
    }
  ]
}
```

The `verificationContract` field forces the agent to provide evidence matching the contract before `complete_task` succeeds. This makes drift visible — if the contract says "X passes" but tests require "Y", the completion fails.

**Using the auditor as drift detector:**
The completion auditor (independent pi agent) inspects the workspace and verifies every success criterion. If the plan says X but tests require Y, the auditor catches it because it reads both the goal contract and the actual test results.

**Prevention mechanism:** Rule: any test-driven deviation triggers an immediate plan-doc update in the same turn — add a `## Deviations` section to the plan file. Treat tests as spec, plan as intent; when they diverge, the plan loses. Verifier's FIRST check = diff plan claims vs test assertions (`rg` for the contract strings in tests).

**Trade-offs:**
- ✅ Gain: Drift caught at plan time, not implementation time.
- ✅ Gain: Verification contracts make the contract explicit and machine-checkable.
- ❌ Lose: Reading tests first takes 2-5 minutes upfront.
- ❌ Lose: If tests are wrong/outdated, test-first planning inherits the wrong contract.

---

### Pattern 4 — Deploy Path Discovery

**Root cause (why it keeps happening):** Packages live in TWO places: source-of-truth (`profile/git/` for git-sourced) and runtime (`~/.pi/agent/git/` for URL-git-sourced entries wired via `settings.json`). The agent searches only one location because the layout isn't checked first — `settings.json` (the actual index) is never consulted.

**Concrete fix:** **Read the deploy manifest, don't search.**

```bash
# See all deploy stages and their paths:
mise run deploy-status

# Read the provenance (where things actually deployed):
cat ~/.pi/agent/deploy-manifest.json
cat ~/.pi/agent/deploy-provenance.json

# Audit what's actually deployed:
mise run deploy-audit

# Find a specific package: settings.json is the index
rg '<package-name>' ~/.pi/agent/settings.json   # reveals git URL
# → maps to ~/.pi/agent/git/<host>/<org>/ path
```

The deploy pipeline writes `{deploy-manifest.json, deploy-provenance.json, deploy-log.jsonl}` to `~/.pi/agent/` after every deploy. These files contain the exact paths, what was deployed, and when.

**Using the stage directory convention:**
```
~/.pi/agent/          = stage 1 (prod)
~/.pi-staging/        = stage 2 (staging)
~/.pi-dev-<name>/     = stage 3 (dev)
~/.pi-wt-<name>/      = stage 4 (worktree)
```

This is codified in AGENTS.md. No search needed — the paths are deterministic.

**Prevention mechanism:** Always resolve package location through `settings.json` `extensions[]`/`packages[]` FIRST — it lists every git/npm URL, which deterministically maps to a filesystem path. Codify in AGENTS.md/tips.md: "Deployed git packages live in BOTH `profile/git/` (source) and `~/.pi/agent/git/` (runtime) — check `settings.json` as the index before searching."

**Trade-offs:**
- ✅ Gain: Instant answer, no filesystem search.
- ✅ Gain: Manifests are authoritative (written by the deploy pipeline itself).
- ❌ Lose: Must run deploy at least once for manifest to exist.
- ❌ Lose: If someone manually copies files, the manifest won't reflect it.

---

### Pattern 5 — Sub-agent Wait Cycles

**Root cause (why it keeps happening):** Dispatch-poll-dispatch serializes inherently parallel work. "GOAL STALE" checkpoints fire between each wait, adding full goal re-reads per sub-agent instead of once per batch. The agent treats sub-agent completion as a sequential dependency when it isn't.

**Concrete fix:** **Use intercom scatter-gather or fire-and-forget with callback.**

**Option A: `intercom ask_many` (scatter-gather)**
```
intercom({ action: "ask_many", targets: ["worker-1", "worker-2"], message: "Do X" })
```
This sends to multiple sessions and waits for all replies. No polling needed — it blocks until all targets respond.

**Option B: Fire-and-forget + intercom reply**
```
# Dispatch (no wait):
intercom({ action: "send", to: "worker-1", message: "Do X", expectsReply: true })

# Worker replies when done:
intercom({ action: "reply", message: "Done, result: ..." })

# Dispatcher checks pending:
intercom({ action: "pending" })
```

**Option C: Use pi-agent-teams (no hangs)**
Per `flow/findings/subagent-hang-pre-spawn.md`: "Teams has ZERO hangs." Teams uses a different coordination model than subagents — it doesn't have the `setToolsExpanded` race that causes subagent hangs.

**Option D: Ledger-based coordination**
Write intent to ledger → worker reads ledger → worker writes result to ledger → dispatcher reads ledger. No direct coordination needed.

**Prevention mechanism:** Batch rule for multi-agent plans: dispatch ALL sub-agents in one turn, run exactly ONE goal-staleness check after ALL replies land (`ask_many` returns when complete). Plan docs must state "parallel dispatch, single completion gate". If goal staleness matters mid-run, check file timestamp, not a full goal re-read.

**Trade-offs:**
- ✅ Gain: No polling loops. No "is it done yet?" cycles.
- ✅ Gain: `ask_many` gives structured scatter-gather with timeout.
- ✅ Gain: Teams model eliminates the subagent hang bug entirely.
- ❌ Lose: `ask_many` blocks until all targets respond (no partial results).
- ❌ Lose: Ledger-based is async but requires polling the ledger (different poll target).
- ❌ Lose: Teams requires more setup (team definition, member config).

---

### Pattern 6 — Partial Plan Coverage

**Root cause (why it keeps happening):** Plan lists N items; agent works sequentially and loses the count mid-run (middle/end items get dropped). Nothing mechanically ties plan items to completion — tracking lives only in the agent's working memory.

**Concrete fix:** **Use pi-goal-xx task lists with per-task verification.**

```
# Create goal with task list:
propose_task_list({
  tasks: [
    { title: "Item 1", verificationContract: "test 1 passes" },
    { title: "Item 2", verificationContract: "test 2 passes" },
    { title: "Item 3", verificationContract: "test 3 passes" },
    { title: "Item 4", verificationContract: "test 4 passes" },
    { title: "Item 5", verificationContract: "test 5 passes" }
  ]
})
```

Then track completion:
```
complete_task({ taskId: "1", verificationSummary: "test 1 passed, evidence: ..." })
complete_task({ taskId: "2", verificationSummary: "..." })
# ... etc
```

**The goal system tracks which tasks are complete.** `get_goal` shows the task list with completion status. Missing tasks are visible.

**Using the acceptance contract pattern (this task's own pattern):**
Require structured evidence for each item:
```json
{
  "criteriaSatisfied": [
    { "id": "item-1", "status": "satisfied", "evidence": "..." },
    { "id": "item-2", "status": "satisfied", "evidence": "..." }
  ]
}
```

The completion auditor checks that ALL items have evidence. Missing items = disapproved.

**Using verification contracts with sisyphus goals:**
For ordered execution, sisyphus goals enforce step-by-step completion. The agent cannot skip ahead — each step must be verified before moving to the next.

**Prevention mechanism:** At task start: copy every plan item into a checkbox task list (`_GOAL*_CHECKLIST.md` or pi-goal-xx task list) — one item, one checkbox, one verificationContract. Before declaring done: `rg '\[ \]' flow/plans/<plan>.md` must return zero hits. Reviewer's first action = count plan items vs `complete_task` records; mismatch = reject.

**Trade-offs:**
- ✅ Gain: Every item tracked. Missing items visible in `get_goal`.
- ✅ Gain: Verification contracts force evidence per item.
- ✅ Gain: Auditor catches missing items at completion time.
- ❌ Lose: Task list creation takes 1-2 minutes upfront.
- ❌ Lose: Overhead for simple goals (1-2 items) may not be worth it.
- ❌ Lose: Task lists can become stale if the plan changes (must update task list too).

---

## Sources

- Kept: `package.json` — confirms Node test runner (not vitest)
- Kept: `AGENTS.md` (pi-plugins) — deploy stage paths, deploy pipeline docs, git-sourced package layout
- Kept: `README.md` (pi-goal-xx) — task lists, verification contracts, auditor, pre-audit hooks
- Kept: `flow/plans/2026-07-06_goal-ceremony-and-hook-routing.md` — ceremony, interruption policy
- Kept: `flow/findings/2026-07-14_pi-process-exit-after-completion-timeline.md` — subagent/teams findings
- Kept: `flow/agents-md/extensions-inventory.md` (pi-plugins) — dual-location package pattern (profile/git vs runtime)

## Gaps

- **Worktree merge conflicts**: No specific pi-tool for worktree merge resolution. The fix (merge from main) is a git workflow change, not a pi feature.
- **Sub-agent wait cycles**: `ask_many` timeout behavior not fully documented. May need empirical testing.
- **Deploy path discovery**: `mise run deploy-status` assumed to work; not verified in this research session (read-only research role).

## Supervisor coordination

No supervisor contact needed. All solutions derivable from existing documentation and tooling.
