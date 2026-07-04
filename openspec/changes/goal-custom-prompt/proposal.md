## Why

pi-goal-xx lets users override the **auditor** prompt via file (`~/.pi/auditor-prompt.md`) or inline setting, but offers **no equivalent channel for the runtime goal/continuation prompts** that drive the active goal agent. Users cannot inject project-specific execution rules (e.g. "delegate implementation to a team", "no pauses during the goal", "verifier-loop required before completion") without forking pi-core or editing hardcoded prompt builders. The auditor pattern already solves this cleanly — we mirror it for the goal prompt.

## What Changes

- Add new `goalPromptMode` setting (`global-local` | `local` | `global-local-merge`), defaulting to `global-local`.
- Add new `goalPrompt` inline string override setting.
- Add new file channels: `<home>/.pi/goal-prompt.md` (global) and `<cwd>/.pi/goal-prompt.md` (local).
- Add resolver module `extensions/goal-prompt-resolver.ts` mirroring `extensions/auditor-prompt.ts`.
- Inject the resolved custom prompt block into both `goalPrompt()` and `continuationPrompt()` outputs (Sisyphus discipline block order preserved — custom block appended last).
- Wire `cwd` through the two existing call sites in `extensions/goal.ts` so the resolver can find the local file.
- Persist new keys through `saveGoalSettingsFileConfig()` round-trip.
- Reject unknown settings keys as before (`additionalProperties: false`).

## Capabilities

### New Capabilities
- `goal-custom-prompt`: Resolution of an optional user-supplied prompt block injected into runtime goal/continuation system prompts, with global/local/inline sources and three merge modes.

### Modified Capabilities
- `goal-settings`: Add `goalPrompt` and `goalPromptMode` keys to the unified settings schema; both participate in parse/save round-trip and respect `additionalProperties: false`.

## Impact

- **Code**:
  - `extensions/goal-settings.ts` — schema additions, allowed-keys set, parse, save.
  - `extensions/goal-prompt-resolver.ts` — NEW module.
  - `extensions/prompts/goal-prompts.ts` — `goalPrompt()` and `continuationPrompt()` signatures gain optional `cwd` param, append resolved block.
  - `extensions/goal.ts` — two call sites pass `ctx.cwd`.
- **Tests**: new `tests/goal-prompt-resolver.test.ts`; existing `goal-settings.test.ts` and `goal-prompts.test.ts` extended.
- **Docs**: README + `docs/` note new setting keys and file paths.
- **APIs / deps**: none new. Pure TS, no runtime deps.
- **Backward compat**: fully additive. No existing setting or prompt behavior changes when nothing is configured (resolver returns empty string → no injection).
