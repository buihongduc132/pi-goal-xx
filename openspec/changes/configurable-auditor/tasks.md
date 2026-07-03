## 1. Settings Configuration

- [ ] 1.1 Add `auditorMode` field to `GoalSettings` interface in `goal-settings.ts`
- [ ] 1.2 Add `auditorExclude` field (object with `tools`, `mcp`, `skills`, `extensions` arrays) to `GoalSettings`
- [ ] 1.3 Add `auditorInclude` field (object with `tools`, `mcp`, `skills`, `extensions` arrays) to `GoalSettings`
- [ ] 1.4 Add `auditorPromptMode` field to `GoalSettings` with values `"global-local" | "local" | "global-local-merge"`
- [ ] 1.5 Add `auditorPrompt` field (inline string override) to `GoalSettings`
- [ ] 1.6 Update `parseGoalSettings()` to validate and parse new fields
- [ ] 1.7 Update `loadGoalSettings()` to load new fields from settings file
- [ ] 1.8 Update `saveGoalSettingsFileConfig()` to persist new fields
- [ ] 1.9 Add unit tests for settings parsing and validation

## 2. Wildcard Pattern Matching

- [ ] 2.1 Create `AuditorPatternCache` class with `Map<string, string[]>` for caching
- [ ] 2.2 Implement `globToRegex(pattern)` function to convert glob patterns to regex
- [ ] 2.3 Implement `resolvePattern(pattern, candidates)` function with cache lookup
- [ ] 2.4 Implement `matchPattern(pattern, candidate)` for single candidate matching
- [ ] 2.5 Add unit tests for wildcard matching (exact, `*`, `?`, combinations)
- [ ] 2.6 Add unit tests for pattern cache (hit, miss, lifecycle)

## 3. Auditor Modes Implementation

- [ ] 3.1 Implement `resolveAuditorTools(mainTools, config, cache)` function
- [ ] 3.2 Implement `resolveAuditorMcp(mainMcp, config, cache)` function
- [ ] 3.3 Implement `resolveAuditorSkills(mainSkills, config, cache)` function
- [ ] 3.4 Implement `resolveAuditorExtensions(mainExtensions, config, cache)` function
- [ ] 3.5 Add logic to apply `auditorExclude` filters in `inherit` mode
- [ ] 3.6 Add logic to apply `auditorInclude` additions in `minimal` mode
- [ ] 3.7 Add unit tests for `inherit` mode with various exclude patterns
- [ ] 3.8 Add unit tests for `minimal` mode with various include patterns

## 4. Prompt Configuration

- [ ] 4.1 Implement `loadAuditorPrompt(config, cwd)` function
- [ ] 4.2 Add logic to read global prompt from `~/.pi/auditor-prompt.md`
- [ ] 4.3 Add logic to read local prompt from `.pi/auditor-prompt.md` (cwd-relative)
- [ ] 4.4 Implement `global-local` mode (local overrides global)
- [ ] 4.5 Implement `local` mode (local only, no global fallback)
- [ ] 4.6 Implement `global-local-merge` mode (global + "\n\n" + local)
- [ ] 4.7 Add logic to use inline `auditorPrompt` as override (takes precedence)
- [ ] 4.8 Add fallback to hardcoded `buildGoalAuditorPrompt()` when no prompts available
- [ ] 4.9 Add unit tests for all three prompt modes
- [ ] 4.10 Add unit tests for inline prompt override

## 5. Resource Inheritance

- [ ] 5.1 Refactor `makeAuditorResourceLoader()` to accept main session's resource loader
- [ ] 5.2 Pass main session's tool list to auditor via `resolveAuditorTools()`
- [ ] 5.3 Pass main session's MCP config to auditor's settings manager (not InMemory)
- [ ] 5.4 Pass main session's skills to auditor via resource loader
- [ ] 5.5 Pass main session's extensions to auditor via resource loader
- [ ] 5.6 Ensure auditor cwd is always set to main session's cwd
- [ ] 5.7 Update `runGoalCompletionAuditor()` to accept main session resources as parameters
- [ ] 5.8 Update `goal.ts` to pass main session resources when calling auditor

## 6. Integration & Testing

- [ ] 6.1 Update `goal.ts` to create `AuditorPatternCache` before calling auditor
- [ ] 6.2 Update `goal.ts` to clear cache after auditor completes
- [ ] 6.3 Add integration test: auditor with `inherit` mode and excludes
- [ ] 6.4 Add integration test: auditor with `minimal` mode and includes
- [ ] 6.5 Add integration test: auditor with wildcard patterns
- [ ] 6.6 Add integration test: auditor with prompt modes
- [ ] 6.7 Add integration test: auditor inherits MCP servers
- [ ] 6.8 Add integration test: auditor inherits skills
- [ ] 6.9 Verify backward compatibility: default behavior works without config

## 7. Documentation

- [ ] 7.1 Update README.md with auditor configuration section
- [ ] 7.2 Document `auditorMode` setting with examples
- [ ] 7.3 Document `auditorExclude` and `auditorInclude` with wildcard examples
- [ ] 7.4 Document `auditorPromptMode` with file locations
- [ ] 7.5 Add configuration example for common use cases (read-only auditor, full auditor)
