# Prompt configuration

Unified resolution of **all 7 runtime prompts + auditor + every tool prompt field** via a single `prompt-resolver.ts`. Users can inject project-specific execution rules (delegation policy, TDD discipline, verifier-loop requirement, persona overrides) without forking.

Resolution mirrors the proven auditor-prompt pattern, generalized with two new modes (`override`, `off`).

## Prompt keys

### Runtime prompts (per-turn)

| Key | Built-in | Purpose |
|-----|----------|---------|
| `goal-running` | `goalPrompt()` | Active-goal agent system prompt (start) |
| `goal-continuation` | `continuationPrompt()` | Checkpoint resume prompt |
| `goal-drafting` | `goalDraftingPrompt()` | `/goals` + `/sisyphus` drafting interview |
| `goal-tweak` | `goalTweakDraftingPrompt()` | `/goal-tweak` drafting interview |
| `goal-stale` | `staleContinuationPrompt()` | Stale-checkpoint notice |
| `goal-unfocused` | `unfocusedOpenGoalsPrompt()` | No focused goal notice |
| `auditor` | `loadAuditorPrompt()` | Independent completion auditor |

### Tool prompts (load-time)

Every tool registered by pi-goal-xx gets a key `tool-<toolName>`:

- `tool-get-goal`, `tool-create-goal`, `tool-propose-goal-draft`, `tool-complete-goal`, `tool-pause-goal`, `tool-abort-goal`, `tool-propose-goal-tweak`, `tool-propose-task-list`, `tool-complete-task`, `tool-skip-task`, `tool-goal-question`

Tool prompts resolve at **extension load** (design D3). Editing a `tool-<name>.md` file requires `/reload` to take effect. Runtime prompts and command hooks are similarly load-time resolved.

## Modes

| Mode | Behavior |
|------|----------|
| `override` | The resolved block **replaces** the hardcoded default entirely. For runtime prompts, load-bearing dynamic markers (`[PI GOAL ACTIVE]`, objective, task list, verification contract) are still preserved — only the instruction body is replaced. |
| `append` | Hardcoded default + `\n\n` + resolved block. (Alias of `global-local` with explicit semantics.) |
| `global-local` *(default)* | Local file wins over global; append-style. |
| `local` | Only the local file is consulted; global never read. |
| `global-local-merge` | Global + `\n\n` + local when both present. |
| `off` | No injection even if files exist. Useful for tool prompts where injection is unwanted. |

**Inline always wins**: if `prompts.<key>.inline` is set, it takes precedence over any file, regardless of mode (except `off` with no inline).

## File paths

Default directory (relative to both `~` and `cwd`): `.pi/pi-goal-xx/prompts/`

- Global: `~/.pi/pi-goal-xx/prompts/<key>.md`
- Local: `<cwd>/.pi/pi-goal-xx/prompts/<key>.md`

Override the directory via `settings.promptsDir`.

## Resolution sources + precedence

1. `settings.prompts.<key>.inline` (string) — always wins when non-blank.
2. File sources, combined per `mode` (see above).
3. Nothing resolved → hardcoded default only.

## Settings shape

```jsonc
{
  "prompts": {
    "goal-running": { "mode": "append", "inline": "Delegate implementation to a team." },
    "auditor": { "mode": "override", "inline": "Reject unless verifier-loop hash present." }
  },
  "promptsDir": ".pi/pi-goal-xx/prompts/"
}
```

Unknown prompt keys are rejected (`additionalProperties: false` semantics). Valid keys are the 7 runtime keys + `auditor` + any `tool-<name>` pattern.

## Backward compatibility

Legacy flat keys remain valid aliases:

| Legacy key | Maps to |
|------------|---------|
| `auditorPrompt` | `prompts.auditor.inline` |
| `auditorPromptMode` | `prompts.auditor.mode` |
| `goalPrompt` | `prompts.goal-running.inline` |
| `goalPromptMode` | `prompts.goal-running.mode` |

The alias applies **only when** the explicit `prompts.<key>` block is absent. If both are present, `prompts.<key>` wins.

Legacy file paths (`.pi/auditor-prompt.md`, `.pi/goal-prompt.md`) continue to work as a fallback when the unified path yields nothing.
