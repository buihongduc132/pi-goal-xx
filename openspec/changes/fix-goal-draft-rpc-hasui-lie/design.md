## Context

pi reports `ctx.hasUI === true` in two modes that look identical to a naive boolean check but have very different UI surfaces:

| `ctx.mode` | `hasUI` | `ctx.ui.custom()` |
| --- | --- | --- |
| `interactive` (full TUI) | `true` | real overlay (works) |
| `rpc` (Web UI / RPC child) | `true` (**lies**) | hardcoded no-op `return undefined` |
| `print` (`pi -p`) | `false` | n/a |

Current pi-goal code gates every TUI-overlay branch on `ctx.hasUI`. In RPC mode this routes execution into `ctx.ui.custom()`, which returns `undefined`. Callers then do `result.cancelled` / `result.answers` → `TypeError: Cannot read properties of undefined`. Concrete failure point:

```
propose_goal_draft.execute
  → shouldAutoConfirmProposal({ hasUI: ctx.hasUI })        // returns false because hasUI=true
  → showProposalDialog(ctx, ...)
      → runGoalQuestionnaire(ctx, ...)
          if (!ctx.hasUI) return ...                        // skipped (hasUI lies true)
          return await ctx.ui.custom<GoalQuestionnaireResult>(...)  // RPC no-op → undefined
      result.cancelled                                      // TypeError
```

Source-verified against `@earendil-works/pi-coding-agent` dist (`rpc-mode.js`) and the pi-webui-configuration reference `flow/references/behavior.md` ("The `ctx.hasUI` lie").

Affected call sites (rg `ctx.ui.custom|ctx.hasUI|showProposalDialog` in `extensions/`):
- `extensions/goal-questionnaire.ts` — `runGoalQuestionnaire`, `goal_question`, `goal_questionnaire`, `shouldAutoConfirmProposal`.
- `extensions/goal.ts` — `propose_goal_draft`, `propose_goal_tweak`, `propose_task_list`, complete-goal auditor confirm, plus `showTaskListOverlay`/`showEscapeDialog` invocations.
- `extensions/widgets/task-list-overlay.ts`, `extensions/widgets/goal-escape-dialog.ts`.

## Goals / Non-Goals

**Goals:**
- Eliminate the `TypeError` crash for every pi-goal custom-dialog tool when running under the Web UI (RPC mode).
- Make the dialog-vs-headless decision driven by `ctx.mode` so future RPC behavior changes (e.g. a real bridged `ctx.ui.select` dialog) can be slotted in without re-litigating the gate.
- Keep interactive (full TUI) behavior byte-for-byte unchanged.
- Add a regression test that simulates the RPC lie (`hasUI=true`, `mode="rpc"`) and asserts graceful handling.

**Non-Goals:**
- Building a true browser-native Confirm / Continue Chatting dialog for the Web UI. (That requires bridging `ctx.ui.select` or a new T1 dialog on the pi core / pi-package-webui side — out of scope for this repo, tracked as a follow-up.)
- Changing the headless / `pi -p` behavior.
- Changing `shouldAutoConfirmProposal`'s `PI_GOAL_AUTO_CONFIRM=0` opt-out semantics.
- Touching any non-pi-goal extension.

## Decisions

### D1 — Gate on `ctx.mode === "interactive"`, treat `rpc` as headless
Replace `if (!ctx.hasUI)` / `shouldAutoConfirmProposal({ hasUI })` with `ctx.mode === "interactive"` checks.

**Why over alternatives:**
- *Alt A: gate on `ctx.hasUI && ctx.mode !== "rpc"`* — equivalent in effect but keeps `hasUI` in the predicate, inviting future regressions when someone copy-pastes the old `if (!ctx.hasUI)` pattern. Making `interactive` the single positive signal is self-documenting.
- *Alt B: feature-detect `typeof ctx.ui.custom` / try-catch the no-op* — `ctx.ui.custom` exists and is callable in RPC; it just returns `undefined`. Detection would require inspecting `ctx.mode` anyway, and try/catch around a silent `undefined` return does not work (no throw to catch).

### D2 — Extend `shouldAutoConfirmProposal` signature with `mode`
`shouldAutoConfirmProposal({ hasUI, autoConfirmEnv, mode })`:
- `mode === "rpc" || mode === "print"` → `true` (headless-style auto-confirm), UNLESS `autoConfirmEnv === "0"`.
- `mode === "interactive"` → existing behavior (`autoConfirmEnv === "1"` wins, else `false`).
- `autoConfirmEnv === "0"` → `false` always (benchmark opt-out preserved).

`hasUI` is kept as a parameter for signature backward-compat / future use but is no longer the deciding signal.

**Why not drop `hasUI` entirely:** the function is exported and used by tests; keeping the field avoids a breaking signature change and documents that the legacy signal exists.

### D3 — `runGoalQuestionnaire` short-circuit moves before `ctx.ui.custom`
Change `if (!ctx.hasUI) return ...` to `if (ctx.mode !== "interactive") return ...`. This is the load-bearing fix: even if a caller forgets D2 and still reaches `runGoalQuestionnaire` in RPC mode, the function declines gracefully instead of calling the no-op `ctx.ui.custom()`.

### D4 — Widget / overlay entry guards use the same gate
`showTaskListOverlay` (task-list-overlay.ts:29) and `showEscapeDialog` (goal-escape-dialog.ts:23) currently guard on `ctx.hasUI`. Change to `ctx.mode === "interactive"`. These are user-triggered (keybinding) paths so they are unlikely to fire in RPC, but for consistency and to prevent a latent crash if a keybinding ever does fire, gate them identically.

### D5 — Single `isInteractiveTui(ctx)` helper
Add a tiny helper (e.g. in `goal-core.ts` or `goal-questionnaire.ts`) — `export function isInteractiveTui(ctx: ExtensionContext): boolean { return ctx.mode === "interactive"; }` — and use it everywhere. Centralizes the rule so a future pi-core API change is a one-line edit, not a repo-wide hunt.

**Why:** the alternative — inlining `ctx.mode === "interactive"` at ~10 call sites — duplicates the literal and makes a later widening (e.g. accepting a new `"tui-v2"` mode) painful.

## Risks / Trade-offs

- **[Risk] RPC users silently auto-confirm goals, losing the Confirm/Continue Chatting gate.** → *Mitigation*: this is strictly better than the current crash (today they get neither a dialog NOR a created goal). The agent's existing drafting prompt protocol still makes it interview the user before proposing. `PI_GOAL_AUTO_CONFIRM=0` remains an explicit opt-out. A future upstream T1-bridged dialog is the full fix (follow-up, not here).
- **[Risk] pi-core changes the `ctx.mode` enum values or adds a new interactive mode.** → *Mitigation*: D5 helper centralizes the predicate; a widening is a one-line change. Add a defensive fallback that treats unknown modes as non-interactive (fail-safe toward headless, never toward crashing `ctx.ui.custom`).
- **[Risk] A call site is missed.** → *Mitigation*: the regression test asserts the two highest-traffic paths (`propose_goal_draft`, `runGoalQuestionnaire`). Add a grep-based check in `tasks.md` (task: assert no remaining `if (!ctx.hasUI)` / `shouldAutoConfirmProposal({ hasUI:` patterns in `extensions/`).
- **[Trade-off] Keeping `hasUI` in the `shouldAutoConfirmProposal` signature** is mild cruft. Accepted to avoid a breaking export change.

## Migration Plan

1. Land D5 helper + D2/D3/D4 gate changes in one commit (no behavior change in `interactive` mode).
2. Add regression tests (D-regression) in the same commit.
3. Smoke: `pnpm test` (or `npm test`) — existing 310 tests must stay green; new RPC-mode tests must pass.
4. Manual smoke in Web UI: invoke `/goals <topic>` from the browser, confirm `propose_goal_draft` no longer throws and creates the goal via auto-confirm.
5. Rollback: revert the single commit; behavior returns to today's crash (no data written by the fix itself, so rollback is safe).

## Open Questions

- Should we file an upstream issue against `@capyup/pi-goal` and pi-goal-x so the fix propagates beyond this fork? (Out of scope for this change, but recommended follow-up — see proposal Impact.)
- Does the Web UI team plan a T1-bridged dialog for `ctx.ui.custom`? If yes, the auto-confirm fallback in D2 becomes a temporary shim. If no, RPC users are stuck with auto-confirm until pi-package-webui adds a bridge.
