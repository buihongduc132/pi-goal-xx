## Why

`propose_goal_draft` (and every pi-goal tool that builds a TUI dialog via `ctx.ui.custom()`) crashes when Pi runs in **RPC mode** under the Web UI. The extension gates dialog branches on `ctx.hasUI`, but pi reports `ctx.hasUI === true` in RPC mode while `ctx.ui.custom()` is a hardcoded no-op returning `undefined`. The tool then dereferences `undefined.cancelled` and throws `TypeError: Cannot read properties of undefined (reading 'cancelled')`, so no goal can ever be drafted/confirmed from the browser UI.

## What Changes

- Gate all custom-dialog branches on **`ctx.mode`** (`"interactive"` vs `"rpc"` / `"print"`), NOT on the misleading `ctx.hasUI` boolean.
- `shouldAutoConfirmProposal` (headless auto-confirm decision) MUST treat `ctx.mode === "rpc"` the same as headless, so RPC takes the auto-confirm path instead of the T3-impossible `ctx.ui.custom()` path.
- `runGoalQuestionnaire` MUST short-circuit (return a cancelled/headless result) when `ctx.mode !== "interactive"`, even if `ctx.hasUI === true`, before ever calling `ctx.ui.custom()`.
- Apply the same `ctx.mode` gate to `goal_question`, `goal_questionnaire`, `propose_goal_tweak`, `propose_task_list`, the complete-goal auditor confirm dialog, `showTaskListOverlay`, and `showEscapeDialog`.
- Add a regression test that drives `propose_goal_draft` / `runGoalQuestionnaire` with a stubbed `ctx` where `hasUI=true` and `mode="rpc"` and asserts no `TypeError` and a graceful headless result.

## Capabilities

### New Capabilities
- `rpc-ui-mode-gating`: How pi-goal tools choose between the TUI dialog surface (`ctx.ui.custom()`), the headless auto-confirm path, and the early-cancelled questionnaire path. Defines that the choice MUST be driven by `ctx.mode` (`interactive` / `rpc` / `print`), with `ctx.hasUI` treated as unreliable because RPC mode reports `hasUI === true` while providing no `custom()` surface.

### Modified Capabilities
<!-- No existing spec covers dialog/confirmation behavior or RPC-mode handling, so no deltas to existing capabilities. -->

## Impact

- **Code**:
  - `extensions/goal-questionnaire.ts` — `shouldAutoConfirmProposal`, `runGoalQuestionnaire`, and the `goal_question` / `goal_questionnaire` execute() blocks.
  - `extensions/goal.ts` — `propose_goal_draft`, `propose_goal_tweak`, `propose_task_list`, complete-goal auditor confirm, and any other `ctx.ui.custom` / `showProposalDialog` / `showTaskListOverlay` / `showEscapeDialog` call sites.
  - `extensions/widgets/task-list-overlay.ts`, `extensions/widgets/goal-escape-dialog.ts` — gate entry on `ctx.mode === "interactive"`.
- **Behavior**: Web UI (RPC) users will no longer hit a `TypeError`; `propose_goal_draft` will auto-confirm (matching current headless/`pi -p` behavior) until a bridged T1 dialog is built upstream. This is a graceful-degradation fix, not a true browser-native Confirm/Continue dialog.
- **Dependencies**: None. Pure extension-internal fix; no new packages.
- **Risk**: Auto-confirm in RPC means the user loses the interactive Confirm/Continue Chatting gate when drafting from the Web UI. Mitigated by the agent's existing prompt protocol (it already asks the user to discuss before proposing) and by the existing `PI_GOAL_AUTO_CONFIRM=0` opt-out. A future upstream change bridging `ctx.ui.select` (T1) is the full fix (tracked as a follow-up, NOT in this change).
