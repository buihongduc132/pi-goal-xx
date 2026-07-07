## ADDED Requirements

### Requirement: goalPromptMode setting
The settings schema SHALL accept a `goalPromptMode` key with allowed values `"global-local"`, `"local"`, `"global-local-merge"`. Default (when unset) SHALL be `"global-local"`. Invalid values SHALL be silently dropped (caller falls back to default).

#### Scenario: Valid mode parsed
- **WHEN** settings JSON contains `"goalPromptMode": "local"`
- **THEN** `parseGoalSettings()` returns `goalPromptMode: "local"`

#### Scenario: Invalid mode dropped
- **WHEN** settings JSON contains `"goalPromptMode": "weird"`
- **THEN** `parseGoalSettings()` returns no `goalPromptMode` and resolver defaults to `"global-local"`

### Requirement: goalPrompt setting
The settings schema SHALL accept a `goalPrompt` key holding a non-empty inline string. Blank/whitespace-only values SHALL be ignored.

#### Scenario: Inline prompt parsed
- **WHEN** settings JSON contains `"goalPrompt": "RULES-HERE"`
- **THEN** `parseGoalSettings()` returns `goalPrompt: "RULES-HERE"`

#### Scenario: Blank inline ignored
- **WHEN** settings JSON contains `"goalPrompt": "   "`
- **THEN** `parseGoalSettings()` returns no `goalPrompt`

### Requirement: Unknown keys still rejected
The new keys SHALL be added to the allowed-keys set. `additionalProperties: false` semantics SHALL remain in force: any other unknown key SHALL still cause `parseGoalSettings()` to throw.

#### Scenario: New keys accepted
- **WHEN** settings JSON contains only `goalPrompt` and `goalPromptMode`
- **THEN** `parseGoalSettings()` does not throw

#### Scenario: Other unknown key still throws
- **WHEN** settings JSON contains `"randomUnknownKey": true`
- **THEN** `parseGoalSettings()` throws an `Unknown ... key(s)` error

### Requirement: Save round-trip
`saveGoalSettingsFileConfig()` SHALL persist `goalPrompt` and `goalPromptMode` (when set) and SHALL read them back via `parseGoalSettings()` losslessly.

#### Scenario: Round-trip preserves both keys
- **WHEN** `saveGoalSettingsFileConfig(cwd, { goalPrompt: "X", goalPromptMode: "local" })` is called and the file is re-parsed
- **THEN** the parsed result has `goalPrompt: "X"` and `goalPromptMode: "local"`
