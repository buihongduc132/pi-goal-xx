# auditor-modes Specification

## Purpose
TBD - created by archiving change configurable-auditor. Update Purpose after archive.
## Requirements
### Requirement: Auditor mode configuration
The system SHALL support two auditor operational modes via `auditorMode` setting: `"inherit"` (default) and `"minimal"`.

#### Scenario: Default inherit mode
- **WHEN** `auditorMode` is not specified in settings
- **THEN** auditor starts with all main session resources (tools, MCP, skills, extensions) and applies `auditorExclude` filters

#### Scenario: Explicit inherit mode
- **WHEN** `auditorMode` is set to `"inherit"`
- **THEN** auditor starts with all main session resources and applies `auditorExclude` filters

#### Scenario: Minimal mode
- **WHEN** `auditorMode` is set to `"minimal"`
- **THEN** auditor starts with baseline tools (`read`, `grep`, `find`, `ls`, `bash`, `report_auditor_progress`) and applies `auditorInclude` additions

### Requirement: Auditor exclude configuration
The system SHALL support `auditorExclude` configuration object with `tools`, `mcp`, `skills`, and `extensions` arrays for filtering resources in `inherit` mode.

#### Scenario: Exclude specific tools
- **WHEN** `auditorExclude.tools` contains `["write", "edit"]`
- **THEN** auditor session does not include `write` and `edit` tools

#### Scenario: Exclude MCP servers
- **WHEN** `auditorExclude.mcp` contains `["dangerous-server"]`
- **THEN** auditor session does not connect to `dangerous-server` MCP

#### Scenario: Exclude skills
- **WHEN** `auditorExclude.skills` contains `["deploy-skill"]`
- **THEN** auditor session does not load `deploy-skill`

#### Scenario: Exclude extensions
- **WHEN** `auditorExclude.extensions` contains `["cc-safety-net*"]`
- **THEN** auditor session does not load extensions matching the pattern

### Requirement: Auditor include configuration
The system SHALL support `auditorInclude` configuration object with `tools`, `mcp`, `skills`, and `extensions` arrays for adding resources in `minimal` mode.

#### Scenario: Include additional tools
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.tools` contains `["gitnexus_query"]`
- **THEN** auditor session includes baseline tools plus `gitnexus_query`

#### Scenario: Include MCP servers
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.mcp` contains `["gitnexus"]`
- **THEN** auditor session connects to `gitnexus` MCP server

#### Scenario: Include skills
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.skills` contains `["project-testing"]`
- **THEN** auditor session loads `project-testing` skill

### Requirement: Invalid auditor mode handling
The system SHALL reject invalid `auditorMode` values and fall back to `"inherit"`.

#### Scenario: Invalid mode value
- **WHEN** `auditorMode` is set to `"invalid-mode"`
- **THEN** system logs warning and uses `"inherit"` mode

