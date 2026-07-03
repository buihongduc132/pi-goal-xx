## 1. Settings Configuration

- [x] 1.1 Add `auditorMode` field to `GoalSettings` interface in `goal-settings.ts`
- [x] 1.2 Add `auditorExclude` field (object with `tools`, `mcp`, `skills`, `extensions` arrays) to `GoalSettings`
- [x] 1.3 Add `auditorInclude` field (object with `tools`, `mcp`, `skills`, `extensions` arrays) to `GoalSettings`
- [x] 1.4 Add `auditorPromptMode` field to `GoalSettings` with values `"global-local" | "local" | "global-local-merge"`
- [x] 1.5 Add `auditorPrompt` field (inline string override) to `GoalSettings`
- [x] 1.6 Update `parseGoalSettings()` to validate and parse new fields
- [x] 1.7 Update `loadGoalSettings()` to load new fields from settings file
- [x] 1.8 Update `saveGoalSettingsFileConfig()` to persist new fields
- [x] 1.9 Add unit tests for settings parsing and validation — `tests/goal-settings.test.ts`

## 2. Wildcard Pattern Matching

- [x] 2.1 Create `AuditorPatternCache` class with `Map<string, string[]>` for caching
- [x] 2.2 Implement `globToRegex(pattern)` function to convert glob patterns to regex
- [x] 2.3 Implement `resolvePattern(pattern, candidates)` function with cache lookup
- [x] 2.4 Implement `matchPattern(pattern, candidate)` for single candidate matching
- [x] 2.5 Add unit tests for wildcard matching (exact, `*`, `?`, combinations) — `tests/auditor-patterns.test.ts`
- [x] 2.6 Add unit tests for pattern cache (hit, miss, lifecycle)

## 3. Auditor Modes Implementation

- [x] 3.1 Implement `resolveAuditorTools(mainTools, config, cache)` function
- [x] 3.2 Implement `resolveAuditorMcp(mainMcp, config, cache)` function
- [x] 3.3 Implement `resolveAuditorSkills(mainSkills, config, cache)` function
- [x] 3.4 Implement `resolveAuditorExtensions(mainExtensions, config, cache)` function
- [x] 3.5 Add logic to apply `auditorExclude` filters in `inherit` mode
- [x] 3.6 Add logic to apply `auditorInclude` additions in `minimal` mode
- [x] 3.7 Add unit tests for `inherit` mode with various exclude patterns — `tests/auditor-modes.test.ts`
- [x] 3.8 Add unit tests for `minimal` mode with various include patterns

## 4. Prompt Configuration

- [x] 4.1 Implement `loadAuditorPrompt(config, cwd)` function
- [x] 4.2 Add logic to read global prompt from `~/.pi/auditor-prompt.md`
- [x] 4.3 Add logic to read local prompt from `.pi/auditor-prompt.md` (cwd-relative)
- [x] 4.4 Implement `global-local` mode (local overrides global)
- [x] 4.5 Implement `local` mode (local only, no global fallback)
- [x] 4.6 Implement `global-local-merge` mode (global + "\n\n" + local)
- [x] 4.7 Add logic to use inline `auditorPrompt` as override (takes precedence)
- [x] 4.8 Add fallback to hardcoded `buildGoalAuditorPrompt()` when no prompts available
- [x] 4.9 Add unit tests for all three prompt modes — `tests/auditor-prompt.test.ts`
- [x] 4.10 Add unit tests for inline prompt override

## 5. Resource Inheritance

- [x] 5.1 Refactor `makeAuditorResourceLoader()` to accept main session's resource loader
- [x] 5.2 Pass main session's tool list to auditor via `resolveAuditorTools()` — wired in `goal.ts` via `safeGetActiveTools(pi)`
- [ ] 5.3 Pass main session's MCP config to auditor's settings manager (not InMemory) — **BLOCKED**: `@earendil-works/pi-coding-agent`'s extension API exposes no main-session MCP config; auditor uses `SettingsManager.inMemory()`. Resolution logic (`resolveAuditorMcp`) is built and tested; takes effect once pi exposes an MCP allowlist/config accessor. See note in `goal-auditor.ts` `makeAuditorResourceLoader`.
- [ ] 5.4 Pass main session's skills to auditor via resource loader — **PARTIAL/BLOCKED**: `makeAuditorResourceLoader` filters main loader skills when `mainResources.resourceLoader` is supplied (covered by `tests/goal-auditor-config.test.ts` "resourceLoader inheritance" suite). `goal.ts` cannot obtain the main session's `ResourceLoader` from the extension API, so it is not passed in production; auditor degrades to an empty skill set (backward compatible).
- [ ] 5.5 Pass main session's extensions to auditor via resource loader — **PARTIAL/BLOCKED**: same as 5.4 — mechanism + unit tests done; production wiring blocked by the same upstream API gap.
- [x] 5.6 Ensure auditor cwd is always set to main session's cwd — `createSession({ cwd: args.ctx.cwd })`
- [x] 5.7 Update `runGoalCompletionAuditor()` to accept main session resources as parameters — `mainResources?: MainSessionResources`
- [x] 5.8 Update `goal.ts` to pass main session resources when calling auditor — `mainResources: { tools: safeGetActiveTools(pi) }`

## 6. Integration & Testing

- [x] 6.1 Update `goal.ts` to create `AuditorPatternCache` before calling auditor — created inside `runGoalCompletionAuditor`
- [x] 6.2 Update `goal.ts` to clear cache after auditor completes — cache is local to the auditor run (GC'd)
- [x] 6.3 Add integration test: auditor with `inherit` mode and excludes — `tests/goal-auditor-config.test.ts`
- [x] 6.4 Add integration test: auditor with `minimal` mode and includes
- [x] 6.5 Add integration test: auditor with wildcard patterns
- [x] 6.6 Add integration test: auditor with prompt modes
- [ ] 6.7 Add integration test: auditor inherits MCP servers — **BLOCKED**: see 5.3. `resolveAuditorMcp` is unit-tested; e2e MCP inheritance requires the upstream API gap to be closed.
- [ ] 6.8 Add integration test: auditor inherits skills — **PARTIAL**: unit-level "delegates to main resourceLoader" + "filters inherited skills by exclude pattern" cover the mechanism; e2e requires the upstream API gap (see 5.4).
- [x] 6.9 Verify backward compatibility: default behavior works without config — "falls back to baseline tools when no mainResources" + default mode tests

## 7. Documentation

- [x] 7.1 Update README.md with auditor configuration section — "Configurable auditor" section
- [x] 7.2 Document `auditorMode` setting with examples
- [x] 7.3 Document `auditorExclude` and `auditorInclude` with wildcard examples
- [x] 7.4 Document `auditorPromptMode` with file locations
- [x] 7.5 Add configuration example for common use cases (read-only auditor, full auditor)

---

## Upstream-blocked items summary

Tasks **5.3, 5.4 (e2e), 5.5 (e2e), 6.7, 6.8 (e2e)** depend on `@earendil-works/pi-coding-agent`
exposing the main session's `ResourceLoader`, MCP config, skills list, and extensions list
to extensions. As of the version pinned in this fork, the public `ExtensionAPI` only exposes
`getActiveTools()`. Every resolution function (`resolveAuditorMcp` / `resolveAuditorSkills` /
`resolveAuditorExtensions`) and the resource-loader filter (`makeAuditorResourceLoader`) are
implemented and unit-tested with injected fakes, so they activate the moment pi exposes the
missing accessors — no code change to the resolution layer will be needed.

This limitation is documented in code (`goal-auditor.ts`, `makeAuditorResourceLoader` jsdoc)
and the design doc's risk section.
