## ADDED Requirements

### Requirement: Settings file schema accepts prompt configuration block

The unified settings file at `.pi/pi-goal-xx-settings.json` SHALL accept a `prompts` block mapping each known prompt key to `{mode, inline}` where mode is one of `"override"`, `"append"`, `"global-local"` (default), `"local"`, `"global-local-merge"`, `"off"`. The block SHALL be optional. Unknown keys inside `prompts` MUST be rejected (`additionalProperties: false` semantics preserved).

#### Scenario: prompts block round-trips through parse and save

- **WHEN** the settings file contains `{"prompts": {"goal-running": {"mode": "append", "inline": "X"}}}`
- **THEN** `loadGoalSettings()` returns the block verbatim
- **AND** `saveGoalSettingsFileConfig()` writes the block back unchanged

#### Scenario: Unknown prompt key rejected

- **WHEN** settings contains `{"prompts": {"unknown-key": {...}}}`
- **THEN** parse rejects the file with an error naming the unknown key

### Requirement: Legacy auditor prompt keys remain valid aliases

The system SHALL accept `auditorPrompt` and `auditorPromptMode` at the settings root for backward compatibility. When present and `prompts.auditor` is absent, the legacy keys map to `prompts.auditor.inline` and `prompts.auditor.mode` respectively during parse.

#### Scenario: Legacy auditor keys map to prompts.auditor

- **WHEN** settings contains `{"auditorPrompt": "X", "auditorPromptMode": "local"}`
- **AND** no `prompts` block is present
- **THEN** the resolver sees `prompts.auditor = {inline: "X", mode: "local"}`

### Requirement: Settings file accepts commandHooks block

The settings file SHALL accept a `commandHooks` block: `{enabled: boolean, [commandName]: {mode: "append"|"override", preInline?, postInline?}}`. The `enabled` field defaults to `false`.

#### Scenario: commandHooks enabled flag defaults false

- **WHEN** settings contains `{"commandHooks": {"goals": {...}}}` without `enabled`
- **THEN** `commandHooks.enabled` resolves to `false` and no hooks load

### Requirement: Settings file accepts contractTemplates and contractsDir

The settings file SHALL accept `contractTemplates: boolean` (default true) and `contractsDir: string` (default `.pi/pi-goal-xx/contracts/`).

#### Scenario: Templates disabled via settings

- **WHEN** settings contains `{"contractTemplates": false}`
- **THEN** template expansion is disabled for all new goals

### Requirement: Settings file accepts promptsDir override

The settings file SHALL accept `promptsDir: string` (default `.pi/pi-goal-xx/prompts/`).

#### Scenario: Custom prompts directory round-trips

- **WHEN** settings contains `{"promptsDir": "/etc/pi/prompts"}`
- **THEN** resolver reads from the custom directory
- **AND** save persists the value unchanged
