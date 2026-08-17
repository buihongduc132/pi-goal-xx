# Turn 18 — surface early_disapprove reason to agent

Date: 2026-08-10
Phase: implementation
Status: done (PR #62 merged, deployed)

---

> **[user]** (verbatim — trust chain L1)
>
> ```
> Goal completion rejected by independent auditor.
> Auditor model: bhd-litellm/role-smart
>
> Auditor produced no approval marker.
> ```
> --- if early disapprove , then also surface the reason to the agent session as well ; make the worktree , fix it for me ;

---

**[assistant]**

Created worktree `wt-early-disapprove-reason` at branch `feat/surface-early-disapprove-reason`.

Found rejection message construction in `extensions/goal.ts`:
```typescript
const rejectionText = [
    "Goal audit rejected.",
    "",
    "Goal completion rejected by independent auditor.",
    auditor.model ? `Auditor model: ${auditor.model}...` : undefined,
    auditor.gateFailure ? `Pre-audit gate failed: ${auditor.gateFailure}` : undefined,
    auditor.error ? `Auditor error: ${auditor.error}` : undefined,
    "",
    auditor.output || "Auditor produced no approval marker.",
].filter((line): line is string => line !== undefined).join("\n");
```

Checked `auditor.earlyDisapprovalReason` field exists in `GoalAuditorResult` (from `goal-auditor.ts`):
```typescript
earlyDisapproved?: boolean;
/**
 * LD9: structured reason captured verbatim from the early_disapprove tool
 * call's `reason` argument. Present iff `earlyDisapproved` is true.
 */
earlyDisapprovalReason?: string;
```

Added line to rejection message:
```typescript
auditor.earlyDisapprovalReason ? `Early disapproval reason: ${auditor.earlyDisapprovalReason}` : undefined,
```

## Before

```
Goal audit rejected.
Goal completion rejected by independent auditor.
Auditor model: bhd-litellm/role-smart

Auditor produced no approval marker.
```

Agent had no feedback on WHY early rejection occurred (had to manually inspect `auditor-trace.jsonl`).

## After

```
Goal audit rejected.
Goal completion rejected by independent auditor.
Auditor model: bhd-litellm/role-smart
Early disapproval reason: Executor claims file test-early-disapprove.txt
  was created and committed, but the file does not exist in the repository
  workspace. The primary artifact required by the objective is missing.

Auditor produced no approval marker.
```

## Verification

- Type check: `npm run check` — PASS
- Tests: 8/8 PASS

## PR + Merge + Deploy

- Commit: `6f7e7ad` "feat: surface early_disapprove reason to agent session"
- Pushed to origin
- PR #62 created: https://github.com/buihongduc132/pi-goal-xx/pull/62
- Merged to main: commit `4c04e84`
- Deployed to `~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx`

Verified deployment:
```bash
rg "earlyDisapprovalReason" ~/.pi/agent/git/.../extensions/goal.ts
# auditor.earlyDisapprovalReason ? `Early disapproval reason: ${auditor.earlyDisapprovalReason}` : undefined,
```

---

Status at end of turn 18: early_disapprove reason now surfaces to agent session. PR #62 merged + deployed.
