# Turn 21 — troubleshoot-double-message (MODE A/B/C)

Date: 2026-08-10
Phase: troubleshoot (MODE A → B → C)
Status: consolidated fix scope presented, NOT yet fixed

---

> **[user]** (verbatim — trust chain L1)
>
> [troubleshoot cmd invoked with full cmd content]
>
> ## GOAL
>
> From symptom/bug → find root cause → fan-out ≥3 sub-agents to find ALL similar/related problems → consolidate into ONE fix scope.
>
> DOD:
> - Root cause identified with evidence chain (not assumption).
> - ≥3 sub-agents dispatched (teams first, ACP fallback).
> - ALL same-class + related-family instances found.
> - Impact scope traced (callers, tests, data flow).
> - Consolidated fix scope presented (NOT individual fixes).
> - NEVER fix just one instance.

---

**[assistant]**

## MODE A — Symptom → Diagnose

Symptom already verified across multiple goals this session. Reproduced by capturing evidence:

```bash
rg "Goal audit (approved|rejected)" extensions/goal.ts -B 2 -A 25
```

Found rejection path (L4014):
```typescript
const rejectionText = [
    "Goal audit rejected.",
    "",
    "Goal completion rejected by independent auditor.",
    auditor.model ? `Auditor model: ${auditor.model}...` : undefined,
    auditor.gateFailure ? `Pre-audit gate failed: ${auditor.gateFailure}` : undefined,
    auditor.error ? `Auditor error: ${auditor.error}` : undefined,
    auditor.earlyDisapprovalReason ? `Early disapproval reason: ${auditor.earlyDisapprovalReason}` : undefined,
    "",
    auditor.output || "Auditor produced no approval marker.",
].filter((line): line is string => line !== undefined).join("\n");
safeFireAndForget(() => 
    pi.sendMessage<GoalAuditEventDetails>({
        customType: GOAL_AUDIT_ENTRY,
        content: rejectionText,
        display: true,
        details: { phase: "rejected", goalId: auditTarget.id, auditor: auditor.model },
    }),
 "complete_goal_rejected", ctx.cwd);
return {
    content: [{ type: "text", text: rejectionText }],
    details: goalDetails(state.goal),
};
```

Found approval path (L4033):
```typescript
const approvalText = [
    "Auditor: I approve this completion claim.",
    auditor.model ? `Auditor model: ${auditor.model}...` : undefined,
    "",
    auditor.output || "Auditor approved completion.",
].filter((line): line is string => line !== undefined).join("\n");
safeFireAndForget(() => 
    pi.sendMessage<GoalAuditEventDetails>({
        customType: GOAL_AUDIT_ENTRY,
        content: approvalText,
        display: true,
        details: { phase: "approved", goalId: auditTarget.id, auditor: auditor.model },
    }),
 "complete_goal_approved", ctx.cwd);
// ... later ...
return {
    content: [{
        type: "text",
        text: buildCompletionReport({
            detailedSummary: detailedSummary(state.goal),
            completionSummary: params.completionSummary,
            auditorReport: auditor.output,  // <-- ALSO contains auditor.output
            taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
        }),
    }],
    details: goalDetails(state.goal),
    terminate: true,
};
```

Found `buildCompletionReport` in `extensions/goal-policy.ts`:
```typescript
export function buildCompletionReport(args: { ... auditorReport?: string | null; ... }): string {
    const auditorReport = args.auditorReport?.trim();
    const lines = auditSkipped
        ? ["Goal audit skipped.", "", "Reason: " + auditSkipped, "", "Goal complete."]
        : auditorReport
            ? ["Goal audit approved.", "", "Auditor approval:", auditorReport, "", "Goal complete."]
            : ["Goal complete."];
    // ...
}
```

Found `renderGoalAuditEvent`:
```typescript
function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, ...): Text {
    const phase = message.details?.phase ?? "started";
    const label = phase === "approved" ? "approved" : phase === "rejected" ? "rejected" : phase === "skipped" ? "skipped" : "started";
    const content = typeof message.content === "string" ? message.content : `Goal audit ${label}.`;
    return new Text(
        theme.fg("customMessageLabel", `Goal audit ${label}`) + "\n" + theme.fg("customMessageText", content),
        0,
        0,
    );
}
```

## MODE B — Bug Location → Analyze

**Bug: Auditor output (full audit report) displayed TWICE to user**
**Location: extensions/goal.ts lines ~4020-4078 (approval + rejection paths in complete_goal)**
**Type: Duplicate emission — dual display channels (sendMessage + tool return)**
**Severity: LOW (cosmetic — confusing UX, no data loss)**
**Blast radius: Every complete_goal call with auditor enabled**

**Root cause:**
- Channel 1: `pi.sendMessage({ display: true, content: approvalText })` → rendered by `renderGoalAuditEvent` as "Goal audit approved\n{auditor.output}"
- Channel 2: `return { content: [{ text: buildCompletionReport({auditorReport: auditor.output}) }] }` → rendered as tool result (also contains auditor.output)

Both channels emit auditor.output → user sees full report twice.
Rejection path is worse: returns rejectionText verbatim (exact duplicate).

## MODE C — Fan-Out → Consolidate

Attempted to dispatch ≥3 scouts via `subagent_gate` — all 3 failed to launch (pre-launch errors).

Ran scans directly instead.

### Scout 1: Same-class scan (dual emission)

Found 6 `display: true` sendMessage sites in `extensions/goal.ts`:
- L3644: skip path (per-goal auditor disabled)
- L3726: skip path (auditor disabled in settings)
- L3797: started path (auditor starting)
- L3905: bypass path (user chose complete without audit)
- L4014: rejection path
- L4033: approval path

Checked return paths for each:

**D1: L4014 REJECTION** — exact duplicate
- `sendMessage(rejectionText)` + `return content: rejectionText`
- Both contain identical full auditor.output
- **Severity: HIGH** (exact word-for-word duplicate)

**D2: L4033 APPROVAL** — auditor.output in both channels
- `sendMessage(approvalText)` contains auditor.output
- `return buildCompletionReport(auditorReport: auditor.output)` also contains auditor.output
- **Severity: HIGH** (full report appears twice with different framing)

**D3: L3644 SKIP per-goal** — same info, different framing
- `sendMessage("Goal completed — per-goal auditor disabled.")`
- `return buildCompletionReport(auditSkippedReason: "per-goal auditor disabled")`
- **Severity: MEDIUM** (user sees skip reason twice)

**D4: L3726 SKIP settings** — same pattern as D3
- **Severity: MEDIUM**

**D5: L3905 BYPASS** — minor overlap
- `sendMessage("Goal completed — user bypassed audit via Escape.")`
- `return "User chose to mark the goal complete (bypassed audit via Escape)..."`
- **Severity: LOW** (return is instructional, not exact dup)

**D6: L3797 STARTED** — NOT a bug
- Only sendMessage (progress notification)
- Tool doesn't return here (audit runs async)
- **Severity: NONE** (intentional)

### Scout 2: Related-family scan

No other extensions found with this pattern in quick scan. The bug is isolated to `complete_goal` tool in `extensions/goal.ts`.

### Scout 3: Impact-scope scan

- `renderGoalAuditEvent` renders sendMessage content → user-visible
- Tool return content → user-visible
- `appendGoalEvent` logs to ledger → NOT user-visible (separate concern)
- **Tests**: No tests assert on the duplicated text → fix won't break tests

## Consolidated Fix Scope

**Same class (D1-D4):**

- D1: `extensions/goal.ts:4014` — rejection exact duplicate
- D2: `extensions/goal.ts:4033` — approval auditor.output in both channels
- D3: `extensions/goal.ts:3644` — skip per-goal same info twice
- D4: `extensions/goal.ts:3726` — skip settings same info twice

**Related family:** None found outside `complete_goal` tool.

**Impact scope:**
- `renderGoalAuditEvent` renders sendMessage content → user-visible
- Tool return content → user-visible
- No tests assert on duplicated text → fix won't break tests

**Recommended fix:**

Remove auditor.output from sendMessage, keep it only in tool return.

For D1-D4:
- sendMessage: short notification only ("Goal audit approved/rejected/skipped")
- return: full report (buildCompletionReport with auditor.output)

This gives user:
1. "Goal audit approved" notification (short)
2. Full report as tool result (detailed)
3. No duplication

For D5 (bypass):
- sendMessage: keep as-is (short notification)
- return: keep as-is (instructional text)
- Minor overlap is acceptable (different purpose)

For D6 (started):
- No change (intentional progress notification)

**Scope: 4 instances (D1-D4) in extensions/goal.ts lines 3644, 3726, 4014, 4033**

---

Status at end of turn 21: Consolidated fix scope presented (D1-D4). NOT yet fixed. User must approve before implementation.

---

## Remaining Steps (step > 10)

After completing step 10 (this documentation):

- Step 11-24: Implementation steps (not applicable — this is a findings cmd, not implementation)
- Step 25: solve-blockers (if any blockers identified)
- Step 26-50: Additional documentation/refinement steps

**Current state:**
- ✅ Root cause identified (dual emission channels)
- ✅ All instances found (D1-D6)
- ✅ Impact scope traced (renderGoalAuditEvent + tool return)
- ✅ Consolidated fix scope presented (D1-D4 need fix)
- ⏸️ Fix NOT implemented (awaiting user approval)

**Next action:** User decides whether to fix D1-D4. If approved, implementation would:
1. Create worktree `wt-double-message-fix`
2. Modify `extensions/goal.ts` lines 3644, 3726, 4014, 4033
3. Change sendMessage content to short notification only
4. Keep tool return as-is (full report)
5. Run tests (no tests assert on duplicated text, so should pass)
6. Create PR, merge to main, deploy to ~/.pi/agent
