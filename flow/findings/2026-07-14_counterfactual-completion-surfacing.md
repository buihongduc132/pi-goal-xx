# Counterfactual — Completion Surfacing UX Gap

**Repo:** `/home/bhd/Documents/Projects/bhd/pi-goal-xx`
**Premise under test:** Goal `mrk8g5ta-e7x8os` DID complete (ledger: `audit_result` verdict=approved, `goal_completed`, archived). The user perceives it as "unresolved."
**Hypothesis:** The gap is **purely surfacing**, not logic. The state machine is correct; the user-visible closure is missing/ambiguous.
**Method:** Counterfactual reasoning — "if line X did/did not exist, would the perception change?" — grounded in `extensions/` source with `file:line` citations.
**Scope:** Read-only. No code edited. `complete_goal` not invoked.

---

## TL;DR verdict

**YES — the "unresolved" perception is caused by missing surfacing.** The completion logic is correct (status→`complete`, ledger event `goal_completed`, file archived on `turn_end`), but the **happy path emits no final, unambiguous, user-visible closure**. The auditor's `<approved/>` verdict and the archive path are written to the **ledger only**, never surfaced as a success `ctx.ui.notify`. The only approval surfaces are a transient tool-result string and a custom-type audit message that read as intermediate audit progress, not final closure. Additionally, `stopReason: "agent"` set on the completed goal leaks the string `Stop reason: agent` / `stopReason: agent` into the widget and details, which reads ambiguously ("the agent stopped it").

---

## Counterfactual table

| # | Counterfactual | Would perception change? | Evidence (`file:line`) |
|---|----------------|--------------------------|------------------------|
| C1 | If `complete_goal` emitted a user-visible `✓ GOAL COMPLETED & archived to <path>` `ctx.ui.notify` on the approved path | **YES — it does not exist; perception would improve.** No success `notify` fires on completion. | `extensions/goal.ts:3619-3670` (approved path: only `pi.sendMessage` + `buildCompletionReport`, no `ctx.ui.notify`); `extensions/goal.ts:4365-4409` (`turn_end` archive: `ctx.ui.notify` fires ONLY on failure, line ~4383, never on success); `extensions/widgets/goal-notifications.ts:1-9` (only `buildGoalRunningNotification`, no completion builder) |
| C2 | If `stopReason` were NOT set to `"agent"` on the approved path (`goal.ts:3635`) | **YES (partly) — the string `Stop reason: agent` / `stopReason: agent` would stop appearing for the completed goal.** Two unconditional reads fire for a complete goal. | `extensions/goal.ts:3635` (`stopReason: "agent"`); reads that fire for `status==="complete"`: `extensions/goal.ts:299` (`Stop reason: ${goal.stopReason}` in details), `extensions/widgets/goal-widget.ts:338` (`stopReason: ${goal.stopReason}` in widget). Reads gated on `paused` that do NOT fire: `extensions/goal-core.ts:111,171`, `extensions/widgets/goal-widget.ts:81,270` |
| C3 | Is there ANY path that surfaces the auditor `<approved/>` verdict + archive path to the user as a final, unambiguous closure message? | **NO — none exists. That absence IS the bug.** The verdict shows as a transient audit message + tool result; the archive path is ledger-only. | `extensions/goal.ts:3619-3631` (`approvalText` = "Auditor: I approve this completion claim." sent as `GOAL_AUDIT_ENTRY`, `display:true`); `extensions/goal-policy.ts:349-365` (`buildCompletionReport` → "Goal audit approved. … Goal complete." — no archive path); `extensions/goal.ts:4397-4405` (`appendGoalEvent({ type: "goal_completed", archivePath })` — ledger only); `extensions/goal.ts:298` (`if (goal.archivedPath) lines.push("Archive: …")` — false at completion because archival is deferred, see `goal.ts:3627-3628,3652`) |

---

## Detailed evidence

### Q1 — What IS shown to the user on auditor approval?

The approved branch of `complete_goal` (`extensions/goal.ts:3619-3670`) produces exactly two user-visible artifacts and **zero `ctx.ui.notify` calls**:

1. **A custom-type message** (`extensions/goal.ts:3619-3631`):
   ```ts
   pi.sendMessage<GoalAuditEventDetails>({
     customType: GOAL_AUDIT_ENTRY,
     content: approvalText,   // "Auditor: I approve this completion claim.\n…"
     display: true,
     details: { phase: "approved", … },
   })
   ```
   Rendered by `renderGoalAuditEvent` (`extensions/goal.ts:389-400`) as:
   `Goal audit approved` (label color) + newline + the auditor text. This reads as an **intermediate audit step**, not a final closure. It is visually identical in structure to the `started`/`rejected` phases (same renderer, only the label changes).

2. **The tool result** `buildCompletionReport(...)` (`extensions/goal-policy.ts:349-365`):
   ```
   Goal audit approved.

   Auditor approval:
   <auditor.output>

   Goal complete.
   ```
   This is a plain tool-result text block. It contains **no archive path** and **no goal id**, and is buried among other tool outputs from the completing turn.

There is **no** `ctx.ui.notify("✓ Goal completed", "success")` and **no** notification builder analogous to `buildGoalRunningNotification`. `extensions/widgets/goal-notifications.ts` exports only `buildGoalRunningNotification` (the "●/◆ Goal/Sisyphus running" banner), and the only call site is `extensions/goal.ts:1759`. The symmetric "completed" notification was never implemented.

**Counterfactual answer (C1):** Had such a notify existed and fired at `goal.ts:3670` (right before the `return` on the approved path), the user would have seen an unambiguous, dismissible success toast naming the goal. As written, the strongest closure signal is the transient `Goal complete.` line inside a tool result, which is easy to miss or misread.

### Q2 — Does `stopReason: "agent"` leak into the completed-goal display?

Set at `extensions/goal.ts:3635`:
```ts
state.goal = { ...auditTarget, status: "complete", stopReason: "agent", updatedAt: nowIso() };
```

Tracing **every read of `stopReason`** in `extensions/`:

| Read | Fires for `status==="complete"`? | Effect |
|------|----------------------------------|--------|
| `extensions/goal.ts:299` `if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`)` | **YES** — unconditional truthy gate, included in `goalDetails()` returned as `details` of the tool result and consumed by `renderGoalResult` | Emits `Stop reason: agent` for the completed goal |
| `extensions/widgets/goal-widget.ts:338` `if (goal.stopReason) lines.push(t.fg("dim", `  stopReason: ${goal.stopReason}`))` | **YES** — unconditional truthy gate, in the widget's debug/detail block | Emits `stopReason: agent` (dim) for the completed goal |
| `extensions/widgets/goal-widget.ts:81` `goal.stopReason === "agent" ? {icon:"⊘",label:"blocked"}…` | **NO** — guarded by `status === "paused"` (line 80) | Does not fire; complete goals correctly get the `✓ complete` icon |
| `extensions/widgets/goal-widget.ts:270` `goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason` | **NO** — paused-gated | Does not fire |
| `extensions/goal-core.ts:111` `status === "paused" && goal.stopReason === "agent"` → `"paused·agent"` | **NO** — paused-gated | Does not fire |
| `extensions/goal-core.ts:171` `status === "paused" && goal.stopReason === "agent"` → `"paused (agent)"` | **NO** — paused-gated | Does not fire |
| `extensions/goal-record.ts:44,89,248` | persistence/parse only | Not display |

**Counterfactual answer (C2):** If `goal.ts:3635` did not set `stopReason: "agent"` (e.g. left it `undefined`, or used a distinct `"completed"` value), then `goal.ts:299` and `goal-widget.ts:338` would stop emitting the `Stop reason: agent` / `stopReason: agent` lines for the completed goal. The word `agent` next to a `complete` status reads ambiguously (it is the *same* token used for agent-paused/blocked states per `goal-widget.ts:81`), so removing it on the complete path would remove a secondary source of "did the agent just stop?" confusion. The main `✓` icon is unaffected (paused-gated, line 80).

### Q3 — Is there ANY code path that surfaces `<approved/>` + archive path as final closure?

**No.** Three places touch the approval/archive on the happy path, and none produces a final user-visible closure:

1. **`complete_goal` approved branch** (`goal.ts:3619-3670`): emits the `GOAL_AUDIT_ENTRY` message and the `buildCompletionReport` tool result (see Q1). No archive path — `archivedPath` is deliberately **not** set here:
   ```ts
   // goal.ts:3627-3628
   // archiving. Archival happens at turn_end so the agent can see the auditor
   // approval before the goal is archived.
   ```
   Therefore `goal.ts:298` (`if (goal.archivedPath) lines.push("Archive: ${goal.archivedPath}")`) is **false** at completion time → no Archive line in the returned details.

2. **`turn_end` deferred archival** (`goal.ts:4365-4409`): runs `archiveGoalFile(ctx, completedGoal)` (`goal-files.ts:240-251`, which sets `archivedPath` and writes the archived file). On **success** the only side effect is:
   ```ts
   // goal.ts:4397-4405
   appendGoalEvent(ctx, { type: "goal_completed", goalId, archivePath: archived.archivedPath, at });
   ```
   → **ledger only.** The user-visible `ctx.ui.notify` in this block fires **only on failure**:
   ```ts
   // goal.ts:~4383
   ctx.ui.notify(`Goal archival failed: ${msg}. …`, "error");
   ```
   The success branch has **no** `ctx.ui.notify`. `updateUI(ctx)` re-renders the widget (which now shows `✓` because the goal is `complete`), but no message is emitted.

3. **No completion notification builder exists.** `extensions/widgets/goal-notifications.ts` (9 lines) exports only `buildGoalRunningNotification`. There is no `buildGoalCompletedNotification` / `buildGoalArchivedNotification`, and no call site equivalent to `goal.ts:1759` for completion.

**Counterfactual answer (C3):** The absence of a final closure message is the bug. The auditor's `<approved/>` verdict and the archive path reach the **ledger** (`goal_completed` event, `goal.ts:4397`) and the **file system** (`archiveGoalFile`, `goal-files.ts:240`), but never the **user as a dismissible success notification**. The closest things (audit-event message + "Goal complete." tool line) are transient and semantically read as intermediate audit progress.

---

## Exact lines that would need to change (recommendation only — NOT applied)

To close the surfacing gap without altering logic, a minimal, additive change set would be:

1. **`extensions/widgets/goal-notifications.ts`** — add a completion builder, e.g.:
   ```ts
   export function buildGoalCompletedNotification(args: { objective: string; archivedPath?: string | null }): string {
     const title = truncateText(displayObjectiveTitle(args.objective), 92);
     const archive = args.archivedPath ? `\n└─ archived: ${args.archivedPath}` : "";
     return ["✓ Goal completed", `├─ ⟡ ${title}`, archive].filter(Boolean).join("\n");
   }
   ```
2. **`extensions/goal.ts:3619-3631` (approved branch)** — currently no notify; the approval message is the only surfacing. (Option A: surface now without archive path.)
3. **`extensions/goal.ts:4365-4409` (`turn_end` archival success branch)** — after `appendGoalEvent(..., { type: "goal_completed", archivePath })`, add a success notify that carries the **now-known** `archived.archivedPath`. This is the single highest-value insertion because it is the only place that possesses the real archive path on the happy path:
   ```ts
   // after goal.ts:4405 (the appendGoalEvent call)
   try { ctx.ui.notify(buildGoalCompletedNotification({ objective: completedGoal.objective, archivedPath: archived.archivedPath }), "success"); } catch {}
   ```
4. **`extensions/goal.ts:3635`** — drop `stopReason: "agent"` on the complete path (or use a distinct value) so `goal.ts:299` and `goal-widget.ts:338` stop emitting `Stop reason: agent` for a completed goal. (Verify no paused-gated logic depends on `stopReason==="agent"` for a complete goal — per the table above, all such reads are `status==="paused"`-gated, so this is safe.)

> Note: because archival is deferred to `turn_end`, the *complete* closure message with the archive path can only be emitted from the `turn_end` success branch (item 3), not from `complete_goal` itself. This split is a structural reason the closure was lost: the tool that the agent/user attributes completion to (`complete_goal`) does not know the archive path, and the hook that does know it (`turn_end`) emits only to the ledger.

---

## Verdict

**YES — the "unresolved" perception is caused by missing surfacing, not by logic.**

Evidence summary:
- State machine is correct: `complete_goal` approved branch sets `status: "complete"` (`goal.ts:3634-3638`), writes the active file (`goal.ts:3641`), and `turn_end` archives it and emits the `goal_completed` ledger event with `archivePath` (`goal.ts:4365-4409`).
- **No success `ctx.ui.notify` exists anywhere on the completion happy path.** The only notify in the archival block is the failure case (`goal.ts:~4383`). (C1, C3)
- The auditor `<approved/>` verdict reaches the user only as a transient `GOAL_AUDIT_ENTRY` message ("Goal audit approved") and a tool-result line ("Goal complete."), neither of which names the archive path or reads as final closure. (C3, `goal.ts:3619-3631`; `goal-policy.ts:349-365`)
- The archive path is surfaced **only to the ledger** (`goal.ts:4397-4405`), never as a user notification. (C3)
- `stopReason: "agent"` set on the completed goal leaks the string `Stop reason: agent` into the tool details (`goal.ts:299`) and the widget (`goal-widget.ts:338`), reinforcing a "the agent stopped" reading. (C2)

The fix is **additive surfacing** (a completion notify on the `turn_end` success branch + a completion notification builder), optionally plus dropping `stopReason: "agent"` on the complete path. No logic needs to change.
