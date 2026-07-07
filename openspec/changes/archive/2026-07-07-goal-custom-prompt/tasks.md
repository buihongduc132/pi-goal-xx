## 1. Settings schema (extensions/goal-settings.ts)

- [ ] 1.1 Add `goalPromptMode?: AuditorPromptMode` and `goalPrompt?: string` to `GoalSettings` interface (after `auditorPrompt`)
- [ ] 1.2 Add `"goalPromptMode"` and `"goalPrompt"` to `ALLOWED_SETTINGS_KEYS`
- [ ] 1.3 Parse both keys in `parseGoalSettings()` (reuse `asAuditorPromptMode` for mode; `asNonEmptyString` for prompt)
- [ ] 1.4 Carry both keys through `loadGoalSettings()` file-config spread
- [ ] 1.5 Persist both keys in `saveGoalSettingsFileConfig()` (`clean.*` and `persisted.*`)

## 2. Resolver module (extensions/goal-prompt-resolver.ts)

- [ ] 2.1 Create module with `GoalPromptMode = AuditorPromptMode` type alias
- [ ] 2.2 Implement `globalGoalPromptPath(home)` → `<home>/.pi/goal-prompt.md`
- [ ] 2.3 Implement `localGoalPromptPath(cwd)` → `<cwd>/.pi/goal-prompt.md`
- [ ] 2.4 Implement `resolveGoalPromptMode(settings)` defaulting to `"global-local"`
- [ ] 2.5 Implement `loadGoalPrompt(settings, cwd, home?)` returning `{ prompt, source }` per spec resolution order
- [ ] 2.6 Implement `customGoalPromptBlock(settings, cwd, home?)` returning the wrapped tagged block (or `""` when none)

## 3. Prompt builder wiring (extensions/prompts/goal-prompts.ts)

- [ ] 3.1 Import `customGoalPromptBlock` from `../goal-prompt-resolver.ts`
- [ ] 3.2 Add optional `cwd?: string` 3rd param to `goalPrompt(goal, settings?, cwd?)`
- [ ] 3.3 Append `customGoalPromptBlock(settings, cwd)` to `goalPrompt()` return when `cwd` supplied (after Sisyphus block)
- [ ] 3.4 Add optional `cwd?: string` 3rd param to `continuationPrompt(goal, settings?, cwd?)`
- [ ] 3.5 Append custom block to `continuationPrompt()` array when `cwd` supplied (after Sisyphus entry)

## 4. Live call sites (extensions/goal.ts)

- [ ] 4.1 Pass `ctx.cwd` as 3rd arg at `continuationPrompt(goal, settings)` call site (~line 1540)
- [ ] 4.2 Pass `ctx.cwd` as 3rd arg at `goalPrompt(activeGoal, settings)` call site (~line 4076)

## 5. Tests

- [ ] 5.1 Create `tests/goal-prompt-resolver.test.ts` covering: inline override, local mode, global-local default, merge mode, blank-file-as-missing, customGoalPromptBlock wrapping + empty case
- [ ] 5.2 Extend `tests/goal-settings.test.ts`: parse + round-trip for `goalPrompt` and `goalPromptMode`; unknown-key rejection still fires
- [ ] 5.3 Extend `tests/goal-prompts.test.ts`: `goalPrompt`/`continuationPrompt` inject block when `cwd` given, skip when omitted, Sisyphus-before-custom ordering
- [ ] 5.4 Run full suite `node --experimental-strip-types --test tests/*.test.ts` — all green

## 6. Type check + docs

- [ ] 6.1 `npm run check` (tsc --noEmit) clean
- [ ] 6.2 README: document `goalPrompt` / `goalPromptMode` keys + file paths in the config section
- [ ] 6.3 `docs/` reference: add `goal-prompt.md` to the layered docs (paths, modes, example)
- [ ] 6.4 Commit with conventional message `feat(goal-prompt): configurable custom prompt injection`
