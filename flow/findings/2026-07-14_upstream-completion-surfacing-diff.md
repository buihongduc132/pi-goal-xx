# Upstream Diff — `complete_goal` + auditor + completion surfacing

**Date:** 2026-07-14
**Author:** teammate `upstream-diff` (task #2)
**Scope:** Compare pi-goal-xx `complete_goal` + auditor + completion surfacing against upstream `tmonk/pi-goal-x` (`upstream/main` @ 68ed6de).
**Fork point:** `210d2cb` "Initial commit: fork of pi-goal-x v0.19.0".
**Method:** `git fetch upstream` → `git diff upstream/main..HEAD -- extensions/`. No code edited; `complete_goal` not invoked.

---

## TL;DR

The completion auditor **exists in upstream** `tmonk/pi-goal-x` — it is **not** a pi-goal-xx
addition. pi-goal-xx **extends** it (configurability, crash-safety, tracing) but the
user-visible completion surfacing path is **structurally identical** to upstream:

- Same `<approved/>` / `<disapproved/>` verdict markers (`parseAuditorDecision`).
- Same `GOAL_AUDIT_ENTRY` message with `display: true` for the approval/rejection text.
- Same `buildCompletionReport` returned as the tool result.
- Same `stopReason: "agent"` on the approved path.
- Same `terminate: true` returned from `complete_goal` on approval.
- Same `if (state.goal.status === "complete") return;` early-return in the turn-start
  prompt handler (pi-goal-xx `goal.ts:4560` ↔ upstream `goal.ts:~3511`).
- `goal-notifications.ts` is **byte-identical** between the two forks.

**No commit regressed user-visible completion messaging.** The only user-visible behavioral
change in the completion/audit surface is the **removal of the animated auditor spinner**
(commit `5035cc0`), which is intentional (anti-redraw-storm) and affects the *audit-in-progress*
glyph, not the completion message itself.

---

## Question 1 — Does upstream have an auditor / completion-audit?

**YES.** Upstream ships `extensions/goal-auditor.ts` (18.5 KB) exporting
`runGoalCompletionAuditor(...)`, `parseAuditorDecision(...)`, `buildGoalAuditorPrompt(...)`,
`GoalAuditorResult`, and a `report_auditor_progress` tool. `complete_goal` in upstream
`goal.ts` invokes `runGoalCompletionAuditor` and gates archival on `auditor.approved`.

The auditor ceremony + `stopReason='agent'` on approval is therefore **upstream behavior**,
inherited by pi-goal-xx. pi-goal-xx's contribution is the configurability/crash-safety layer
(see Q4) layered on top of the same core.

### How upstream surfaces the auditor verdict to the user

Upstream surfaces the verdict through three channels, all preserved unchanged in pi-goal-xx:

1. **Inline session message** (`pi.sendMessage<GoalAuditEventDetails>` with `customType:
   GOAL_AUDIT_ENTRY`, `display: true`):
   - On approval: `"Auditor: I approve this completion claim."` + model + `auditor.output`.
   - On rejection: `"Goal audit rejected."` + model + error + `auditor.output`.
2. **Tool result content** — `buildCompletionReport(...)` (defined in `goal-policy.ts`),
   identical between forks (zero-line diff).
3. **Auditor progress widget** — `renderAuditorWidgetLines` in `goal-widget.ts` shows phase
   (`thinking` / `running` / `tool_executing` / `producing_report` / `done`), elapsed time,
   and the live `report_auditor_progress` label/percentage.

Note: **neither** fork emits a `ctx.ui.notify(...)` toast on completion. The only `ui.notify`
calls near completion are the user-driven commands ("Goal is complete.", warning, when the
user tries to operate on an already-complete goal). `goal-notifications.ts` only builds a
**running** notification (`buildGoalRunningNotification`); there is no completion
notification builder in either fork.

---

## Question 2 — How does each fork render goal completion?

| Surface | Upstream pi-goal-x | pi-goal-xx | Diff |
|---|---|---|---|
| `goal-notifications.ts` | running-only notification builder | identical | **0-line diff** |
| `buildCompletionReport` (`goal-policy.ts`) | report text from summaries + auditor report | identical | **0-line diff** |
| Approval/rejection inline text (`goal.ts`) | `approvalText` / `rejectionText` literal strings | identical strings | **0-line diff** in text content |
| `GOAL_AUDIT_ENTRY` message | `display: true`, phase `approved`/`rejected`/`skipped` | identical fields | unchanged |
| Auditor widget (`goal-widget.ts`) | animated braille spinner `⠋⠙⠹…` (80 ms) while auditing | **static `●`** + 500 ms redraw | **intentional change** (Q4) |
| Widget liveness icon | generic running/`auto`/`sisyphus` glyphs | **+ `⌽` stale** icon for dead-session goals | addition (improvement) |

The completion **message** path is unchanged; only the **audit-in-progress animation** and the
**goal-running liveness** icon differ.

---

## Question 3 — `stopReason` on approval + auto-continue early-return

| Behavior | Upstream pi-goal-x | pi-goal-xx | Gap |
|---|---|---|---|
| Sets `stopReason: "agent"` on auditor-approved completion | YES (`goal.ts:~2710`) | YES (`goal.ts:~3635`) | none |
| Sets `stopReason: "agent"` on per-goal-disabled / bypass-auditor completion | YES (`goal.ts:~2412`) | YES (`goal.ts:~3258`) | none |
| `complete_goal` returns `terminate: true` on approval | YES | YES | none |
| Turn-start handler early-returns on `status === "complete"` (no continue prompt injected) | YES (`goal.ts:~3511`) | YES (`goal.ts:4560`) | none |
| `agent_end` archival of completed goal | deferred to turn_end | deferred to turn_end | none |

**Conclusion:** the `stopReason`/`terminate`/auto-continue mechanism on the approved path is
**byte-for-byte equivalent in behavior**. The `goal.ts:4560` early-return that the bug docs
flag is present **verbatim** in upstream — it is not a pi-goal-xx regression.

---

## Question 4 — pi-goal-xx-only commits touching completion surfacing

`git log upstream/main..HEAD --oneline -- extensions/widgets/ extensions/goal.ts` yields the
list below. Only the widgets + the complete_goal execute body touch *user-visible* surfacing;
the rest are crash-safety/config/tracing.

| Commit | Subject | Surfacing impact |
|---|---|---|
| `5035cc0` | fix(auditor): strip animated spinner to stop redraw storm (#27) | **User-visible**: auditor widget spinner `⠋⠙⠹…` → static `●`; redraw 80 ms → 500 ms. Intentional, anti-redraw-storm. Affects *audit-in-progress* glyph only, **not** the completion message. |
| `cd42dd8` | feat(goal): surface start_goal tool hidden from subagents (#29) | Adds `start_goal` surfacing; orthogonal to completion. |
| `1111059` | feat(tracing): OTel-compatible JSONL + route all logging (#28) | Internal tracing; no session-facing completion text change. |
| `53088a5` | feat(tracing): unified crash-safe logging & tracing (#26) | Internal; no user-visible completion change. |
| `ff45804` / `d86ce2a` / `d95b5d0` / `ff36e54` | crash-safe complete_goal (#21/#24/#25) + remove `await sendMessage` | Wraps the 6 `pi.sendMessage` calls in `safeFireAndForget`, adds `tryWriteActiveGoalFile`, `unhandledRejection` guard, timeout. **Improves** surfacing reliability (prevents exit-on-reject swallowing the approval/rejection message). Text content unchanged. |
| `41adeda` | fix(goal-display-liveness): dead session goals show stale not running (#16) | Adds `⌽` stale icon to widget — **improvement** to display liveness. |
| `011802a` | fix(goal-lock): identity-aware PID liveness (#…) | Underpins the stale icon; display-only. |
| `02d3531` | gate propose_task_list on shouldAutoConfirmProposal (#14) | RPC safety; not completion. |
| `02d3531`/widget diffs | `ctx.hasUI` → `isInteractiveTui(ctx)` in escape-dialog + task-list-overlay | RPC crash fix; safe-default behavior preserved. |
| `cd8b330` / `043c16e` / `74061cb` / `aa2f4d1` | auditor configurability + inheritFromCwd + verdict capture + forensic logging | Auditor *behavior* (modes, wildcard filters, prompt files, resource inheritance). The `<approved/>`/`<disapproved/>` surfacing contract unchanged. |

### Did any commit REGRESS user-visible completion messaging?

**No.** Every commit either preserves the completion message text verbatim or hardens its
delivery. The single user-visible *change* is `5035cc0`'s removal of the animated auditor
spinner — a deliberate trade (visual liveness → redraw efficiency), confined to the
audit-in-progress widget, with the final approval/rejection message untouched.

The closest thing to a regression risk is the spinner removal making the *audit phase* feel
"less alive," but the elapsed-time display + phase label still tick every 500 ms, so the
audit is still visibly progressing.

---

## Summary table — {behavior | upstream | pi-goal-xx | gap/regression}

| Behavior | Upstream pi-goal-x | pi-goal-xx | Gap / Regression |
|---|---|---|---|
| Has completion auditor | YES (`goal-auditor.ts`) | YES (extended: modes, wildcard filters, prompt files, inheritFromCwd, forensic log, tracing) | **No gap** — pi-goal-xx is a superset |
| Verdict markers | `<approved/>` / `<disapproved/>` | identical | none |
| Approval inline message text | `"Auditor: I approve this completion claim."` + model + output | identical | none |
| Rejection inline message text | `"Goal audit rejected."` + model + error + output | identical | none |
| `buildCompletionReport` | `goal-policy.ts` | **identical** (0-line diff) | none |
| `GOAL_AUDIT_ENTRY` message (`display: true`) | present | present | none |
| `ui.notify` on completion | **none** (only running + user-command warnings) | **none** | shared gap: neither fork toasts completion |
| `stopReason: "agent"` on approval | YES | YES | none |
| `complete_goal` returns `terminate: true` | YES | YES | none |
| Turn-start early-return on `status === "complete"` | YES | YES (`goal.ts:4560`) | none — inherited upstream behavior |
| Auditor widget animation | braille spinner, 80 ms redraw | **static `●`, 500 ms redraw** | intentional (anti-redraw-storm); audit-phase only |
| Goal-running liveness icon | generic | **+ `⌽` stale** | improvement |
| `pi.sendMessage` delivery | bare (no `.catch` → exit-on-reject risk) | `safeFireAndForget` (crash-safe) | **improvement** |
| Active-file write | `writeActiveGoalFile` (throws) | `tryWriteActiveGoalFile` (surfaces failure, rollback) | **improvement** |
| `ctx.hasUI` gating (escape/task overlay) | `ctx.hasUI` (lies in RPC) | `isInteractiveTui(ctx)` | **fix** |
| Auditor timeout / unhandledRejection guard | none | timeout + guard | **improvement** |
| Objective/completionSummary size cap | unbounded | 50 KB cap (`MAX_OBJECTIVE_LENGTH`) | **improvement** (prevents auditor-prompt OOM/hang) |

---

## Deliverable status

- [x] Q1: Upstream auditor presence + verdict surfacing — answered.
- [x] Q2: Completion rendering diff (notifications + goal.ts approved path) — answered.
- [x] Q3: `stopReason` + auto-continue early-return — answered (identical, `goal.ts:4560`).
- [x] Q4: pi-goal-xx-only commit list + regression identification — answered (no regression).

No code edited. `complete_goal` not invoked.
