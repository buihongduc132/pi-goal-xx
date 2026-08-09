# Plan — Granular Prompt Building for Disabled Tools (prompt-custom-parts)

- date: 2026-07-18
- intention: flow/intentions/2026-07-18_prompt-custom-parts.md
- openspec change: openspec/changes/add-prompt-tool-instruction-config/
- revision: r2 (incorporates gotcha-finder findings G1-G8, scenarios S1-S5, rollback D4)

## Problem

`settings.disabledTools` hides a tool from the agent (`active.delete(name)` in `goal.ts:723`) but does NOT touch the prompt. The prompt builders in `extensions/prompts/goal-prompts.ts` hardcode tool-instruction lines unconditionally. Disabling `pause_goal` → prompt still says "call pause_goal when blocked" → prompt-tool drift.

## Design

### Settings schema

New top-level key `toolInstructions?: Record<string, PromptConfig>`:

```json
{
  "disabledTools": ["pause_goal", "goal_question"],
  "toolInstructions": {
    "pause_goal": { "mode": "global-local" },
    "goal_question": { "mode": "override", "inline": "Use intercom to ask the supervisor." }
  }
}
```

- Keyed by tool name (`pause_goal`, `goal_question`, `goal_questionnaire`, `abort_goal`, `complete_goal`)
- Each value is `PromptConfig` (`{ mode?, inline? }`) — same shape as existing `prompts.<key>`
- File resolution: key `tool-instruction-<toolName>` → `<promptsDir>/tool-instruction-<toolName>.md`

### Behavior matrix

| Tool disabled? | `toolInstructions[name]` | Result |
|:-:|:-:|:--|
| No | any | Default instruction emitted (current behavior) |
| Yes | not set | Default instruction OMITTED |
| Yes | set | Default instruction OMITTED; replacement text injected via `resolvePrompt` |

### Instruction extraction

Extract tool-specific instruction text from the 6 prompt builders into named helper functions in a new module `extensions/prompts/tool-instruction-parts.ts`:

| Helper | Tools covered | Used by |
|:--|:-:|:-:|
| `pauseGoalBodyInstruction` | `pause_goal` | goalPrompt, continuationPrompt (verbose paragraph) |
| `pauseGoalSisyphusBullet` | `pause_goal` | sisyphusDisciplineBlock (one-liner bullet) |
| `askUserInstruction` | `goal_question`, `goal_questionnaire` | goalPrompt, continuationPrompt, goalDraftingPrompt, goalTweakDraftingPrompt |
| `abortGoalInstruction` | `abort_goal` | goalPrompt, continuationPrompt |
| `completeGoalInstruction` | `complete_goal` | goalPrompt, continuationPrompt |

**Why two `pause_goal` helpers (G2)**: the codebase has TWO different `pause_goal` instruction texts:
1. Verbose multi-sentence paragraph in `goalPrompt`/`continuationPrompt`.
2. Single one-liner bullet in `sisyphusDisciplineBlock`.
A single helper would inject the verbose paragraph into the bullet list (wrong text). Split into `pauseGoalBodyInstruction` (verbose) and `pauseGoalSisyphusBullet` (one-liner).

Each helper:
1. If tool NOT disabled → return the hardcoded default text
2. If disabled + no replacement config → return `""`
3. If disabled + replacement config → resolve via `resolvePrompt("tool-instruction-<name>", cfg, cwd, "", opts)` and return the resolved text

**`askUserInstruction` pair-check with text correctness (G3)**: checks if BOTH `goal_question` AND `goal_questionnaire` are disabled before suppressing. If only one disabled, returns text referencing only the available tool (parameterized `DEFAULT_ASK_USER_SINGLE_TEMPLATE`), avoiding text that points the agent at a missing tool.

### Settings parsing

In `goal-settings.ts`:
- Add `toolInstructions` to `ALLOWED_SETTINGS_KEYS`
- Add `asToolInstructionsBlock(raw)` validator (same shape as `asPromptsBlock` but keys are tool names, not prompt keys)
- Add to `parseGoalSettings`, `loadGoalSettings`, `saveGoalSettingsFileConfig`
- Add to `KNOWN_PROMPT_KEYS` or handle via separate validation path (decision: separate path — tool names are not prompt keys)

### Prompt builder integration

Each of the 6 builders receives `settings` and `cwd` (most already do). They call the instruction helpers, passing `disabledTools` set and `toolInstructions` config from settings.

**`goalPrompt()` empty-line handling (G1)**: `goalPrompt()` non-override path currently uses a template literal (NOT array-join-filter). If a helper returns `""`, direct interpolation leaves a blank line. Fix: **restructure the non-override path to array-join-with-filter** (matching `continuationPrompt()`). Each helper output becomes an array element; empty strings filtered via `.filter((s) => typeof s === "string" && s.length > 0)` before joining with `"\n"`. This is the explicit empty-line strategy (not post-process replace).

**`goalDraftingPrompt` line splitting (G4)**: the line "Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable." is split:
- Tool clause — gated by `askUserInstruction` (empty when both disabled → omitted).
- Plain-conversation clause — always emitted (still valid guidance).

Builders that need changes:
- `goalPrompt` (in `extensions/prompts/goal-prompts.ts`) — restructure to array-join-filter; pause, ask, abort, complete instructions
- `continuationPrompt` (in `goal-prompts.ts`) — pause, ask, abort, complete instructions (already array-join-filter)
- `sisyphusDisciplineBlock` (in `goal-prompts.ts`) — pause sisyphus bullet; add `(settings?, cwd?)` params; update all 4 call sites (G8)
- `goalDraftingPrompt` (in `extensions/goal-draft.ts`) — ask instruction; split line (G4)
- `goalTweakDraftingPrompt` (in `goal-prompts.ts`) — ask instruction, pause instruction; opportunistic G7 duplicate-line fix
- `staleContinuationPrompt` — no tool instructions (no change)
- `unfocusedOpenGoalsPrompt` — no tool instructions (no change)

### `sisyphusDisciplineBlock` call sites (G8 — all 4 enumerated)

1. `goalPrompt()` override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
2. `goalPrompt()` non-override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
3. `continuationPrompt()` override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
4. `continuationPrompt()` non-override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`

### Rollback plan (D4)

- **Config-only rollback**: removing `toolInstructions` only disables replacement text injection. Suppression of default instructions for disabled tools remains active.
- **Full rollback**: requires code revert (extension version downgrade). No config flag to disable suppression independently.
- This is intentional — the suppression IS the fix for prompt-tool drift.

### File resolution naming

Tool instruction files use the key pattern `tool-instruction-<toolName>`:
- `tool-instruction-pause_goal.md`
- `tool-instruction-goal_question.md`
- `tool-instruction-goal_questionnaire.md`
- `tool-instruction-abort_goal.md`
- `tool-instruction-complete_goal.md`

These live in `<promptsDir>/` (default `.pi/pi-goal-xx/prompts/`).

## TDD Breakdown

### RED phase (tests first — separate sub agent)

1. **Settings parsing tests** (`tests/tool-instruction-settings.test.ts`):
   - `toolInstructions` block parsed correctly
   - Invalid tool name key accepted (any string key allowed)
   - Invalid mode rejected
   - Round-trip through save/load (**scenario S5**)
   - `toolInstructions` mode `"off"` accepted (**scenario S1**)

2. **Instruction helper tests** (`tests/tool-instruction-parts.test.ts`):
   - `pauseGoalBodyInstruction`: enabled → verbose default text; disabled → ""; disabled + replacement → resolved text
   - `pauseGoalSisyphusBullet`: enabled → one-liner bullet; disabled → ""; disabled + replacement → resolved text (same config as body)
   - **G2 assertion**: `pauseGoalBodyInstruction` and `pauseGoalSisyphusBullet` return DIFFERENT default texts when enabled
   - `askUserInstruction`: both enabled → default; only `goal_question` disabled → single-tool text referencing `goal_questionnaire` (**G3 / S3**); both disabled → suppressed
   - Same pattern for `abortGoalInstruction`, `completeGoalInstruction`
   - File-based replacement resolution (create tmp file, verify resolved)
   - Inline replacement resolution
   - Empty file + no inline → `""`

3. **Prompt builder integration tests** (`tests/tool-instruction-prompts.test.ts`):
   - `goalPrompt` with `disabledTools: ["pause_goal"]` → no "call pause_goal" text
   - `goalPrompt` with `disabledTools: ["pause_goal"]` + `toolInstructions.pause_goal` → replacement text present
   - `goalPrompt` with `disabledTools: ["pause_goal"]` → NO orphan blank lines (structural: no `\n\n\n` — **G1 / S4**)
   - `goalPrompt` with override mode + `toolInstructions.pause_goal` → override wins, no replacement (**S2**)
   - Same for `continuationPrompt`
   - `goalDraftingPrompt` with `disabledTools: ["goal_question", "goal_questionnaire"]` → no tool clause, but plain-conversation clause present (**G4**)
   - `goalDraftingPrompt` with only `goal_question` disabled → references `goal_questionnaire` (**S3**)
   - `goalTweakDraftingPrompt` with `disabledTools: ["pause_goal"]` → no "pause_goal" reference
   - `sisyphusDisciplineBlock` with `disabledTools: ["pause_goal"]` → no pause bullet, other bullets intact
   - Tool NOT disabled → default text present (regression guard)

### GREEN phase (separate sub agent)

4. Implement `extensions/prompts/tool-instruction-parts.ts` — instruction helpers (5 helpers: 2 pause variants + ask + abort + complete)
5. Implement `asToolInstructionsBlock` in `goal-settings.ts`
6. Wire `toolInstructions` into settings parse/load/save
7. Refactor `goalPrompt` — restructure to array-join-filter (**G1**), use instruction helpers
8. Refactor `continuationPrompt` — use instruction helpers (already array-join-filter)
9. Refactor `sisyphusDisciplineBlock` — use `pauseGoalSisyphusBullet`, add params, update all 4 call sites (**G2, G8**)
10. Refactor `goalDraftingPrompt` — use `askUserInstruction`, split line (**G4**)
11. Refactor `goalTweakDraftingPrompt` — use `pauseGoalBodyInstruction` + `askUserInstruction`; fix duplicate line (**G7**)

### Refactor phase (same GREEN sub agent)

12. Extract hardcoded instruction text into constants in `tool-instruction-parts.ts`
13. Ensure all existing tests still pass (no regression)

## Gotchas (resolved)

1. **G1 (BLOCKER, resolved)**: `goalPrompt()` template literal doesn't filter empties. Fix: restructure to array-join-filter (matches `continuationPrompt()`). Scenario S4 locks it.
2. **G2 (BLOCKER, resolved)**: `pause_goal` has two different instruction texts. Fix: two helpers (`pauseGoalBodyInstruction` + `pauseGoalSisyphusBullet`).
3. **G3 (resolved)**: `askUserInstruction` pair-check text drift. Fix: parameterized single-tool template referencing only the available tool. Scenario S3 locks it.
4. **G4 (resolved)**: `goalDraftingPrompt` line over-suppresses plain-conversation clause. Fix: split line, gate only tool clause.
5. **G5 (resolved)**: Proposal backward-compat wording. Fix: "backward compatible at config layer; behavior change is the intended fix for disabledTools users."
6. **G7 (resolved)**: pre-existing duplicate "User's tweak hint" line in `goalTweakDraftingPrompt`. Fix: opportunistic removal in refactor phase.
7. **G8 (resolved)**: `sisyphusDisciplineBlock` 4 call sites enumerated above.
8. **GOTCHA-3 (resolved)**: `goalDraftingPrompt` references `goal_question` in confirmation protocol. Fix: gated by `askUserInstruction`, split line.
9. **GOTCHA-5 (resolved)**: "Do not use complete_goal=complete to escape a blocker" is a policy statement, NOT a usage instruction. Not gated (stays regardless of `complete_goal` being disabled).
10. **GOTCHA-6 (resolved)**: "Do not ask the user for confirmation unless there is a real blocker" is general policy, not tool-specific. Not gated.

## Spec scenarios (all locked in openspec spec delta)

- S1: `toolInstructions[name].mode = "off"` (unified resolver)
- S2: Precedence when BOTH `prompts.goal-running.mode = "override"` AND `toolInstructions.pause_goal` configured (override wins)
- S3: drafting prompts when only ONE ask-tool disabled
- S4: empty-line handling in `goalPrompt()` after suppression (G1)
- S5: `toolInstructions` round-trip through save/load

## Migration / Backward Compatibility

- No migration needed at the config layer: `toolInstructions` is optional. When absent, behavior is identical to today.
- **Behavior change (G5, intended)**: `disabledTools` without `toolInstructions` → instructions omitted (new behavior, only when user explicitly disables the tool — this IS the fix). Users who already disable lifecycle tools will see their prompts change. This corrects broken behavior.
- Existing `prompts.<key>` override mode still works for the entire prompt body (orthogonal — see D5).

## Risks

- **R1 (HIGH)**: Blast radius — 6 prompt builders run on EVERY goal turn. Structural bug (broken template literal after refactor, empty-line flooding) affects all goal-mode users immediately. Mitigation: RED tests for exact output structure BEFORE any GREEN change; scenario S4 asserts no orphan blank lines.
- **R2 (MED)**: `sisyphusDisciplineBlock` shared by 4 call sites across 2 builders. Signature change + param threading is a regression surface. Mitigation: update all 4 sites in one commit; add regression test that sisyphus + disabled pause_goal produces a well-formed block.
- **R3 (MED)**: Existing `tests/goal-prompts.test.ts` (371 lines) and `goal-prompts-unified.test.ts` (220 lines) may assert on prompt text structure. Run the full suite after GREEN.
- **R4 (LOW)**: `toolInstructions` key name collision risk — mitigated by `ALLOWED_SETTINGS_KEYS` validation.
- **R5 (LOW)**: Auditor prompt correctly out of scope — `extensions/auditor-prompt.ts` has 0 references to lifecycle tools. No change needed.
