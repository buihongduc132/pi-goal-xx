## ADDED Requirements

### Requirement: Inherit tools from main session
The system SHALL pass main session's tool list to auditor when creating auditor session.

#### Scenario: Inherit mode tool inheritance
- **WHEN** `auditorMode` is `"inherit"` and main session has tools `["read", "write", "edit", "bash", "gitnexus_query"]`
- **THEN** auditor session starts with all main tools (minus any `auditorExclude.tools` filters)

#### Scenario: Minimal mode baseline tools
- **WHEN** `auditorMode` is `"minimal"`
- **THEN** auditor session starts with baseline tools `["read", "grep", "find", "ls", "bash", "report_auditor_progress"]` plus any `auditorInclude.tools`

### Requirement: Inherit MCP servers from main session
The system SHALL pass main session's MCP server configuration to auditor.

#### Scenario: Inherit mode MCP inheritance
- **WHEN** `auditorMode` is `"inherit"` and main session has MCP servers `["gitnexus", "hindsight"]`
- **THEN** auditor session connects to all main MCP servers (minus any `auditorExclude.mcp` filters)

#### Scenario: Minimal mode MCP inclusion
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.mcp` is `["gitnexus"]`
- **THEN** auditor session connects to `gitnexus` MCP server only

#### Scenario: MCP config passed to settings manager
- **WHEN** auditor session is created
- **THEN** MCP configuration is passed to auditor's settings manager (not InMemory)

### Requirement: Inherit skills from main session
The system SHALL pass main session's skill list to auditor via resource loader.

#### Scenario: Inherit mode skill inheritance
- **WHEN** `auditorMode` is `"inherit"` and main session has skills `["project-testing", "deploy-skill"]`
- **THEN** auditor session loads all main skills (minus any `auditorExclude.skills` filters)

#### Scenario: Minimal mode skill inclusion
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.skills` is `["project-testing"]`
- **THEN** auditor session loads `project-testing` skill only

### Requirement: Inherit extensions from main session
The system SHALL pass main session's extension list to auditor via resource loader.

#### Scenario: Inherit mode extension inheritance
- **WHEN** `auditorMode` is `"inherit"` and main session has extensions `["cc-safety-net", "goal", "gitnexus"]`
- **THEN** auditor session loads all main extensions (minus any `auditorExclude.extensions` filters)

#### Scenario: Minimal mode extension inclusion
- **WHEN** `auditorMode` is `"minimal"` and `auditorInclude.extensions` is `["gitnexus"]`
- **THEN** auditor session loads `gitnexus` extension only

### Requirement: Pass main session resource loader
The system SHALL pass main session's resource loader to auditor for resource inheritance.

#### Scenario: Resource loader passed
- **WHEN** auditor session is created
- **THEN** main session's resource loader is passed to auditor (not empty loader)

#### Scenario: Resource loader used for skills
- **WHEN** auditor needs to load skills
- **THEN** auditor uses main session's resource loader to get skill list

### Requirement: Auditor cwd always matches main
The system SHALL always use main session's cwd for auditor session.

#### Scenario: cwd inheritance
- **WHEN** auditor session is created
- **THEN** auditor cwd is set to main session's cwd (not separately configurable)

### Requirement: Auditor model configuration
The system SHALL support auditor model configuration via existing `provider`, `model`, and `thinkingLevel` settings.

#### Scenario: Model inheritance
- **WHEN** `provider` and `model` are set in settings
- **THEN** auditor uses specified provider/model

#### Scenario: Model fallback
- **WHEN** `provider` and `model` are not set
- **THEN** auditor uses main session's model

### Requirement: Report auditor progress tool
The system SHALL provide `report_auditor_progress` tool to auditor for progress reporting.

#### Scenario: Progress tool available
- **WHEN** auditor session is created
- **THEN** `report_auditor_progress` tool is available to auditor

#### Scenario: Progress reporting
- **WHEN** auditor calls `report_auditor_progress(label="Inspecting files...", percentage=25)`
- **THEN** UI displays progress to user
