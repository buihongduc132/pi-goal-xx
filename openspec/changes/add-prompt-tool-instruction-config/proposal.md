## Why

`settings.disabledTools` only hides a tool from the agent (`active.delete(name)` in `extensions/goal.ts:723`) but does NOT touch the prompt. The runtime prompt builders in `extensions/prompts/goal-prompts.ts` hardcode tool-instruction lines about lifecycle tools (`pause_goal`, `goal_question`, `abort_goal`, `complete_goal`) unconditionally. Disabling a tool produces **prompt-tool drift**: the prompt still says "call pause_goal when blocked" but the tool doesn't exist → the agent either errors on a missing tool or fabricates a workaround.

There is no per-tool instruction layer today. The existing `prompts.<key>.mode: "override"` replaces an entire prompt *body* (e.g., the full `goal-running` prompt), which is too coarse for suppressing or replacing a single tool's instruction paragraph while keeping the rest of the prompt intact.

## What Changes

- **New settings key `toolInstructions`**: a `Record<string, PromptConfig>` keyed by tool name (`pause_goal`, `goal_question`, `goal_questionnaire`, `abort_goal`, `complete_goal`). Each value is a standard `PromptConfig` (`{ mode?, inline? }`) — same shape as existing `prompts.<key>`. File resolution uses key `tool-instruction-<toolName>` → `<promptsDir>/tool-instruction-<toolName>.md`.

- **Behavior matrix** (applied per tool-instruction in each prompt builder):
  - Tool NOT in `disabledTools` → default instruction emitted (current behavior, no change).
  - Tool in `disabledTools` + no `toolInstructions[name]` → default instruction **OMITTED**.
  - Tool in `disabledTools` + `toolInstructions[name]` configured → default instruction **OMITTED**; replacement text resolved via `resolvePrompt("tool-instruction-<name>", cfg, cwd, "", opts)` and **injected** in its place.

- **Instruction extraction**: tool-specific instruction text in the 6 runtime prompt builders extracted into named helpers in a new module `extensions/prompts/tool-instruction-parts.ts`. Each helper takes `(settings, cwd)` and returns the appropriate text (default / empty / replacement).

- **`pause_goal` has two text variants**: `pauseGoalBodyInstruction` (verbose paragraph for goalPrompt/continuationPrompt) and `pauseGoalSisyphusBullet` (one-liner for sisyphusDisciplineBlock). Without this split, injecting the verbose text into the sisyphus bullet list would corrupt the block.

- **`askUserInstruction` pair-check with text correctness**: when only one of `goal_question`/`goal_questionnaire` is disabled, the instruction is rewritten to reference only the available tool (avoiding text that points the agent at a missing tool).

- **`goalDraftingPrompt` line splitting**: the combined tool + plain-conversation line is split — tool clause gated, plain-conversation clause always emitted.

- **`goalPrompt()` restructure**: the non-override path is restructured from a template literal to an array-join-with-filter pattern (matching `continuationPrompt()`), so that helpers returning `""` produce no orphan blank lines.

- **NOT in scope**: replacing the entire prompt body (already exists via `prompts[key].mode: "override"`); new lifecycle tools; UI / TUI changes for the new config; auto-detecting which instruction lines reference which tool (the mapping is hand-curated in the helpers).

## Capabilities

### New Capabilities
- `prompt-tool-instruction-config`: Per-tool instruction suppression and replacement when a tool is disabled. Lets the user omit the default instruction for a disabled tool or provide a custom replacement (inline or file-based) that is injected in its place.

### Modified Capabilities
None. The feature layers on top of the existing `disabledTools` setting and the existing `resolvePrompt` resolver without altering their behavior.

## Impact

- **Affected code**:
  - `extensions/prompts/tool-instruction-parts.ts` (new) — instruction helpers (`pauseGoalBodyInstruction`, `pauseGoalSisyphusBullet`, `askUserInstruction`, `abortGoalInstruction`, `completeGoalInstruction`).
  - `extensions/prompts/goal-prompts.ts` — refactor `goalPrompt` (restructure template literal → array-join-filter), `continuationPrompt`, `goalTweakDraftingPrompt` to call the helpers. Gate `sisyphusDisciplineBlock` on `pause_goal` being disabled; add `(settings?, cwd?)` params; update all 4 call sites.
  - `extensions/goal-draft.ts` — refactor `goalDraftingPrompt` to call `askUserInstruction`; split tool clause from plain-conversation clause.
  - `extensions/goal-settings.ts` — add `toolInstructions` to `GoalSettings`, `ALLOWED_SETTINGS_KEYS`, parse/load/save paths, and a new `asToolInstructionsBlock` validator.
  - `extensions/prompt-resolver.ts` — no change (reused as-is via `resolvePrompt`).
- **New settings keys**: `toolInstructions` (top-level, `Record<string, PromptConfig>`).
- **File resolution naming**: `<promptsDir>/tool-instruction-<toolName>.md` (e.g., `tool-instruction-pause_goal.md`).
- **Dependencies**: none new. Reuses `resolvePrompt` from `prompt-resolver.ts`.
- **Backward compatibility**: backward compatible at the config layer (`toolInstructions` is a new optional key; absent = no change). Behavior change is the intended fix for users who already disable lifecycle tools: their prompts will now omit the default tool instructions for disabled tools (previously those instructions were emitted unconditionally, causing prompt-tool drift). This is a semantic change visible to existing `disabledTools` users, but it corrects broken behavior.
- **Rollback**: config-only rollback (removing `toolInstructions`) only disables replacement text injection. The suppression of default instructions for disabled tools remains active. Full rollback requires a code revert (extension version downgrade). See design.md D6 for details.
- **Out of scope**: auto-parsing which instruction lines reference which tool (hand-curated mapping); gating non-tool-specific policy statements that happen to mention a tool name (e.g., "Do not use complete_goal=complete to escape a blocker" stays — it's a policy statement, not a usage instruction).
