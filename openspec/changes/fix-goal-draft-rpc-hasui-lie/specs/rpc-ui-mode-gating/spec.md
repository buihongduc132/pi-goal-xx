## ADDED Requirements

### Requirement: Custom-dialog tools MUST gate on ctx.mode, not ctx.hasUI

pi-goal tools that build a TUI overlay via `ctx.ui.custom()` (or that branch on "should we show the interactive dialog vs. take the headless path") SHALL decide which branch to take using `ctx.mode`, NOT `ctx.hasUI`. The modes are:

- `ctx.mode === "interactive"` → full TUI; `ctx.ui.custom()` works.
- `ctx.mode === "rpc"` → Web UI / headless RPC child; `ctx.hasUI` reports `true` but `ctx.ui.custom()` is a no-op returning `undefined`. Tools MUST treat RPC identically to headless.
- `ctx.mode === "print"` → `pi -p` one-shot; `ctx.hasUI === false`; tools already treat this as headless.

Rationale: gating on `ctx.hasUI` misclassifies RPC mode as a real TUI and routes execution into the T3-impossible `ctx.ui.custom()` path, which returns `undefined` and crashes the caller when it dereferences the expected result object.

This applies to (at minimum): `propose_goal_draft`, `propose_goal_tweak`, `propose_task_list`, the complete-goal auditor confirmation dialog, `goal_question`, `goal_questionnaire`, `showTaskListOverlay`, and `showEscapeDialog`.

#### Scenario: propose_goal_draft in RPC mode does not crash
- **WHEN** `propose_goal_draft.execute` runs with `ctx.mode === "rpc"` (and `ctx.hasUI === true`), all schema gates pass, and `PI_GOAL_AUTO_CONFIRM` is unset
- **THEN** the tool MUST take the auto-confirm branch (same as the existing headless path), MUST NOT call `ctx.ui.custom()`, and MUST return a successful "Goal confirmed and created." result without throwing a `TypeError`.

#### Scenario: runGoalQuestionnaire in RPC mode returns a headless-style result
- **WHEN** `runGoalQuestionnaire` is invoked with `ctx.mode === "rpc"` (and `ctx.hasUI === true`)
- **THEN** the function MUST return the headless result shape `{ questions: [], answers: [], cancelled: true }` (or, for callers that pass a default auditor toggle, the same shape with `auditorEnabled` populated) WITHOUT invoking `ctx.ui.custom()`.

#### Scenario: goal_question / goal_questionnaire in RPC mode behave as headless
- **WHEN** `goal_question.execute` or `goal_questionnaire.execute` runs with `ctx.mode === "rpc"` (and `ctx.hasUI === true`)
- **THEN** the tool MUST return the documented headless-mode message (no interactive UI answer collected) and MUST NOT call `ctx.ui.custom()`.

#### Scenario: interactive mode still shows the real dialog
- **WHEN** any of the above tools runs with `ctx.mode === "interactive"`
- **THEN** the existing TUI dialog path (`ctx.ui.custom`) MUST be taken exactly as before; behavior in interactive mode MUST be unchanged.

### Requirement: shouldAutoConfirmProposal treats RPC mode as headless

`shouldAutoConfirmProposal({ hasUI, autoConfirmEnv, mode })` SHALL return `true` when `mode === "rpc"` OR `mode === "print"` OR `autoConfirmEnv === "1"`, and SHALL return `false` only when `mode === "interactive"` AND `autoConfirmEnv !== "1"`. The `autoConfirmEnv === "0"` explicit opt-out MUST still force `false` regardless of mode.

The function signature SHALL be extended to accept the `mode` field. Callers MUST pass `ctx.mode`. Callers that previously passed only `ctx.hasUI` MUST be updated.

#### Scenario: RPC mode auto-confirms
- **WHEN** `shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: undefined, mode: "rpc" })` is called
- **THEN** it SHALL return `true`.

#### Scenario: Interactive mode without opt-in does not auto-confirm
- **WHEN** `shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: undefined, mode: "interactive" })` is called
- **THEN** it SHALL return `false` (existing TUI dialog path is taken).

#### Scenario: PI_GOAL_AUTO_CONFIRM=0 forces non-auto-confirm even in RPC
- **WHEN** `shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0", mode: "rpc" })` is called
- **THEN** it SHALL return `false` (explicit benchmark opt-out preserved). Callers in RPC mode with this opt-out MUST then gracefully decline instead of crashing (see Requirement: Custom-dialog tools MUST gate on ctx.mode, not ctx.hasUI — the runGoalQuestionnaire short-circuit still applies).

### Requirement: runGoalQuestionnaire short-circuits before ctx.ui.custom in non-interactive modes

`runGoalQuestionnaire` SHALL check `ctx.mode` before calling `ctx.ui.custom()`. If `ctx.mode !== "interactive"`, the function MUST return the headless result shape immediately without invoking `ctx.ui.custom()`, regardless of the value of `ctx.hasUI`.

#### Scenario: RPC mode short-circuit fires even though hasUI is true
- **WHEN** `runGoalQuestionnaire` is invoked with `ctx.hasUI === true` and `ctx.mode === "rpc"`
- **THEN** it SHALL return `{ questions: [], answers: [], cancelled: true }` (plus `auditorEnabled` when an auditor toggle was passed) and SHALL NOT call `ctx.ui.custom()`.

#### Scenario: Print mode short-circuit unchanged
- **WHEN** `runGoalQuestionnaire` is invoked with `ctx.mode === "print"` (and `ctx.hasUI === false`)
- **THEN** the existing headless return MUST continue to fire (no behavior change).
