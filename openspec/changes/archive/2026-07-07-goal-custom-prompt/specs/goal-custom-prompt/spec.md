## ADDED Requirements

### Requirement: Goal custom prompt resolution
The system SHALL resolve an optional user-supplied custom prompt block and inject it into the runtime goal and continuation system prompts. Resolution SHALL follow this order, first non-empty wins:

1. Inline `settings.goalPrompt` (always takes precedence).
2. File-based prompt(s), combined per `settings.goalPromptMode`:
   - `global-local` (default): local overrides global completely.
   - `local`: only `<cwd>/.pi/goal-prompt.md`; global never consulted.
   - `global-local-merge`: global + `\n\n` + local.
3. When nothing is configured, the resolver SHALL return an empty string and inject nothing.

Global path SHALL be `<home>/.pi/goal-prompt.md`. Local path SHALL be `<cwd>/.pi/goal-prompt.md`. Blank/whitespace-only files SHALL be treated as missing.

#### Scenario: Inline override wins over files
- **WHEN** `settings.goalPrompt` is a non-blank string AND global/local files exist
- **THEN** resolver returns the inline string with `source: "inline"`

#### Scenario: Default mode with local present
- **WHEN** `goalPromptMode` is unset AND `<cwd>/.pi/goal-prompt.md` exists AND `<home>/.pi/goal-prompt.md` exists
- **THEN** resolver returns the local file content with `source: "local"`

#### Scenario: Default mode falls back to global
- **WHEN** `goalPromptMode` is unset AND local file is missing AND global file exists
- **THEN** resolver returns the global file content with `source: "global"`

#### Scenario: Local mode ignores global
- **WHEN** `goalPromptMode` is `"local"` AND both files exist
- **THEN** resolver returns the local content and does not read the global file

#### Scenario: Merge mode concatenates
- **WHEN** `goalPromptMode` is `"global-local-merge"` AND both files exist
- **THEN** resolver returns `global + "\n\n" + local` with `source: "merged"`

#### Scenario: Nothing configured
- **WHEN** no inline setting AND no files exist
- **THEN** resolver returns `prompt: ""` and `source: "none"`

#### Scenario: Blank file treated as missing
- **WHEN** a file contains only whitespace
- **THEN** resolver treats it as missing and proceeds to the next resolution step

### Requirement: Custom block wrapping
When the resolver yields a non-empty prompt, the injected block SHALL be wrapped in a tagged envelope that records the source. The block SHALL appear exactly once in each affected system prompt and SHALL be appended AFTER the Sisyphus discipline block (when present).

Envelope format:
```
[PI GOAL CUSTOM PROMPT source=<inline|local|global|merged>]
<goal_custom_prompt>
...resolved text...
</goal_custom_prompt>
```

#### Scenario: Block includes source label and tags
- **WHEN** resolver returns a non-empty prompt with `source: "local"`
- **THEN** injected block contains `[PI GOAL CUSTOM PROMPT source=local]`, an opening `<goal_custom_prompt>` tag, the resolved text, and a closing `</goal_custom_prompt>` tag

#### Scenario: Empty resolver yields no block
- **WHEN** resolver returns `prompt: ""`
- **THEN** no `[PI GOAL CUSTOM PROMPT ...]` block appears in the system prompt

### Requirement: Injection into goal prompt
The custom block SHALL be injected into the output of `goalPrompt()` whenever a `cwd` argument is supplied. When `cwd` is omitted, no injection SHALL occur (backward compatibility for unit tests).

#### Scenario: goalPrompt with cwd injects
- **WHEN** `goalPrompt(goal, settings, cwd)` is called AND resolver returns non-empty
- **THEN** the returned string ends with the custom block

#### Scenario: goalPrompt without cwd skips injection
- **WHEN** `goalPrompt(goal, settings)` is called with no `cwd`
- **THEN** the returned string does not contain a `[PI GOAL CUSTOM PROMPT` marker

### Requirement: Injection into continuation prompt
The custom block SHALL be injected into the output of `continuationPrompt()` whenever a `cwd` argument is supplied, appended after the Sisyphus discipline block (when present). When `cwd` is omitted, no injection SHALL occur.

#### Scenario: continuationPrompt with cwd injects after Sisyphus
- **WHEN** `continuationPrompt(goal, settings, cwd)` is called on a Sisyphus goal AND resolver returns non-empty
- **THEN** the Sisyphus block appears before the custom block in the returned string

#### Scenario: continuationPrompt without cwd skips injection
- **WHEN** `continuationPrompt(goal, settings)` is called with no `cwd`
- **THEN** the returned string does not contain a `[PI GOAL CUSTOM PROMPT` marker

### Requirement: Live call sites pass cwd
Both production call sites in `extensions/goal.ts` (the `agent_start` injection and the checkpoint-resume injection) SHALL pass `ctx.cwd` to the prompt builders so the local file is resolved.

#### Scenario: agent_start passes ctx.cwd
- **WHEN** the active-goal system prompt is built at agent start
- **THEN** `goalPrompt()` is called with `ctx.cwd` as the third argument

#### Scenario: checkpoint passes ctx.cwd
- **WHEN** a checkpoint continuation message is built
- **THEN** `continuationPrompt()` is called with `ctx.cwd` as the third argument
