## ADDED Requirements

### Requirement: Wildcard pattern syntax
The system SHALL support glob-style wildcard patterns in `auditorExclude` and `auditorInclude` arrays: `*` matches any characters (including empty), `?` matches single character, no wildcard means exact match.

#### Scenario: Exact match
- **WHEN** pattern is `"write"` (no wildcards)
- **THEN** only matches tool named exactly `"write"`

#### Scenario: Suffix wildcard
- **WHEN** pattern is `"edit_*"`
- **THEN** matches `"edit_file"`, `"edit_config"`, `"edit_anything"`

#### Scenario: Prefix wildcard
- **WHEN** pattern is `"gitnexus*"`
- **THEN** matches `"gitnexus"`, `"gitnexus-query"`, `"gitnexus-context"`

#### Scenario: Middle wildcard
- **WHEN** pattern is `"*deploy*"`
- **THEN** matches `"deploy"`, `"pre-deploy"`, `"deploy-prod"`, `"my-deploy-skill"`

#### Scenario: Single character wildcard
- **WHEN** pattern is `"test_??"`
- **THEN** matches `"test_01"`, `"test_ab"` but not `"test_1"` or `"test_abc"`

#### Scenario: Match all
- **WHEN** pattern is `"*"`
- **THEN** matches all candidates

### Requirement: Case-sensitive pattern matching
The system SHALL perform case-sensitive pattern matching.

#### Scenario: Case sensitivity
- **WHEN** pattern is `"Write"` and candidate is `"write"`
- **THEN** pattern does not match

### Requirement: Per-session pattern cache
The system SHALL cache pattern resolution results in-memory per auditor session to avoid repeated string matching.

#### Scenario: Cache hit
- **WHEN** pattern `"edit_*"` is resolved against main tools
- **THEN** result is cached and subsequent calls return cached result without re-resolution

#### Scenario: Cache lifecycle
- **WHEN** auditor session starts
- **THEN** new empty cache is created

#### Scenario: Cache cleanup
- **WHEN** auditor session ends
- **THEN** cache is cleared

### Requirement: Pattern resolution function
The system SHALL provide a `resolvePattern(pattern, candidates)` function that returns all candidates matching the pattern.

#### Scenario: Resolve wildcard pattern
- **WHEN** `resolvePattern("edit_*", ["read", "write", "edit_file", "edit_config"])` is called
- **THEN** returns `["edit_file", "edit_config"]`

#### Scenario: Resolve exact match
- **WHEN** `resolvePattern("write", ["read", "write", "edit"])` is called
- **THEN** returns `["write"]`

#### Scenario: Resolve no match
- **WHEN** `resolvePattern("delete", ["read", "write", "edit"])` is called
- **THEN** returns `[]`

### Requirement: Apply patterns to resource lists
The system SHALL apply wildcard patterns from `auditorExclude`/`auditorInclude` to filter resource lists (tools, MCP, skills, extensions).

#### Scenario: Apply exclude patterns
- **WHEN** `auditorExclude.tools` is `["write", "edit_*"]` and main tools are `["read", "write", "edit_file", "edit_config", "bash"]`
- **THEN** auditor tools are `["read", "bash"]`

#### Scenario: Apply include patterns
- **WHEN** `auditorMode` is `"minimal"`, `auditorInclude.mcp` is `["gitnexus*"]`, and main MCP servers are `["gitnexus", "gitnexus-query", "hindsight"]`
- **THEN** auditor MCP servers are baseline plus `["gitnexus", "gitnexus-query"]`
