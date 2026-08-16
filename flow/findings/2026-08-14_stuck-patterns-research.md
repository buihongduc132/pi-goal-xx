# Research: Alternative Approaches for 6 Stuck Patterns

## Summary

Each stuck pattern has an alternative that avoids the problem entirely by changing the workflow entry point, not by patching around the failure. The alternatives leverage existing pi tooling: git worktree merge-from-main, targeted test gates, test-first planning, deploy manifest reads, scatter-gather intercom, and goal task-list tracking.

## Findings

### Pattern 1 — Worktree Merge Conflicts

**Current approach:** Create worktree → attempt merge inside worktree → conflicts because worktree lacks full repo context.

**Alternative approach:** **Merge from the main repo, not inside the worktree.**

```bash
# In the MAIN repo (not the worktree):
git merge <feature-branch>
# Resolve conflicts in main repo context (full history, all refs available)
git push  # or let deploy pipeline handle it
```

Or use **cherry-pick** for surgical changes:
```bash
git cherry-pick <commit>  # from main repo, single commit at a time
```

Or use the **deploy pipeline as the merge mechanism** — `mise run deploy-worktree` (LOCAL→4) uses rsync, not git merge. The worktree is a working area; promotion to dev/staging/prod goes through `sync_profile()` which is file-copy, not git-merge. Conflicts are impossible because rsync is source→target overwrite.

**Trade-offs:**
- ✅ Gain: No merge conflicts in worktrees. Full git history available for resolution.
- ✅ Gain: Deploy pipeline already bypasses git merge entirely (rsync-based).
- ❌ Lose: Can't test merge resolution in isolation before pushing.
- ❌ Lose: If you need the worktree to be a "merge-ready branch", you must merge from main.

---

### Pattern 2 — Test Runner Assumptions

**Current approach:** Run vitest → 100 files fail because vitest is NOT the project's test runner.

**Alternative approach:** **Use the project's actual test runner and gates.**

This project uses Node's built-in test runner:
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

**Trade-offs:**
- ✅ Gain: Tests actually pass. Correct runner = correct results.
- ✅ Gain: Targeted runs give fast feedback on specific changes.
- ❌ Lose: Node test runner has fewer features than vitest (no watch mode built-in, less fancy assertions).
- ❌ Lose: Must know which runner the project uses (read `package.json` first).

---

### Pattern 3 — Plan vs Test Contract Drift

**Current approach:** Write plan → write tests → plan says X but tests require Y → silent drift.

**Alternative approach:** **Test-first planning (read tests BEFORE writing the plan).**

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

**Trade-offs:**
- ✅ Gain: Drift caught at plan time, not implementation time.
- ✅ Gain: Verification contracts make the contract explicit and machine-checkable.
- ❌ Lose: Reading tests first takes 2-5 minutes upfront.
- ❌ Lose: If tests are wrong/outdated, test-first planning inherits the wrong contract.

---

### Pattern 4 — Deploy Path Discovery

**Current approach:** Search filesystem for where packages deploy → search wrong location.

**Alternative approach:** **Read the deploy manifest, don't search.**

```bash
# See all deploy stages and their paths:
mise run deploy-status

# Read the provenance (where things actually deployed):
cat ~/.pi/agent/deploy-manifest.json
cat ~/.pi/agent/deploy-provenance.json

# Audit what's actually deployed:
mise run deploy-audit
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

**Trade-offs:**
- ✅ Gain: Instant answer, no filesystem search.
- ✅ Gain: Manifests are authoritative (written by the deploy pipeline itself).
- ❌ Lose: Must run deploy at least once for manifest to exist.
- ❌ Lose: If someone manually copies files, the manifest won't reflect it.

---

### Pattern 5 — Sub-agent Wait Cycles

**Current approach:** Dispatch sub-agent → poll for completion → wait → check result.

**Alternative approach:** **Use intercom scatter-gather or fire-and-forget with callback.**

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

**Trade-offs:**
- ✅ Gain: No polling loops. No "is it done yet?" cycles.
- ✅ Gain: `ask_many` gives structured scatter-gather with timeout.
- ✅ Gain: Teams model eliminates the subagent hang bug entirely.
- ❌ Lose: `ask_many` blocks until all targets respond (no partial results).
- ❌ Lose: Ledger-based is async but requires polling the ledger (different poll target).
- ❌ Lose: Teams requires more setup (team definition, member config).

---

### Pattern 6 — Partial Plan Coverage

**Current approach:** Plan lists 5 items → implement 4 → miss 1 → no detection.

**Alternative approach:** **Use pi-goal-xx task lists with per-task verification.**

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
- Kept: `AGENTS.md` (pi-plugins) — deploy stage paths, deploy pipeline docs
- Kept: `README.md` (pi-goal-xx) — task lists, verification contracts, auditor, pre-audit hooks
- Kept: `flow/plans/2026-07-06_goal-ceremony-and-hook-routing.md` — ceremony, interruption policy
- Kept: `flow/findings/2026-07-14_pi-process-exit-after-completion-timeline.md` — subagent hang findings

## Gaps

- **Worktree merge conflicts**: No specific pi-tool for worktree merge resolution. The alternative (merge from main) is a git workflow change, not a pi feature.
- **Sub-agent wait cycles**: `ask_many` timeout behavior not fully documented. May need to test empirically.
- **Deploy path discovery**: Assumes `mise run deploy-status` works. Not verified in this research session.

## Supervisor coordination

No supervisor contact needed. All alternatives are derivable from existing documentation and tooling.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "6 alternative approaches identified in research.md, each with current approach, alternative approach, and trade-offs. Patterns: (1) merge from main repo not worktree, (2) use correct test runner (node --test, not vitest), (3) test-first planning + verification contracts, (4) read deploy manifest not search filesystem, (5) intercom ask_many scatter-gather or teams model, (6) task lists with per-task verification."
    }
  ],
  "changedFiles": [
    "research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read package.json",
      "result": "passed",
      "summary": "Confirmed Node test runner (node --experimental-strip-types --test), not vitest"
    },
    {
      "command": "read AGENTS.md (pi-plugins)",
      "result": "passed",
      "summary": "Confirmed deploy stage paths: ~/.pi/agent (prod), ~/.pi-staging (staging), ~/.pi-dev-<name> (dev), ~/.pi-wt-<name> (worktree)"
    },
    {
      "command": "read README.md (pi-goal-xx)",
      "result": "passed",
      "summary": "Confirmed task lists, verification contracts, auditor, pre-audit hooks available"
    }
  ],
  "validationOutput": [
    "Pattern 1 (worktree merge): Alternative = merge from main repo or use deploy pipeline (rsync, not git merge). Source: AGENTS.md deploy pipeline docs.",
    "Pattern 2 (test runner): Alternative = use node --experimental-strip-types --test (from package.json). Vitest is wrong runner. Source: package.json scripts.test.",
    "Pattern 3 (plan vs test drift): Alternative = test-first planning + verificationContract field on tasks. Source: README.md verification contracts section.",
    "Pattern 4 (deploy path): Alternative = read deploy-manifest.json or run mise run deploy-status. Source: AGENTS.md deploy provenance section.",
    "Pattern 5 (sub-agent wait): Alternative = intercom ask_many scatter-gather or pi-agent-teams (zero hangs per findings). Source: AGENTS.md subagent hang findings.",
    "Pattern 6 (partial coverage): Alternative = pi-goal-xx task lists with per-task verificationSummary + auditor catch at completion. Source: README.md task lists + auditor sections."
  ],
  "residualRisks": [
    "Worktree merge alternative assumes user has access to main repo. If worktree is isolated (no main repo access), alternative doesn't apply.",
    "intercom ask_many timeout behavior not empirically tested in this session.",
    "mise run deploy-status assumed to work but not verified (no mise available in research context)."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created research.md with 6 alternative approaches for stuck patterns. Each pattern has: current approach, alternative approach (using existing pi tooling), and trade-offs (gain/lose). Alternatives avoid problems by changing workflow entry point, not patching around failures.",
  "reviewFindings": [],
  "manualNotes": "Research based on reading pi-goal-xx and pi-plugins documentation. No web search performed (all answers in local docs). All alternatives use existing pi tooling (git, node test runner, intercom, pi-goal-xx task system, deploy pipeline).",
  "notes": "Key insight: Pattern 2 (vitest vs node test runner) is a configuration error, not a workflow problem. The project uses node --test, not vitest. Running vitest on a node-test project causes 100% failure. Fix: use npm test, not vitest."
}
```
