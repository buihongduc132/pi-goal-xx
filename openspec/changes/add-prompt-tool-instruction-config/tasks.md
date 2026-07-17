## 1. Settings schema (RED)

- [ ] 1.1 Add `toolInstructions?: Record<string, PromptConfig>` to `GoalSettings` interface in `extensions/goal-settings.ts`.
- [ ] 1.2 Add `"toolInstructions"` to `ALLOWED_SETTINGS_KEYS` set.
- [ ] 1.3 Implement `asToolInstructionsBlock(raw: unknown): Record<string, PromptConfig> | undefined` — validates each entry via `asPromptConfig`, rejects unknown nested keys. Any non-empty string key is accepted (no tool-name allowlist).
- [ ] 1.4 Wire `asToolInstructionsBlock` into `parseGoalSettings`: read `record.toolInstructions`, assign to `settings.toolInstructions`.
- [ ] 1.5 Wire into `loadGoalSettings`: pass through `fileConfig.toolInstructions`.
- [ ] 1.6 Wire into `saveGoalSettingsFileConfig`: round-trip `settings.toolInstructions` → `clean.toolInstructions` → `persisted.toolInstructions`.
- [ ] 1.7 Add unit tests in `tests/tool-instruction-settings.test.ts`:
  - Valid `toolInstructions` block parsed correctly (inline + mode).
  - Invalid mode rejected with error.
  - Unknown nested key rejected.
  - Empty object `{}` → `toolInstructions` is `undefined` (no-op).
  - Round-trip: save → load → identical (scenario S5).
  - `toolInstructions` with unknown tool name (e.g., `"future_tool"`) accepted (no allowlist).

## 2. Instruction helpers (RED)

- [ ] 2.1 Create new module `extensions/prompts/tool-instruction-parts.ts`.
- [ ] 2.2 Define `DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION` constant — extract the verbose `pause_goal` instruction paragraph from `goalPrompt()` (the "If you hit a real blocker..." multi-sentence paragraph). Used by `goalPrompt` and `continuationPrompt`.
- [ ] 2.3 Define `DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET` constant — extract the one-liner `pause_goal` bullet from `sisyphusDisciplineBlock` ("- If a step is unclear, blocked, fails, or seems wrong: call pause_goal({reason, suggestedAction?}) instead of inventing a workaround."). Used by `sisyphusDisciplineBlock` only. (Resolves G2 — two distinct texts, two constants.)
- [ ] 2.4 Define `DEFAULT_ASK_USER_INSTRUCTION` constant — extract the hardcoded `goal_question` / `goal_questionnaire` instruction text from `goalPrompt()` (the "To ask the user a structured question..." line). References both tools.
- [ ] 2.5 Define `DEFAULT_ASK_USER_SINGLE_TEMPLATE` — parameterized template for when only one ask-tool is available (takes the available tool name as parameter). (Resolves G3 — avoids referencing a disabled tool.)
- [ ] 2.6 Define `DEFAULT_ABORT_GOAL_INSTRUCTION` constant — extract the hardcoded `abort_goal` instruction text from `goalPrompt()` (the "If the user explicitly asks to abandon/cancel..." line).
- [ ] 2.7 Define `DEFAULT_COMPLETE_GOAL_INSTRUCTION` constant — extract the hardcoded `complete_goal` instruction text from `goalPrompt()` (the "At each natural stopping point..." paragraph).
- [ ] 2.8 Implement `pauseGoalBodyInstruction(settings, cwd): string`:
  - If `pause_goal` NOT in `disabledTools` → return `DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION`.
  - If disabled + no `toolInstructions.pause_goal` → return `""`.
  - If disabled + config → `resolvePrompt("tool-instruction-pause_goal", cfg, cwd, "", opts)`; return `resolved.final` if `source !== "none"`, else `""`.
- [ ] 2.9 Implement `pauseGoalSisyphusBullet(settings, cwd): string` — same logic as `pauseGoalBodyInstruction` but returns `DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET` when enabled. (Resolves G2 — separate helper for the sisyphus bullet context.)
- [ ] 2.10 Implement `askUserInstruction(settings, cwd): string`:
  - If NEITHER `goal_question` NOR `goal_questionnaire` in `disabledTools` → return `DEFAULT_ASK_USER_INSTRUCTION`.
  - If BOTH disabled + no config → return `""`.
  - If BOTH disabled + config (`goal_question` key checked first, then `goal_questionnaire`) → resolve and return.
  - If only ONE disabled → return `DEFAULT_ASK_USER_SINGLE_TEMPLATE` filled with the available tool name. (Resolves G3.)
- [ ] 2.11 Implement `abortGoalInstruction(settings, cwd): string` — same pattern as `pauseGoalBodyInstruction` but for `abort_goal`.
- [ ] 2.12 Implement `completeGoalInstruction(settings, cwd): string` — same pattern but for `complete_goal`.
- [ ] 2.13 Add unit tests in `tests/tool-instruction-parts.test.ts`:
  - Each helper: tool enabled → default text returned.
  - Each helper: tool disabled + no config → `""`.
  - Each helper: tool disabled + inline config → inline text returned.
  - Each helper: tool disabled + file config (tmp dir) → file content returned.
  - `askUserInstruction`: only `goal_question` disabled → returns single-tool text referencing `goal_questionnaire` (G3 scenario).
  - `askUserInstruction`: only `goal_questionnaire` disabled → returns single-tool text referencing `goal_question`.
  - `askUserInstruction`: both disabled → suppressed.
  - `pauseGoalBodyInstruction` vs `pauseGoalSisyphusBullet`: enabled → DIFFERENT default texts (G2 assertion — body is verbose paragraph, bullet is one-liner).
  - Each helper: tool disabled + config but empty file + no inline → `""`.

## 3. Prompt builder integration (RED)

- [ ] 3.1 Add tests in `tests/tool-instruction-prompts.test.ts`:
  - `goalPrompt` with `disabledTools: ["pause_goal"]` → output does NOT contain `DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION`.
  - `goalPrompt` with `disabledTools: ["pause_goal"]` + `toolInstructions.pause_goal.inline = "Use intercom."` → output contains "Use intercom." and does NOT contain default.
  - `goalPrompt` with no `disabledTools` → output contains default (regression guard).
  - `goalPrompt` with `disabledTools: ["pause_goal"]` → output has NO orphan blank lines (structural assertion: no `\n\n\n` sequence anywhere). (Scenario S4 — G1 structural guard.)
  - `continuationPrompt` with `disabledTools: ["goal_question", "goal_questionnaire"]` → output does NOT contain `DEFAULT_ASK_USER_INSTRUCTION`.
  - `continuationPrompt` with `disabledTools: ["abort_goal"]` → output does NOT contain `DEFAULT_ABORT_GOAL_INSTRUCTION`.
  - `goalDraftingPrompt` with `disabledTools: ["goal_question", "goal_questionnaire"]` → output does NOT contain tool clause in the confirmation protocol, but DOES contain "plain conversation" clause. (Resolves G4.)
  - `goalDraftingPrompt` with `disabledTools: ["goal_question"]` only → output references `goal_questionnaire` (single-tool text). (Scenario S3.)
  - `goalTweakDraftingPrompt` with `disabledTools: ["pause_goal"]` → output does NOT contain "Do NOT call pause_goal" line.
  - `sisyphusDisciplineBlock` with `disabledTools: ["pause_goal"]` → output does NOT contain "call pause_goal" sentence.
  - `sisyphusDisciplineBlock` with `disabledTools: ["pause_goal"]` → output still contains the OTHER sisyphus bullets (only the pause_goal bullet omitted).
  - `goalPrompt` with `disabledTools: ["complete_goal"]` → output does NOT contain `DEFAULT_COMPLETE_GOAL_INSTRUCTION`.

## 4. GREEN — implement helpers and wire into builders

- [ ] 4.1 Implement `extensions/prompts/tool-instruction-parts.ts` (tasks 2.1–2.12). All RED tests from group 2 should now pass.
- [ ] 4.2 Refactor `goalPrompt` in `extensions/prompts/goal-prompts.ts`:
  - **Restructure the non-override path from a template literal to an array-join-with-filter pattern** (matching `continuationPrompt()`). This resolves G1. (Resolves G1 — explicit strategy: array-join-filter, NOT post-process replace.)
  - Replace hardcoded `pause_goal` paragraph with `pauseGoalBodyInstruction(settings, cwd)` as an array element.
  - Replace hardcoded `goal_question` line with `askUserInstruction(settings, cwd)` as an array element.
  - Replace hardcoded `abort_goal` line with `abortGoalInstruction(settings, cwd)` as an array element.
  - Replace hardcoded `complete_goal` paragraph with `completeGoalInstruction(settings, cwd)` as an array element.
  - Filter out empty strings from the array before joining with `"\n"` (same as `continuationPrompt()`).
- [ ] 4.3 Refactor `continuationPrompt` — same 4 replacements (already uses array-join-filter, so just swap the hardcoded strings for helper calls).
- [ ] 4.4 Refactor `sisyphusDisciplineBlock`:
  - Add optional `(settings?: GoalSettings, cwd?: string)` params.
  - Replace the `pause_goal` bullet sentence with the output of `pauseGoalSisyphusBullet(settings, cwd)` (NOT `pauseGoalBodyInstruction`). If empty, the bullet line is omitted (filtered from the array).
  - **Update all 4 call sites** (G8 — enumerated):
    1. `goalPrompt()` override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
    2. `goalPrompt()` non-override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
    3. `continuationPrompt()` override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
    4. `continuationPrompt()` non-override branch: `sisyphusDisciplineBlock(goal, settings, cwd)`
- [ ] 4.5 Refactor `goalDraftingPrompt` in `extensions/goal-draft.ts`:
  - Split the line "Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable." into two parts (resolves G4):
    - Tool clause: "Use goal_question or goal_questionnaire when a structured answer would help." — gated by `askUserInstruction(settings, cwd)` (empty when both disabled → clause omitted).
    - Plain-conversation clause: "Plain conversation is acceptable for simple clarifications." — always emitted.
- [ ] 4.6 Refactor `goalTweakDraftingPrompt` (in `goal-prompts.ts`):
  - **NG1 fix**: Add a THIRD helper `pauseGoalTweakInstruction(settings, cwd)` whose default text is the EXACT original line "Do NOT call pause_goal during this drafting interview (it pauses execution — you are not executing, you are revising)." (NOT `pauseGoalBodyInstruction` — that returns the verbose body paragraph and would regress the prompt when tool is enabled). The helper returns "" when `pause_goal` is disabled, otherwise the original line text.
  - **NG2 fix**: Split the "You MAY clarify via ... goal_question/goal_questionnaire tools" line into two clauses:
    - Tool clause: "the built-in goal_question/goal_questionnaire tools" — gated by `askUserInstruction(settings, cwd)` (empty when both disabled → clause omitted).
    - Plain-chat + user-dialogue clause: "You MAY clarify via plain chat, or any question-like user-dialogue tool." — always emitted.
  - **Opportunistic fix (G7)**: remove the duplicate "User's tweak hint (may be empty):" line — this is a pre-existing bug (the line appears twice in the current code).
- [ ] 4.7 Run all RED tests from group 3 — they should now pass.

## 5. GREEN — settings schema

- [ ] 5.1 Implement `asToolInstructionsBlock` in `extensions/goal-settings.ts` (task 1.3).
- [ ] 5.2 Wire into `parseGoalSettings`, `loadGoalSettings`, `saveGoalSettingsFileConfig` (tasks 1.4–1.6).
- [ ] 5.3 Run all RED tests from group 1 — they should now pass.

## 6. Refactor

- [ ] 6.1 Extract remaining hardcoded instruction text from `goalDraftingPrompt` confirmation protocol into `DEFAULT_ASK_USER_INSTRUCTION` constant (if not already done in 2.4).
- [ ] 6.2 Ensure all existing tests still pass: `pnpm test` (or `npm test`) — no regression on `goal-prompts.test.ts`, `goal-prompts-unified.test.ts`, `goal-settings.test.ts`, `goal-settings-unified.test.ts`, `prompt-resolver.test.ts`.
- [ ] 6.3 Add `toolInstructions` to the `KNOWN_PROMPT_KEYS` validation or document that it uses a separate validation path (tool names, not prompt keys). Decision: separate path — `toolInstructions` keys are tool names, not prompt keys. No change to `KNOWN_PROMPT_KEYS`.

## 7. Documentation

- [ ] 7.1 Update `AGENTS.md` with a brief note about `toolInstructions` setting.
- [ ] 7.2 Add a usage example to the openspec change `proposal.md` or a separate `README` section.
