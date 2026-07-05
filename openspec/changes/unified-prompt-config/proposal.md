## Why

Every prompt surface in this repo is hardcoded except the auditor (`auditor-prompt.ts` already has override channel). Users cannot customize runtime goal prompts, command behavior, or contract templates without forking. The auditor pattern is proven — generalize it everywhere. Supersedes the queued `goal-custom-prompt` change (0/26, prompt-only).

**Latent bug uncovered during scoping (D9 / BUG-1):** The current `loadAuditorPrompt` treats the file prompt as the **entire** prompt — the hardcoded `defaultPrompt` (= `buildGoalAuditorPrompt()`, which carries the goal data: `<objective>`, `<completion_summary>`, `<verification_summary>`, `<verification_contract>`, the audit checklist, and the `<approved/>` / `<disapproved/>` verdict instruction) is only a **fallback** when NO file exists. Once any `.pi/auditor-prompt.md` is present, the file replaces the structured goal-data prompt entirely → the auditor model receives policy/persona text but **zero goal data** → it asks the user to provide a goal ID. Reproduced on pi-plugins (goal `mr72qw1x-za6kc9`): auditor output "Could you provide the goal ID or file path...". The unified resolver must NOT repeat this mistake — goal-data injection MUST always happen, regardless of override mode (see D9 + spec requirement *Goal data always injected*).

## What Changes

- Generalize `auditor-prompt.ts` resolution pattern into a single `prompt-resolver.ts` covering all 7 runtime prompts + auditor + tool prompt fields.
- Add `override` mode (current default `global-local` / `local` / `global-local-merge` was append-style only).
- Add per-command pre/post hooks (`command-hook-loader.ts`) with `append` (pre/post around built-in) and `override` (replace) modes, gated behind settings flag.
- Add contract templating: `{{snippet-name}}` expansion from `.pi/pi-goal-xx/contracts/` files at write time (goal-create / goal-tweak), stored expanded in goal file.
- New settings keys: `prompts`, `commandHooks`, `contractTemplates` blocks + `promptsDir`, `hooksDir`, `contractsDir` path overrides.
- New file channels: `~/.pi/pi-goal-xx/prompts/<key>.md`, `<cwd>/.pi/pi-goal-xx/prompts/<key>.md`, parallel for hooks + contracts.
- Migrate existing `auditorPrompt`/`auditorPromptMode` keys into unified `prompts.auditor` block (backward-compat alias preserved).
- **BREAKING (supersede)**: closes `goal-custom-prompt` change — its scope absorbed here.

## Capabilities

### New Capabilities

- `prompt-config-resolution`: Unified resolution of override/append prompt blocks across all runtime prompts (goal-running, goal-continuation, goal-drafting, goal-tweak, goal-stale, goal-unfocused, auditor) and tool prompt fields, with global/local/inline sources and three modes (override / append / global-local-merge).
- `command-hooks`: Per-command pre/post hook chain with append (wrap built-in) and override (replace built-in) modes, loaded from `.pi/pi-goal-xx/hooks/<cmd>.ts`, gated behind explicit settings flag.
- `contract-templating`: Reusable contract snippets under `.pi/pi-goal-xx/contracts/`, expanded via `{{name}}` syntax at goal-create and goal-tweak time, stored expanded in goal file.

### Modified Capabilities

- `goal-settings`: Add `prompts`, `commandHooks`, `contractTemplates` blocks + path overrides (`promptsDir`, `hooksDir`, `contractsDir`). `additionalProperties: false` round-trip preserved. Existing `auditorPrompt`/`auditorPromptMode` keys remain as deprecated aliases mapping to `prompts.auditor.*`.

## Impact

- **Code**:
  - `extensions/prompt-resolver.ts` — NEW generalized module (~120 LOC, mirrors auditor-prompt.ts + adds override mode).
  - `extensions/command-hook-loader.ts` — NEW module (~150 LOC).
  - `extensions/contract-templating.ts` — NEW module (~80 LOC).
  - `extensions/auditor-prompt.ts` — refactor to delegate to prompt-resolver.ts (preserve public API).
  - `extensions/prompts/goal-prompts.ts` — all 7 prompt fns gain optional `cwd` + `settings` params; merge resolved block.
  - `extensions/goal-settings.ts` — new schema blocks, parse/save round-trip.
  - `extensions/goal-draft.ts` — `extractVerificationContract` calls template expander.
  - `extensions/goal.ts` — wrap every `pi.registerCommand` call with hook chain; pass `cwd` to prompt fns; settings menu additions.
- **Tests**: new `prompt-resolver.test.ts`, `command-hook-loader.test.ts`, `contract-templating.test.ts`; extend `goal-settings.test.ts`, `goal-prompts.test.ts`, `goal-draft.test.ts`.
- **Docs**: README + `docs/` note new setting keys, file paths, modes, hook safety model.
- **APIs / deps**: none new. Pure TS, no runtime deps, no pi-core API additions.
- **Backward compat**: fully additive when unconfigured. Existing `auditorPrompt`/`auditorPromptMode` keys continue to work via alias.
- **Supersedes**: `goal-custom-prompt` change (0/26, unstarted) — close it after this lands.
- **Security**: command hooks execute user-supplied TS in extension context. Default off; require `commandHooks.enabled: true` in settings. Document footgun prominently.
