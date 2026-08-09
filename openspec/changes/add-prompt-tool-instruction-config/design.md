## Context

pi-goal-xx has two mechanisms that should be coordinated but aren't:

1. **Tool availability**: `settings.disabledTools` (string[]) hides tools from the agent. `syncGoalTools()` in `extensions/goal.ts:719-723` deletes each disabled tool name from the active set. The agent never sees the tool.

2. **Prompt instructions**: The 6 runtime prompt builders in `extensions/prompts/goal-prompts.ts` (and `goalDraftingPrompt` in `goal-draft.ts`) hardcode instruction text that *references* lifecycle tools by name. For example, `goalPrompt()` contains:

   > "If you hit a real blocker that you cannot resolve ... the CORRECT action is to call `pause_goal({reason, suggestedAction?})` with a structured, non-empty reason."

   This text is emitted unconditionally. If `pause_goal` is in `disabledTools`, the agent sees an instruction to call a tool that doesn't exist.

Today there is a unified prompt-resolution mechanism (`resolvePrompt` in `extensions/prompt-resolver.ts`) that supports per-key config with `mode` (override / append / global-local / local / global-local-merge / off) + `inline` string. It applies to whole prompt *bodies* (the full `goal-running` prompt, the full `auditor` prompt, etc.). It is too coarse for per-tool-instruction granularity: overriding the entire `goal-running` prompt just to suppress the `pause_goal` paragraph throws away the rest of the prompt.

## Constraints driving the design

- C1. **Reuse `resolvePrompt`** — the replacement config must use the same `{ mode, inline }` shape and the same file-resolution model as `prompts.<key>`. No new resolver.
- C2. **Per-tool granularity** — the unit of suppression/replacement is a single tool's instruction(s), not a whole prompt body.
- C3. **Backward compatible** — no config = no change to current prompt output.
- C4. **Coupled to `disabledTools`** — replacement only fires when the tool is actually disabled. A `toolInstructions` entry for an *enabled* tool is a no-op (the default instruction wins).
- C5. **Hand-curated mapping** — the mapping from tool name to instruction text is explicit in code (helpers), not auto-detected by scanning prompt text. Auto-detection is brittle and out of scope.

## Design

### D1. Settings schema

New top-level key in `GoalSettings`:

```typescript
toolInstructions?: Record<string, PromptConfig>;
```

Where `PromptConfig` is the existing interface from `prompt-resolver.ts` (`{ mode?: PromptMode; inline?: string }`).

Validation (`asToolInstructionsBlock` in `goal-settings.ts`):
- Keyed by tool name (any non-empty string — no allowlist; future-proof for new tools).
- Each value validated via `asPromptConfig` (same logic as `prompts.<key>` entries).
- Unknown nested keys rejected (same as `asPromptConfig`).

Added to:
- `ALLOWED_SETTINGS_KEYS` (so it passes the top-level unknown-key check).
- `parseGoalSettings` (read + coerce).
- `loadGoalSettings` (env override not needed — no env var for this; file-only).
- `saveGoalSettingsFileConfig` (round-trip persist).

### D2. File resolution naming

Tool instruction files use the key `tool-instruction-<toolName>`:
- Global: `<home>/<promptsDir>/tool-instruction-<toolName>.md`
- Local: `<cwd>/<promptsDir>/tool-instruction-<toolName>.md`

Default `promptsDir` = `.pi/pi-goal-xx/prompts/`.

Example: `toolInstructions.pause_goal = { mode: "local" }` reads `<cwd>/.pi/pi-goal-xx/prompts/tool-instruction-pause_goal.md`.

### D3. Instruction helpers (new module)

`extensions/prompts/tool-instruction-parts.ts` exports:

```typescript
// pause_goal appears in two textually-different contexts:
// 1. Verbose paragraph in goalPrompt/continuationPrompt (multi-sentence)
// 2. Single bullet in sisyphusDisciplineBlock (one-liner)
// These need separate helpers to avoid injecting the wrong text.
export function pauseGoalBodyInstruction(settings: GoalSettings | undefined, cwd: string | undefined): string;
export function pauseGoalSisyphusBullet(settings: GoalSettings | undefined, cwd: string | undefined): string;
export function askUserInstruction(settings: GoalSettings | undefined, cwd: string | undefined): string;
export function abortGoalInstruction(settings: GoalSettings | undefined, cwd: string | undefined): string;
export function completeGoalInstruction(settings: GoalSettings | undefined, cwd: string | undefined): string;
```

Each helper:
1. Reads `disabledTools` set from `settings`.
2. Reads `toolInstructions[name]` config from `settings`.
3. Decides:
   - Tool NOT disabled → return the hardcoded default text (extracted from the current prompt builders).
   - Tool disabled + no config → return `""`.
   - Tool disabled + config → call `resolvePrompt("tool-instruction-<name>", cfg, cwd ?? ".", "", { promptsDir: settings.promptsDir })`; return `resolved.final` if `resolved.source !== "none"`, else `""` (empty file + no inline = omit).

**`pauseGoalBodyInstruction` vs `pauseGoalSisyphusBullet`**: `pause_goal` appears in two textually-different contexts in the codebase, so two helpers are needed. `pauseGoalBodyInstruction` returns the verbose multi-sentence paragraph (extracted from `goalPrompt`/`continuationPrompt`). `pauseGoalSisyphusBullet` returns the one-liner bullet text (extracted from `sisyphusDisciplineBlock`). Both check the same `disabledTools` entry (`pause_goal`) and the same `toolInstructions.pause_goal` config, but return different default texts for their respective contexts. Without this split, injecting the verbose body text into the sisyphus bullet list would corrupt the block.

For `askUserInstruction`, the helper checks if **both** `goal_question` AND `goal_questionnaire` are disabled before suppressing. If only one is disabled, the instruction is rewritten to reference only the available tool (not the disabled one), avoiding text that points the agent at a missing tool. Two default text constants:
- `DEFAULT_ASK_USER_INSTRUCTION` — references both tools (when neither disabled).
- `DEFAULT_ASK_USER_SINGLE_TEMPLATE` — parameterized with the available tool name (when one disabled).

The `toolInstructions` lookup checks `goal_question` first, then `goal_questionnaire` as fallback.

### D4. Prompt builder integration

Each builder that references a gated tool calls the corresponding helper instead of inlining the hardcoded text:

| Builder | File | Helpers called |
|:--|:--|:--|
| `goalPrompt` | `goal-prompts.ts` | `pauseGoalBodyInstruction`, `askUserInstruction`, `abortGoalInstruction`, `completeGoalInstruction` |
| `continuationPrompt` | `goal-prompts.ts` | same 4 |
| `sisyphusDisciplineBlock` | `goal-prompts.ts` | `pauseGoalSisyphusBullet` (the block references `pause_goal` in a one-liner bullet) |
| `goalDraftingPrompt` | `goal-draft.ts` | `askUserInstruction` (the protocol references `goal_question`) |
| `goalTweakDraftingPrompt` | `goal-prompts.ts` | `askUserInstruction`, `pauseGoalBodyInstruction` (the "Do NOT call pause_goal" line) |
| `staleContinuationPrompt` | `goal-prompts.ts` | none (no tool instructions) |
| `unfocusedOpenGoalsPrompt` | `goal-prompts.ts` | none (no tool instructions) |

**`goalPrompt()` empty-line strategy**: `goalPrompt()` currently uses a template literal for its non-override path (unlike `continuationPrompt()` which already uses array-join-with-filter). The non-override path is restructured to an array-join-with-filter pattern: each instruction helper output becomes an array element; empty strings are filtered out via `.filter((s) => typeof s === "string" && s.length > 0)` before joining with `"\n"`. This eliminates the orphan-blank-line problem that would occur if helpers returning `""` were interpolated directly into the template literal. This matches the existing `continuationPrompt()` pattern.

**`sisyphusDisciplineBlock` signature change**: Currently takes `(goal: GoalRecord)` only. Must add optional `(settings?: GoalSettings, cwd?: string)` params. All 4 call sites must be updated:
1. `goalPrompt()` override branch — `sisyphusDisciplineBlock(goal, settings, cwd)`
2. `goalPrompt()` non-override branch — `sisyphusDisciplineBlock(goal, settings, cwd)`
3. `continuationPrompt()` override branch — `sisyphusDisciplineBlock(goal, settings, cwd)`
4. `continuationPrompt()` non-override branch — `sisyphusDisciplineBlock(goal, settings, cwd)`

**`goalDraftingPrompt` line splitting**: The line "Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable." is split into two parts:
- Tool clause: "Use goal_question or goal_questionnaire when a structured answer would help." — gated by `askUserInstruction` (empty when both disabled → clause omitted).
- Plain-conversation clause: "Plain conversation is acceptable for simple clarifications." — always emitted (not gated — guidance remains valid regardless of tool availability).

### D5. Interaction with override mode

The existing `prompts.<key>.mode: "override"` replaces an entire prompt *body*. It is orthogonal to `toolInstructions`. If a user overrides the entire `goal-running` prompt, the tool-instruction helpers are not called (the override body is used verbatim). `toolInstructions` only affects the *default* (non-override) prompt body path.

This is the correct precedence: override = "I am writing the whole prompt myself"; `toolInstructions` = "I want the default prompt but with this one tool's instruction swapped."

### D6. Rollback plan

The suppression behavior (omitting default instructions when a tool is in `disabledTools`) fires automatically — it is NOT gated behind `toolInstructions` being configured. This means:
- **Config-only rollback**: Removing `toolInstructions` from settings only disables replacement text injection. The suppression of default instructions for disabled tools remains active.
- **Full rollback**: Requires a code revert (extension version downgrade). There is no config flag to disable the suppression path independently.

This is intentional — the suppression IS the fix for prompt-tool drift. But operators should know that rolling back the suppression requires reverting the extension, not just changing config.

## Open Questions (resolved by gotcha-finder pass)

- ~~OQ1: Should `askUserInstruction` check `goal_question` and `goal_questionnaire` independently or as a pair?~~ **Resolved**: pair — only suppress when BOTH are disabled. When only one disabled, rewrite text to reference the available tool (avoiding text drift pointing at a missing tool).
- ~~OQ2: The `goalDraftingPrompt` line — suppress whole line or just tool names?~~ **Resolved**: split the line. Tool clause gated; plain-conversation clause always emitted.
- ~~OQ3: `sisyphusDisciplineBlock` — suppress block or just the sentence?~~ **Resolved**: just the `pause_goal` sentence, using `pauseGoalSisyphusBullet` (separate helper from `pauseGoalBodyInstruction`).
- ~~OQ4: Should `toolInstructions` apply when the tool is NOT disabled?~~ **Resolved**: no — C4. Replacement only fires when disabled.

## Non-Goals

- N1. Auto-detecting which prompt lines reference which tool (hand-curated mapping only).
- N2. Gating non-tool-specific policy statements that mention a tool name (e.g., "Do not use complete_goal=complete to escape a blocker" stays).
- N3. Env-var overrides for `toolInstructions` (file-only config).
- N4. Applying `toolInstructions` when the tool is enabled (augmentation mode).
