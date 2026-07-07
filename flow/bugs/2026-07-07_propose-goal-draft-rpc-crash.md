# Bug — `propose_goal_draft` (and all custom-dialog tools) crash in Web UI / RPC mode

- **Date:** 2026-07-07
- **Severity:** High (blocks all goal drafting from the browser UI)
- **Status:** Diagnosed; fix proposed in `openspec/changes/fix-goal-draft-rpc-hasui-lie/`
- **Affects:** pi-goal-xx (and upstream `pi-goal-x` / `@capyup/pi-goal` by descent — unverified upstream)

## Symptom

Running `propose_goal_draft` (or `propose_goal_tweak`, `propose_task_list`, the complete-goal auditor confirm, `goal_question`, `goal_questionnaire`) while Pi is spawned by the Web UI throws:

```
TypeError: Cannot read properties of undefined (reading 'cancelled')
```

User-visible message (caught by `proposalDialogFailureMessage`):

> Goal draft confirmation failed: Cannot read properties of undefined (reading 'cancelled'). The goal was NOT created; drafting remains active.

No goal can be drafted or confirmed from the browser.

## Root Cause

Two compounding facts about pi's RPC mode:

**[C1] `ctx.hasUI` lies in RPC mode.** pi reports `ctx.hasUI === true` in BOTH `interactive` (full TUI) AND `rpc` (Web UI / RPC child) mode. Only `print` (`pi -p`) reports `false`. Source-verified against `@earendil-works/pi-coding-agent` dist (`rpc-mode.js`) and `../pi-webui-configuration/flow/references/behavior.md` ("The `ctx.hasUI` lie").

| `ctx.mode` | `hasUI` | `ctx.ui.custom()` |
| --- | --- | --- |
| `interactive` | `true` | real overlay (works) |
| `rpc` | `true` (**lies**) | **hardcoded no-op `return undefined`** |
| `print` | `false` | n/a |

**[C2] `ctx.ui.custom()` is a T3-impossible surface in RPC.** It exists, is callable, but returns `undefined` regardless of arguments. There is nothing to catch — it does not throw.

pi-goal gates every TUI-overlay branch on `ctx.hasUI`. In RPC mode the gate lets execution through into `ctx.ui.custom()`, which returns `undefined`; the caller then dereferences `result.cancelled` / `result.answers` and crashes.

## Failure Chain

```
propose_goal_draft.execute(ctx)                         // ctx.mode === "rpc", ctx.hasUI === true
  → validateGoalDraftProposal(...)                       // passes (intent set, schema ok)
  → shouldAutoConfirmProposal({ hasUI: ctx.hasUI })      // → false  [C1: hasUI lies true]
  → showProposalDialog(ctx, draftSummary, ...)
      → runGoalQuestionnaire(ctx, ...)
          if (!ctx.hasUI) return ...                     // SKIPPED (hasUI lies true)
          return await ctx.ui.custom<GoalQuestionnaireResult>(...)  // [C2] RPC no-op → undefined
      result = undefined
      result.cancelled                                   // TypeError: Cannot read properties of undefined
  → catch (err) → proposalDialogFailureMessage(err)
  → "Goal draft confirmation failed: … reading 'cancelled'"
```

Same skeleton hits every tool that funnels through `runGoalQuestionnaire` / `showProposalDialog` / a direct `ctx.ui.custom` call.

## Evidence

- `extensions/goal-questionnaire.ts:61` — `shouldAutoConfirmProposal({ hasUI, autoConfirmEnv })` decides on `hasUI`.
- `extensions/goal-questionnaire.ts:88-97` — `runGoalQuestionnaire` gates `if (!ctx.hasUI) return ...` else `ctx.ui.custom(...)`.
- `extensions/goal-questionnaire.ts:514` — `showProposalDialog` → `runGoalQuestionnaire`.
- `extensions/goal.ts:2470` — `propose_goal_draft.execute` → `shouldAutoConfirmProposal({ hasUI: ctx.hasUI })`.
- `extensions/goal.ts:2480` — `showProposalDialog(ctx, ...)`.
- Same shape at `goal.ts:2675` (`propose_goal_tweak`), `goal.ts:1506` & `goal.ts:3551` (`propose_task_list`), complete-goal auditor confirm.
- `extensions/widgets/task-list-overlay.ts:29`, `extensions/widgets/goal-escape-dialog.ts:23` — same `ctx.hasUI` gate in front of `ctx.ui.custom`.
- External corroboration: `../pi-webui-configuration/flow/references/behavior.md` documents the `ctx.hasUI` lie and the T3 `custom()` no-op.

## Fix (proposed)

Drive every dialog-vs-headless decision off `ctx.mode === "interactive"`, never `ctx.hasUI`:

1. Add `isInteractiveTui(ctx) = ctx.mode === "interactive"` helper; unknown modes fail-safe to non-interactive.
2. `shouldAutoConfirmProposal({ hasUI, autoConfirmEnv, mode })` — treat `mode === "rpc" || mode === "print"` as headless (auto-confirm), preserving the `PI_GOAL_AUTO_CONFIRM=0` opt-out.
3. `runGoalQuestionnaire` — short-circuit before `ctx.ui.custom()` when `!isInteractiveTui(ctx)`.
4. Apply the same gate to `goal_question`, `goal_questionnaire`, `propose_goal_tweak`, `propose_task_list`, auditor confirm, `showTaskListOverlay`, `showEscapeDialog`.

Full breakdown: `openspec/changes/fix-goal-draft-rpc-hasui-lie/{proposal,design,specs/rpc-ui-mode-gating/spec,tasks}.md`.

## Trade-off / Follow-up

The fix makes RPC fall back to **auto-confirm** (same as `pi -p` headless). That is strictly better than the crash, but it costs the browser user the interactive Confirm / Continue Chatting gate. The agent's existing drafting prompt protocol still makes it interview the user before proposing, and `PI_GOAL_AUTO_CONFIRM=0` remains an explicit opt-out.

**Real fix (follow-up, out of scope for this change):** bridge a T1 dialog (`ctx.ui.select` works in RPC) on the pi-core / `@firstpick/pi-package-webui` side so the Web UI gets a native Confirm/Continue picker instead of silent auto-confirm.

## Lesson

**Never gate a `ctx.ui.custom()` call on `ctx.hasUI`.** `hasUI` is true in RPC mode where `custom()` is a no-op. Always gate on `ctx.mode === "interactive"`. Centralize the check in one helper so a future pi-core API change is a one-line fix.
