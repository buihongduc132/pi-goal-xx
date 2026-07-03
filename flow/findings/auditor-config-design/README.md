# Auditor Config Design

> Date range: 2026-07-03 → 2026-07-03
> Status: closed (implemented, PRs #3 + #4 merged)

## Topics

### Auditor Configuration & Wildcard Matching (2026-07-03)
Explored current auditor architecture (hardcoded tools, no MCP/skills/extensions, no prompt config). Designed two auditor modes: `inherit` (default, opt-out) and `minimal` (opt-in). Designed three prompt modes: `global-local`, `local`, `global-local-merge`. Added wildcard matching (`*`, `?`) for tools/MCP/skills/extensions with per-session in-memory caching. All design decisions locked. Implemented in PR #3.

### Resource inheritance mechanism (2026-07-03, follow-up)
The initial implementation (PR #3) wired tool inheritance but left skills/MCP/extensions inheritance marked blocked on an upstream API gap. A follow-up investigation (`../2026-07-03-auditor-resource-inheritance-unblocked.md`) showed the blocker was a false premise: `createAgentSession({cwd})` auto-builds a `DefaultResourceLoader` from cwd, so the auditor constructs its own loader from the same cwd to inherit identical resources. Implemented in PR #4. All 45 tasks resolved.

## Pick up next time
1. Read `../2026-07-03-auditor-resource-inheritance-unblocked.md` for the inheritance-mechanism post-mortem.
2. Read `2026-07-03-locked-decisions.yaml` for all locked decisions (LD1-LD6).
3. Read `2026-07-03-turn2-design-decisions.md` for full architecture diagrams.
4. Read `2026-07-03-turn3-wildcard-caching.md` for wildcard + caching design.
