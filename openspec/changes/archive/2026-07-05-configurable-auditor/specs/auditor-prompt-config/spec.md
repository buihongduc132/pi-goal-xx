## ADDED Requirements

### Requirement: Auditor prompt mode configuration
The system SHALL support three prompt resolution modes via `auditorPromptMode` setting: `"global-local"` (default), `"local"`, and `"global-local-merge"`.

#### Scenario: Default global-local mode
- **WHEN** `auditorPromptMode` is not specified
- **THEN** system uses `"global-local"` mode

#### Scenario: Global-local mode with local override
- **WHEN** `auditorPromptMode` is `"global-local"` and `.pi/auditor-prompt.md` exists
- **THEN** auditor uses local prompt only (global is ignored)

#### Scenario: Global-local mode without local
- **WHEN** `auditorPromptMode` is `"global-local"` and `.pi/auditor-prompt.md` does not exist
- **THEN** auditor uses global prompt from `~/.pi/auditor-prompt.md`

#### Scenario: Local mode
- **WHEN** `auditorPromptMode` is `"local"`
- **THEN** auditor uses only `.pi/auditor-prompt.md` (global is never checked)

#### Scenario: Global-local-merge mode
- **WHEN** `auditorPromptMode` is `"global-local-merge"` and both global and local prompts exist
- **THEN** auditor prompt is global + "\n\n" + local (local appended below global)

#### Scenario: Global-local-merge mode without local
- **WHEN** `auditorPromptMode` is `"global-local-merge"` and `.pi/auditor-prompt.md` does not exist
- **THEN** auditor uses global prompt only

### Requirement: Inline prompt override
The system SHALL support `auditorPrompt` setting as inline string that takes precedence over file-based prompts.

#### Scenario: Inline prompt override
- **WHEN** `auditorPrompt` is set in settings.json
- **THEN** auditor uses inline prompt regardless of `auditorPromptMode` or file existence

#### Scenario: Inline prompt with mode
- **WHEN** `auditorPrompt` is set and `auditorPromptMode` is `"local"`
- **THEN** inline prompt takes precedence (mode is ignored)

### Requirement: Global prompt file location
The system SHALL read global auditor prompt from `~/.pi/auditor-prompt.md`.

#### Scenario: Global prompt exists
- **WHEN** `~/.pi/auditor-prompt.md` exists
- **THEN** system reads prompt content from this file

#### Scenario: Global prompt does not exist
- **WHEN** `~/.pi/auditor-prompt.md` does not exist
- **THEN** system uses hardcoded default prompt

### Requirement: Local prompt file location
The system SHALL read project-local auditor prompt from `.pi/auditor-prompt.md` (relative to cwd).

#### Scenario: Local prompt exists
- **WHEN** `.pi/auditor-prompt.md` exists in project cwd
- **THEN** system reads prompt content from this file

#### Scenario: Local prompt does not exist
- **WHEN** `.pi/auditor-prompt.md` does not exist
- **THEN** system falls back to global prompt or hardcoded default based on mode

### Requirement: Hardcoded default prompt fallback
The system SHALL use hardcoded default auditor prompt when no file-based or inline prompt is available.

#### Scenario: No prompts available
- **WHEN** neither inline prompt nor file-based prompts exist
- **THEN** system uses hardcoded default prompt from `buildGoalAuditorPrompt()`

### Requirement: Invalid prompt mode handling
The system SHALL reject invalid `auditorPromptMode` values and fall back to `"global-local"`.

#### Scenario: Invalid mode value
- **WHEN** `auditorPromptMode` is set to `"invalid-mode"`
- **THEN** system logs warning and uses `"global-local"` mode
