# Explore Turn 3 — Wildcard Matching + Caching

> Date: 2026-07-03
> Phase: Refinement
> Status: Completed

---

## [user]

> **[user]** (verbatim — trust chain L1)
> 
> MAKE THE skill / mcp / tools configuration will be having something_* matching as well ; 
> 
> on each session , ensure that these * matching are cached so that it is not need to do heavy string matching every time ; Just need in memory cache.

---

## [assistant]

### Wildcard Matching Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WILDCARD MATCHING DESIGN                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Pattern syntax:                                                             │
│  ────────────────                                                            │
│  • "*" matches any characters (including empty)                              │
│  • "?" matches single character                                              │
│  • No pattern = exact match                                                  │
│                                                                              │
│  Examples:                                                                   │
│  ─────────                                                                   │
│  "write"          → exact match "write"                                      │
│  "edit_*"         → matches "edit_file", "edit_config", etc.                 │
│  "gitnexus*"      → matches "gitnexus", "gitnexus-query", etc.               │
│  "*deploy*"       → matches "deploy", "pre-deploy", "deploy-prod", etc.      │
│  "test_??"        → matches "test_01", "test_ab", etc.                       │
│  "*"              → matches everything                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuration Examples

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONFIGURATION EXAMPLES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  INHERIT MODE with wildcards                                           │ │
│  │  ──────────────────────────────────────                                │ │
│  │                                                                        │ │
│  │  {                                                                     │ │
│  │    "auditorMode": "inherit",                                          │ │
│  │    "auditorExclude": {                                                │ │
│  │      "tools": ["write", "edit", "edit_*"],      // block all edits    │ │
│  │      "mcp": ["*write*", "*mutate*"],            // block write MCP    │ │
│  │      "skills": ["*deploy*", "*publish*"],       // block deploy skills│ │
│  │      "extensions": ["cc-safety-net*"]           // block safety ext   │ │
│  │    }                                                                  │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  Result: Auditor gets everything EXCEPT:                               │ │
│  │  - write, edit, edit_file, edit_config, ...                            │ │
│  │  - Any MCP with "write" or "mutate" in name                            │ │
│  │  - deploy-skill, pre-deploy, publish-npm, ...                          │ │
│  │  - cc-safety-net, cc-safety-net-pi, ...                                │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  MINIMAL MODE with wildcards                                           │ │
│  │  ───────────────────────────────────                                   │ │
│  │                                                                        │ │
│  │  {                                                                     │ │
│  │    "auditorMode": "minimal",                                          │ │
│  │    "auditorInclude": {                                                │ │
│  │      "tools": ["read", "grep", "find", "bash"],                       │ │
│  │      "mcp": ["gitnexus*", "hindsight*"],        // include both       │ │
│  │      "skills": ["*test*", "*lint*"],            // testing/lint skills│ │
│  │      "extensions": []                                                  │ │
│  │    }                                                                  │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  Result: Auditor gets baseline + gitnexus/hindsight MCP + test skills  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Caching Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CACHING ARCHITECTURE                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Per-session cache (in-memory, cleared on session end):                     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  AuditorSession                                                        │ │
│  │  ──────────────                                                        │ │
│  │                                                                        │ │
│  │  patternCache: Map<string, string[]>                                   │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │ │
│  │  │  Key                    │ Value                                  │  │ │
│  │  ├─────────────────────────┼────────────────────────────────────────┤  │ │
│  │  │  "edit_*"              │ ["edit_file", "edit_config", ...]      │  │ │
│  │  │  "gitnexus*"           │ ["gitnexus", "gitnexus-query", ...]    │  │ │
│  │  │  "*deploy*"            │ ["deploy", "pre-deploy", ...]          │  │ │
│  │  │  "tools:exclude"       │ ["read", "bash", ...] (resolved list)  │  │ │
│  │  │  "mcp:include"         │ ["gitnexus", "hindsight", ...]         │  │ │
│  │  │  "skills:exclude"      │ ["deploy-skill", ...]                  │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                        │ │
│  │  Resolution flow:                                                      │ │
│  │  ─────────────────                                                     │ │
│  │  1. First call: pattern "edit_*" → resolve against main tools          │ │
│  │  2. Cache result: patternCache.set("edit_*", ["edit_file", ...])       │ │
│  │  3. Subsequent calls: hit cache, no re-resolution                      │ │
│  │                                                                        │ │
│  │  Cache keys:                                                           │ │
│  │  ───────────                                                           │ │
│  │  • "<pattern>" → resolved names for that pattern                       │ │
│  │  • "tools:exclude" → final resolved tool list (after all excludes)     │ │
│  │  • "mcp:include" → final resolved MCP list (after all includes)        │ │
│  │  • "skills:exclude" → final resolved skill list                        │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Cache lifecycle:                                                            │
│  ─────────────────                                                           │
│  • Created: when auditor session starts                                      │
│  • Populated: lazily on first pattern resolution                             │
│  • Cleared: when auditor session ends (session_shutdown)                     │
│  • Scope: per auditor invocation (not shared across audits)                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Resolution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RESOLUTION FLOW                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  resolveAuditorTools(mainTools, config, cache):                              │
│  ─────────────────────────────────────────────                               │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  if (config.auditorMode === "inherit") {                             │   │
│  │    // Start with all main tools                                      │   │
│  │    let result = [...mainTools];                                      │   │
│  │                                                                      │   │
│  │    // Apply excludes with wildcard matching                          │   │
│  │    for (const pattern of config.auditorExclude?.tools ?? []) {       │   │
│  │      const excluded = cache.get(pattern) ??                          │   │
│  │        resolvePattern(pattern, mainTools);                           │   │
│  │      cache.set(pattern, excluded);                                   │   │
│  │      result = result.filter(t => !excluded.includes(t));             │   │
│  │    }                                                                 │   │
│  │    return result;                                                    │   │
│  │  }                                                                   │   │
│  │                                                                      │   │
│  │  if (config.auditorMode === "minimal") {                             │   │
│  │    // Start with baseline                                            │   │
│  │    let result = ["read", "grep", "find", "ls", "bash",               │   │
│  │                  "report_auditor_progress"];                         │   │
│  │                                                                      │   │
│  │    // Add includes with wildcard matching                            │   │
│  │    for (const pattern of config.auditorInclude?.tools ?? []) {       │   │
│  │      const included = cache.get(pattern) ??                          │   │
│  │        resolvePattern(pattern, mainTools);                           │   │
│  │      cache.set(pattern, included);                                   │   │
│  │      result = [...new Set([...result, ...included])];                │   │
│  │    }                                                                 │   │
│  │    return result;                                                    │   │
│  │  }                                                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  resolvePattern(pattern, candidates):                                        │
│  ─────────────────────────────────────────                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  if (!pattern.includes("*") && !pattern.includes("?")) {             │   │
│  │    // Exact match                                                    │   │
│  │    return candidates.includes(pattern) ? [pattern] : [];             │   │
│  │  }                                                                   │   │
│  │                                                                      │   │
│  │  // Convert glob to regex                                            │   │
│  │  const regex = globToRegex(pattern);                                 │   │
│  │  return candidates.filter(c => regex.test(c));                       │   │
│  │                                                                      │   │
│  │  // globToRegex:                                                      │   │
│  │  //   "*" → ".*"                                                      │   │
│  │  //   "?" → "."                                                       │   │
│  │  //   escape other regex chars                                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Updated Settings Schema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SETTINGS SCHEMA (updated)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  {                                                                           │
│    // ── Auditor mode ──────────────────────────────────────────────────    │
│    "auditorMode": "inherit",                    // "inherit" | "minimal"    │
│                                                                              │
│    // ── For "inherit" mode: what to exclude (supports wildcards) ──────    │
│    "auditorExclude": {                                                       │
│      "tools": ["write", "edit_*"],              // exact + wildcard         │
│      "mcp": ["*write*", "*mutate*"],            // any MCP with these       │
│      "skills": ["*deploy*", "*publish*"],       // any skill with these     │
│      "extensions": ["cc-safety-net*"]           // prefix match             │
│    },                                                                        │
│                                                                              │
│    // ── For "minimal" mode: what to include (supports wildcards) ──────    │
│    "auditorInclude": {                                                       │
│      "tools": ["read", "bash", "grep_*"],                                   │
│      "mcp": ["gitnexus*", "hindsight*"],                                    │
│      "skills": ["*test*", "*lint*"],                                        │
│      "extensions": []                                                        │
│    },                                                                        │
│                                                                              │
│    // ── Prompt configuration ──────────────────────────────────────────    │
│    "auditorPromptMode": "global-local",         // see previous design      │
│    "auditorPrompt": "inline override...",                                   │
│                                                                              │
│    // ── Existing config ───────────────────────────────────────────────    │
│    "provider": "zai",                                                        │
│    "model": "gpt-4o",                                                        │
│    "thinkingLevel": "high"                                                   │
│  }                                                                           │
│                                                                              │
│  Pattern rules:                                                              │
│  ──────────────                                                              │
│  • "*" matches any characters (including empty)                              │
│  • "?" matches single character                                              │
│  • No wildcard = exact match                                                 │
│  • Patterns are case-sensitive                                               │
│  • Empty pattern list = no filtering                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Cache Implementation Notes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CACHE IMPLEMENTATION NOTES                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Cache structure:                                                            │
│  ────────────────                                                            │
│  class AuditorPatternCache {                                                 │
│    private cache = new Map<string, string[]>();                              │
│                                                                              │
│    resolve(pattern: string, candidates: string[]): string[] {                │
│      if (this.cache.has(pattern)) {                                          │
│        return this.cache.get(pattern)!;                                      │
│      }                                                                       │
│      const resolved = matchPattern(pattern, candidates);                     │
│      this.cache.set(pattern, resolved);                                      │
│      return resolved;                                                        │
│    }                                                                         │
│                                                                              │
│    clear(): void {                                                           │
│      this.cache.clear();                                                     │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  Usage in auditor:                                                           │
│  ─────────────────────                                                       │
│  async function runGoalCompletionAuditor(args) {                             │
│    const cache = new AuditorPatternCache();                                  │
│                                                                              │
│    try {                                                                     │
│      const tools = resolveAuditorTools(mainTools, config, cache);            │
│      const mcp = resolveAuditorMcp(mainMcp, config, cache);                  │
│      const skills = resolveAuditorSkills(mainSkills, config, cache);         │
│                                                                              │
│      // ... create session with resolved lists                               │
│    } finally {                                                               │
│      cache.clear();  // cleanup                                              │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  Performance:                                                                │
│  ────────────                                                                │
│  • First resolution: O(n * p) where n = candidates, p = patterns             │
│  • Subsequent calls: O(1) cache hit                                          │
│  • Memory: ~1KB per auditor session (negligible)                             │
│  • No persistence needed (in-memory only)                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Status at end of turn 3

- Wildcard matching designed: `*` (any chars), `?` (single char), exact match fallback
- Caching architecture designed: per-session `Map<string, string[]>`, lazy population, cleared on session end
- Configuration examples provided for both `inherit` and `minimal` modes with wildcards
- Resolution flow pseudocode provided
- Cache implementation notes with performance characteristics
- Explore complete — ready for change proposal
