## 1. Shared gating helper

- [x] 1.1 Add `isInteractiveTui(ctx: ExtensionContext): boolean` helper (returns `ctx.mode === "interactive"`) to `extensions/goal-core.ts` (or `goal-questionnaire.ts` if no core dependency on `ExtensionContext` is desired). Export it.
- [x] 1.2 Add a defensive fallback: unknown / undefined `ctx.mode` values MUST be treated as non-interactive (fail-safe toward headless, never toward `ctx.ui.custom`).

## 2. shouldAutoConfirmProposal — extend signature with mode

- [x] 2.1 In `extensions/goal-questionnaire.ts`, change `shouldAutoConfirmProposal` to accept `{ hasUI, autoConfirmEnv, mode }` and decide on `mode` per design D2: `mode === "rpc" || mode === "print"` → `true` unless `autoConfirmEnv === "0"`; `mode === "interactive"` → existing behavior; `autoConfirmEnv === "1"` → `true`; `autoConfirmEnv === "0"` → `false`.
- [x] 2.2 Update both callers in `extensions/goal.ts` (`propose_goal_draft.execute` ~line 2470, `propose_goal_tweak.execute` ~line 2675) to pass `mode: ctx.mode`.
- [x] 2.3 Update / add unit tests for `shouldAutoConfirmProposal` covering all four `mode` × `autoConfirmEnv` combinations (rpc+unset→true, interactive+unset→false, rpc+"0"→false, any+"1"→true).

## 3. runGoalQuestionnaire — short-circuit on ctx.mode

- [x] 3.1 In `extensions/goal-questionnaire.ts`, change the entry guard from `if (!ctx.hasUI) return ...` to `if (!isInteractiveTui(ctx)) return ...` (keep the same headless return shape `{ questions: [], answers: [], cancelled: true }`, plus `auditorEnabled` when an auditor toggle was passed).
- [x] 3.2 Add a regression test that stubs a ctx with `hasUI: true, mode: "rpc"` and `ctx.ui.custom = () => undefined` (the RPC lie), calls `runGoalQuestionnaire`, and asserts (a) no throw, (b) returned `cancelled === true`, (c) `ctx.ui.custom` was never invoked.

## 4. goal_question / goal_questionnaire execute blocks

- [x] 4.1 Change `if (!ctx.hasUI)` guards in `goal_question.execute` and `goal_questionnaire.execute` (goal-questionnaire.ts ~560, ~630) to `if (!isInteractiveTui(ctx))`.
- [x] 4.2 Verify the headless return message is unchanged.

## 5. propose_goal_draft / propose_goal_tweak / propose_task_list / complete_goal auditor confirm

- [x] 5.1 In `extensions/goal.ts`, ensure every `showProposalDialog(...)` call site is preceded by a `shouldAutoConfirmProposal({ ..., mode: ctx.mode })` decision (D2) so RPC takes the auto-confirm branch and never reaches `showProposalDialog`. Cover: `propose_goal_draft` (~2470), `propose_goal_tweak` (~2675), `propose_task_list` (~1506, ~3551), complete-goal auditor confirm.
- [x] 5.2 Add an end-to-end-style unit test for `propose_goal_draft.execute` with a stubbed RPC ctx (`hasUI: true, mode: "rpc"`, `ctx.ui.custom` returns undefined) and an active `confirmationIntent`; assert it returns a "Goal confirmed and created." result and does NOT throw.

## 6. Widgets / overlays

- [x] 6.1 `extensions/widgets/task-list-overlay.ts` (~line 29): change `if (!ctx.hasUI) return;` to `if (!isInteractiveTui(ctx)) return;`.
- [x] 6.2 `extensions/widgets/goal-escape-dialog.ts` (~line 23): change `if (!ctx.hasUI)` to `if (!isInteractiveTui(ctx))`.
- [x] 6.3 Audit any remaining `ctx.hasUI` usages in `extensions/` (rg) and confirm each is either (a) replaced with `isInteractiveTui(ctx)` when it guards a `ctx.ui.custom` call, or (b) intentionally left because it gates a fire-and-forget T0 surface (`notify`/`setStatus`) where RPC behavior is correct.

## 7. Regression sweep

- [x] 7.1 Run `npm test` (or `node --experimental-strip-types --test tests/*.test.ts`); all pre-existing tests MUST stay green.
- [x] 7.2 Add a grep-based guard test (or a CI grep step) that fails if any new `if (!ctx.hasUI)` or `shouldAutoConfirmProposal({ hasUI:` pattern appears in `extensions/` without going through `isInteractiveTui` / the `mode` parameter.
- [ ] 7.3 Manual smoke in Web UI: `/goals <topic>` → agent proposes → `propose_goal_draft` no longer throws `TypeError`; goal is created via auto-confirm.

## 8. Docs / flow

- [x] 8.1 Add `flow/bugs/<date>_propose-goal-draft-rpc-crash.md` capturing the root cause, evidence, fix summary, and the follow-up (upstream T1-bridged dialog) — referenced from this change.
- [x] 8.2 Update `AGENTS.md` lesson-learned list with a one-liner pointing at the bug doc (per repo's LSL convention).
