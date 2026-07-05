## 1. Prompt Resolver Foundation

- [ ] 1.1 Create `extensions/prompt-resolver.ts` with `PromptMode`, `PromptConfig`, `ResolvedPrompt` types and `resolvePrompt(key, cfg, cwd, hardcodedDefault)` function
- [ ] 1.2 Implement source precedence: inline → file (per mode) → none
- [ ] 1.3 Implement modes: `override`, `append`, `global-local`, `local`, `global-local-merge`, `off`
- [ ] 1.4 Add in-memory mtime-keyed file cache to avoid re-reading on every prompt build
- [ ] 1.5 Honor `promptsDir` path override (default `.pi/pi-goal-xx/prompts/`)
- [ ] 1.6 Resolve global path under home dir, local path under cwd
- [ ] 1.7 Create `tests/prompt-resolver.test.ts` covering all 6 modes + inline precedence + custom dir

## 2. Migrate auditor-prompt.ts to use resolver (BUG-1 fix)

- [ ] 2.0 **BUG-1 fix (blocking).** Current `loadAuditorPrompt` treats the file prompt as the entire prompt and drops `buildGoalAuditorPrompt`'s goal-data blocks (`<objective>`, `<completion_summary>`, `<verification_summary>`, `<verification_contract>`, audit checklist, `<approved/>`/`<disapproved/>` verdict marker) whenever a file exists. Reproduced on pi-plugins (goal `mr72qw1x-za6kc9`, auditor returned "Could you provide the goal ID..."). Fix BEFORE any unified-resolver work is safe: file/inline block becomes the persona layer (prepended); goal-data block from `buildGoalAuditorPrompt` is always appended as the fact layer (see D9, spec requirement *Goal data always injected*).
- [ ] 2.0a Invert any existing test that asserts "file replaces default entirely" — that assertion was encoding the bug. Replace with the three scenarios under *Goal data always injected*.
- [ ] 2.1 Refactor `extensions/auditor-prompt.ts` to delegate internal logic to `prompt-resolver.ts` (key `"auditor"`)
- [ ] 2.2 Preserve existing public API (`loadAuditorPrompt`, mode enum, source enum)
- [ ] 2.3 Run existing `tests/goal-auditor.test.ts` — confirm zero behavioral regressions
- [ ] 2.4 Add new test case verifying `mode: "override"` works for auditor

## 3. Wire resolver into remaining 6 runtime prompts

- [ ] 3.1 Add optional `cwd` + `settings` params to `goalPrompt()`, `continuationPrompt()`, `goalDraftingPrompt()`, `goalTweakDraftingPrompt()`, `staleContinuationPrompt()`, `unfocusedOpenGoalsPrompt()` in `extensions/prompts/goal-prompts.ts`
- [ ] 3.2 Each fn calls `resolvePrompt(<key>, settings?.prompts?.[<key>], cwd, hardcodedBody)` and returns `final`
- [ ] 3.3 Update call sites in `extensions/goal.ts` to pass `ctx.cwd` + `settings`
- [ ] 3.4 Extend `tests/goal-prompts.test.ts` with override + append scenarios for each fn
- [ ] 3.5 Verify `[PI GOAL ACTIVE ...]` marker preserved under override (assertion: override still includes marker OR document explicitly that override removes it)

## 4. Tool prompt wrapping (D3 — load-time resolution)

- [ ] 4.1 Create `wrapToolDefinition(tool, settings, cwd)` helper that merges resolver output for `promptSnippet` + `promptGuidelines`
- [ ] 4.2 Apply wrapper at every `pi.registerTool(defineTool(...))` call site in `extensions/goal.ts` + `goal-questionnaire.ts` + `goal-auditor.ts`
- [ ] 4.3 Use stable keys: `tool-<toolName>` (e.g., `tool-create-goal`, `tool-get-goal`)
- [ ] 4.4 Add tests: tool prompt override + append, default behavior unchanged
- [ ] 4.5 Document `/reload` requirement after editing tool prompt files

## 5. Settings schema additions

- [ ] 5.1 Add `prompts: Record<string, PromptConfig>` to `GoalSettings` interface + ALLOWED_SETTINGS_KEYS
- [ ] 5.2 Add `promptsDir`, `hooksDir`, `contractsDir` string settings
- [ ] 5.3 Add `commandHooks: {enabled: boolean; [cmd: string]: CommandHookConfig}` block
- [ ] 5.4 Add `contractTemplates: boolean` setting
- [ ] 5.5 Implement legacy alias mapping: `auditorPrompt`/`auditorPromptMode` → `prompts.auditor.{inline,mode}` during parse when `prompts.auditor` absent
- [ ] 5.6 Extend parse to validate nested `prompts.*` shape (`additionalProperties: false` semantics — unknown keys rejected)
- [ ] 5.7 Extend save round-trip to persist all new blocks
- [ ] 5.8 Add env override `PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true`
- [ ] 5.9 Extend `tests/goal-settings.test.ts` with parse + save tests for all new blocks + alias mapping

## 6. Command Hook Loader (D4, D5)

- [ ] 6.1 Create `extensions/command-hook-loader.ts` with `loadHook(name, cwd, settings)` using dynamic `import()`
- [ ] 6.2 Define hook TS interface: `pre?`, `post?`, `handler?` exports
- [ ] 6.3 Implement `wrapHandler(name, original, settings, cwd)` per D4 design
- [ ] 6.4 Wrap every `pi.registerCommand(name, ...)` call in `extensions/goal.ts` via post-registration pass
- [ ] 6.5 Honor `commandHooks.enabled = false` default — skip loading entirely when off
- [ ] 6.6 Error isolation: catch dynamic import errors, emit `ui.notify` warning, fall back to built-in handler
- [ ] 6.7 Implement global→local→builtin→local-post→global-post ordering for append mode
- [ ] 6.8 Implement override mode: local wins, global ignored, builtin passed as 3rd arg
- [ ] 6.9 Create `tests/command-hook-loader.test.ts` covering all scenarios in spec

## 7. Contract Templating (D6)

- [ ] 7.1 Create `extensions/contract-templating.ts` with `expandContractTemplates(contract, cwd, settings)` returning `{expanded, warnings}`
- [ ] 7.2 Resolve `{{name}}` placeholders from `.pi/pi-goal-xx/contracts/<name>.md` (local first, then global)
- [ ] 7.3 Missing snippet → preserve literal `{{name}}` + collect warning
- [ ] 7.4 Honor `contractsDir` path override
- [ ] 7.5 Honor `contractTemplates: false` setting + `PI_GOAL_DISABLE_CONTRACT_TEMPLATES` env → no expansion
- [ ] 7.6 Hook into `extractVerificationContract()` in `extensions/goal-draft.ts` — expand before returning
- [ ] 7.7 Hook into goal-tweak path — re-expand when objective is revised
- [ ] 7.8 Emit `ui.notify` warnings for missing snippets
- [ ] 7.9 Create `tests/contract-templating.test.ts` covering all scenarios

## 8. Settings Menu UI

- [ ] 8.1 Add prompts section to `/goal-settings` menu: list each prompt key, current mode, allow editing
- [ ] 8.2 Add commandHooks toggle: enable/disable + list configured commands
- [ ] 8.3 Add contractTemplates toggle
- [ ] 8.4 Add directory override editors (promptsDir, hooksDir, contractsDir)
- [ ] 8.5 Show legacy auditor settings as "migrated to prompts.auditor" hint when present

## 9. Documentation

- [ ] 9.1 Update README with new settings keys, file paths, modes, hook safety model
- [ ] 9.2 Add `docs/prompt-config.md` covering all 7 runtime prompt keys + tool prompt keys
- [ ] 9.3 Add `docs/command-hooks.md` with examples (pre/post/override) + security warning
- [ ] 9.4 Add `docs/contract-templates.md` with snippet examples + compose patterns
- [ ] 9.5 Add migration note: legacy `auditorPrompt` keys still work (alias)
- [ ] 9.6 Add note about `/reload` requirement for tool prompt + hook changes

## 10. Supersede goal-custom-prompt

- [ ] 10.1 Verify `goal-custom-prompt` change's intended functionality is fully covered by this change
- [ ] 10.2 Add `## Status: SUPERSEDED by unified-prompt-config` header to `openspec/changes/goal-custom-prompt/proposal.md`
- [ ] 10.3 Move `goal-custom-prompt/` to `openspec/changes/done/` or mark closed per project convention

## 11. Final Verification

- [ ] 11.1 Run `npm run check` (tsc --noEmit) — zero errors
- [ ] 11.2 Run `npm test` — all existing tests pass + new tests pass
- [ ] 11.3 Run `npm run test:coverage` — confirm new modules covered (>80%)
- [ ] 11.4 Manual smoke: configure `prompts.goal-running` override + append, verify both work
- [ ] 11.5 Manual smoke: create hook file for `/goals`, verify pre/post fire
- [ ] 11.6 Manual smoke: create `{{verifier-loop}}` snippet, verify expansion at goal-create
- [ ] 11.7 Confirm legacy `auditorPrompt` setting still works end-to-end
