# prompt-config-resolution Specification — Delta

## New Requirement: Per-tool instruction suppression and replacement

The system SHALL support per-tool instruction suppression and replacement in runtime prompt builders when a tool is listed in `settings.disabledTools`. The behavior is governed by a new `settings.toolInstructions` block (`Record<string, PromptConfig>`).

For each tool-instruction in a runtime prompt builder, the system SHALL:
1. If the tool is NOT in `disabledTools` → emit the hardcoded default instruction text (current behavior, no change).
2. If the tool IS in `disabledTools` AND no `toolInstructions[<toolName>]` entry exists → omit the default instruction entirely (return empty string).
3. If the tool IS in `disabledTools` AND `toolInstructions[<toolName>]` is configured → omit the default instruction AND inject the replacement text resolved via `resolvePrompt("tool-instruction-<toolName>", cfg, cwd, "", opts)`.

The tool-instruction config uses the same `PromptConfig` shape (`{ mode?, inline? }`) as the existing `prompts.<key>` entries. File resolution uses the key pattern `tool-instruction-<toolName>` → `<promptsDir>/tool-instruction-<toolName>.md`.

The following tools are gated by this requirement:
- `pause_goal` — blocker-channel instruction (two text variants: verbose body for goalPrompt/continuationPrompt, one-liner bullet for sisyphusDisciplineBlock)
- `goal_question` / `goal_questionnaire` — ask-user instruction (gated as a pair: only suppressed when BOTH are disabled)
- `abort_goal` — abandon instruction
- `complete_goal` — completion instruction

#### Scenario: Tool disabled without replacement config omits default instruction

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **AND** `settings.toolInstructions` does NOT contain a `pause_goal` entry
- **THEN** `goalPrompt()` does NOT contain the default "call pause_goal when blocked" instruction paragraph
- **AND** `continuationPrompt()` does NOT contain the default "call pause_goal" instruction paragraph

#### Scenario: Tool disabled with inline replacement injects replacement text

- **WHEN** `settings.disabledTools` contains `"goal_question"` and `"goal_questionnaire"`
- **AND** `settings.toolInstructions.goal_question.inline = "Use intercom to ask the supervisor."`
- **THEN** `goalPrompt()` does NOT contain the default "To ask the user a structured question..." instruction
- **AND** `goalPrompt()` DOES contain "Use intercom to ask the supervisor."

#### Scenario: Tool disabled with file-based replacement resolves from promptsDir

- **WHEN** `settings.disabledTools` contains `"abort_goal"`
- **AND** `settings.toolInstructions.abort_goal.mode = "local"`
- **AND** `<cwd>/.pi/pi-goal-xx/prompts/tool-instruction-abort_goal.md` contains `"Call intercom to abandon."`
- **THEN** `goalPrompt()` does NOT contain the default "call abort_goal" instruction
- **AND** `goalPrompt()` DOES contain "Call intercom to abandon."

#### Scenario: Tool enabled ignores toolInstructions config

- **WHEN** `settings.disabledTools` does NOT contain `"pause_goal"`
- **AND** `settings.toolInstructions.pause_goal.inline = "Replacement text"`
- **THEN** `goalPrompt()` contains the default "call pause_goal" instruction paragraph
- **AND** `goalPrompt()` does NOT contain "Replacement text"
- **BECAUSE** `toolInstructions` only applies when the tool is disabled (C4 invariant)

#### Scenario: ask-user instruction suppressed only when both tools disabled

- **WHEN** `settings.disabledTools` contains `"goal_question"` but NOT `"goal_questionnaire"`
- **THEN** `goalPrompt()` contains the default ask-user instruction (questionnaire is still available)
- **AND** the instruction text references `goal_questionnaire` (not `goal_question`)

#### Scenario: ask-user instruction suppressed when both tools disabled

- **WHEN** `settings.disabledTools` contains both `"goal_question"` and `"goal_questionnaire"`
- **AND** `settings.toolInstructions` does NOT contain a `goal_question` or `goal_questionnaire` entry
- **THEN** `goalPrompt()` does NOT contain the default ask-user instruction

#### Scenario: Sisyphus discipline block gated on pause_goal

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **AND** the goal is a Sisyphus goal
- **THEN** `sisyphusDisciplineBlock()` does NOT contain the sentence "call pause_goal({reason, suggestedAction?}) instead of inventing a workaround"
- **AND** `sisyphusDisciplineBlock()` still contains the other Sisyphus discipline bullets (only the pause_goal bullet is omitted)

#### Scenario: Goal drafting prompt gated on goal_question

- **WHEN** `settings.disabledTools` contains both `"goal_question"` and `"goal_questionnaire"`
- **THEN** `goalDraftingPrompt()` does NOT contain the tool clause "Use goal_question or goal_questionnaire when a structured answer would help"
- **AND** `goalDraftingPrompt()` DOES contain the plain-conversation clause "Plain conversation is acceptable for simple clarifications"

#### Scenario: Goal tweak drafting prompt gated on pause_goal

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **THEN** `goalTweakDraftingPrompt()` does NOT contain the line "Do NOT call pause_goal during this drafting interview"

#### Scenario: Empty file + no inline = omission

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **AND** `settings.toolInstructions.pause_goal.mode = "local"`
- **AND** `<cwd>/.pi/pi-goal-xx/prompts/tool-instruction-pause_goal.md` is empty or absent
- **THEN** `goalPrompt()` does NOT contain the default pause_goal instruction
- **AND** no replacement text is injected (treated as omitted)

#### Scenario: toolInstructions settings validation

- **WHEN** `settings.toolInstructions` contains a key with invalid `mode` (e.g., `"invalid_mode"`)
- **THEN** `parseGoalSettings` throws an error
- **AND** unknown nested keys in a `toolInstructions` entry are rejected

#### Scenario: toolInstructions accepts any tool name key

- **WHEN** `settings.toolInstructions` contains a key `"future_tool_name"`
- **THEN** `parseGoalSettings` accepts it without error
- **BECAUSE** tool names are not allowlisted (future-proof for new tools)

#### Scenario: toolInstructions mode "off" suppresses instruction (S1)

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **AND** `settings.toolInstructions.pause_goal.mode = "off"`
- **THEN** `goalPrompt()` does NOT contain the default pause_goal instruction
- **AND** no replacement text is injected
- **BECAUSE** the unified resolver's `"off"` mode suppresses both file and inline resolution

#### Scenario: Override mode takes precedence over toolInstructions (S2)

- **WHEN** `settings.prompts.goal-running.mode = "override"` (or `settings.prompts.goal-running.inline` is set)
- **AND** `settings.disabledTools` contains `"pause_goal"`
- **AND** `settings.toolInstructions.pause_goal.inline = "Replacement text"`
- **THEN** `goalPrompt()` returns the override body verbatim
- **AND** the override body does NOT contain "Replacement text" (unless the user wrote it in the override)
- **BECAUSE** override mode replaces the entire prompt body; toolInstructions only affects the default (non-override) path

#### Scenario: Goal drafting prompt with only one ask-tool disabled (S3)

- **WHEN** `settings.disabledTools` contains `"goal_question"` but NOT `"goal_questionnaire"`
- **THEN** `goalDraftingPrompt()` contains the ask-user instruction referencing `goal_questionnaire` (not `goal_question`)
- **AND** `goalTweakDraftingPrompt()` contains the ask-user instruction referencing `goal_questionnaire` (not `goal_question`)

#### Scenario: goalPrompt output has no orphan blank lines after suppression (S4)

- **WHEN** `settings.disabledTools` contains `"pause_goal"`
- **AND** `settings.disabledTools` contains `"goal_question"` and `"goal_questionnaire"`
- **THEN** `goalPrompt()` output does NOT contain three or more consecutive newlines (`\n\n\n`)
- **AND** the output is structurally well-formed (no orphan blank lines where suppressed paragraphs were)
- **BECAUSE** `goalPrompt()` uses array-join-with-filter (not template literal interpolation) so helpers returning `""` produce no blank lines

#### Scenario: toolInstructions round-trip through save and load (S5)

- **WHEN** `settings.toolInstructions` is set to `{ "pause_goal": { "mode": "local" }, "goal_question": { "inline": "Use intercom." } }`
- **AND** the settings are saved via `saveGoalSettingsFileConfig`
- **AND** then reloaded via `loadGoalSettings`
- **THEN** the reloaded `toolInstructions` is structurally identical to the original
- **BECAUSE** `toolInstructions` is wired into the save/load round-trip path
