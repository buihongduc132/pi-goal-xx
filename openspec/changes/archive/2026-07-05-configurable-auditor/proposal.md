## Why

The completion auditor is currently hardcoded with limited tools (`read`, `grep`, `find`, `ls`, `bash`), no MCP servers, no skills, and no extensions. This prevents it from verifying work that requires MCP tools (databases, APIs, external services), project-specific knowledge (skills), or delegation capabilities. Users cannot customize the auditor's prompt, tools, or resource access to match their project's verification needs.

## What Changes

- **Two auditor modes**: `inherit` (default) starts with all main session resources and opts out; `minimal` starts with baseline and opts in
- **Wildcard matching**: Tools, MCP servers, skills, and extensions can be filtered using glob patterns (`*`, `?`) in configuration
- **Per-session caching**: Pattern resolution results cached in-memory to avoid repeated string matching
- **Three prompt modes**: `global-local` (local overrides global), `local` (local only), `global-local-merge` (local appended below global)
- **Full resource inheritance**: Auditor inherits tools, MCP servers, skills, and extensions from main session (configurable via exclude/include)
- **Configurable cwd**: Auditor always uses main session's cwd (not separately configurable)

## Capabilities

### New Capabilities

- `auditor-modes`: Two operational modes (`inherit`/`minimal`) with opt-out/opt-in filtering for tools, MCP, skills, and extensions
- `auditor-wildcard-matching`: Glob pattern support (`*`, `?`) for filtering tools, MCP servers, skills, and extensions with per-session caching
- `auditor-prompt-config`: Three prompt resolution modes (`global-local`, `local`, `global-local-merge`) with file-based and inline override support
- `auditor-resource-inheritance`: Inherit tools, MCP servers, skills, and extensions from main session with configurable exclude/include lists

### Modified Capabilities

(none — this is a new feature set)

## Impact

- **Code**: `goal-settings.ts` (new config fields), `goal-auditor.ts` (resource loading, pattern matching, caching), `goal.ts` (pass main session resources to auditor)
- **Configuration**: New settings fields: `auditorMode`, `auditorExclude`, `auditorInclude`, `auditorPromptMode`, `auditorPrompt`
- **Files**: New optional files: `~/.pi/auditor-prompt.md` (global), `.pi/auditor-prompt.md` (project-local)
- **Dependencies**: None (uses existing pi-coding-agent APIs)
- **Backward compatibility**: Default behavior (`auditorMode: "inherit"` with no excludes) provides broader verification than current hardcoded approach
