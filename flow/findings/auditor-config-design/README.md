# Auditor Config Design

> Date range: 2026-07-03 → 2026-07-03
> Status: explore-ongoing (ready for proposal)

## Topics

### Auditor Configuration & Wildcard Matching (2026-07-03)
Explored current auditor architecture (hardcoded tools, no MCP/skills/extensions, no prompt config). Designed two auditor modes: `inherit` (default, opt-out) and `minimal` (opt-in). Designed three prompt modes: `global-local`, `local`, `global-local-merge`. Added wildcard matching (`*`, `?`) for tools/MCP/skills/extensions with per-session in-memory caching. All design decisions locked. Ready for change proposal.

## Pick up next time
1. Read `2026-07-03-locked-decisions.yaml` for all locked decisions (LD1-LD6)
2. Read `2026-07-03-turn2-design-decisions.md` for full architecture diagrams
3. Read `2026-07-03-turn3-wildcard-caching.md` for wildcard + caching design
4. Next step: Create change proposal for implementation
