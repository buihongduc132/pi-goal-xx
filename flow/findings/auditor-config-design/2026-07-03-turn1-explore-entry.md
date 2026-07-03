# Explore Turn 1 — Explore Entry: Auditor Architecture

> Date: 2026-07-03
> Phase: Initial exploration
> Status: Completed

---

## [user]

> **[user]** (verbatim — trust chain L1)
> 
> Enter explore mode. Think deeply. Visualize freely. Follow the conversation wherever it goes.
> 
> **IMPORTANT: Explore mode is for thinking, not implementing.** You may read files, search code, and investigate the codebase, but you must NEVER write code or implement features. If the user asks you to implement something, remind them to exit explore mode first and create a change proposal. You MAY create OpenSpec artifacts (proposals, designs, specs) if the user asks—that's capturing thinking, not implementing.
> 
> [Full explore mode instructions omitted for brevity — see skill file]
> 
> **Provided arguments**: how about skill , how about the cwd of the auditor , where is it launched ?

---

## [assistant]

Read `extensions/goal-auditor.ts` to understand current auditor architecture.

### Current Auditor Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CURRENT AUDITOR                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  createAgentSession({                                                │
│    cwd: args.ctx.cwd,              ← same as main session           │
│    model: config.model,            ← configurable ✓                 │
│    thinkingLevel: config.thinkingLevel,  ← configurable ✓           │
│                                                                       │
│    resourceLoader: {                                                  │
│      getExtensions: () => [],       ← EMPTY ❌                      │
│      getSkills: () => [],           ← EMPTY ❌                      │
│      getPrompts: () => [],          ← EMPTY ❌                      │
│      getThemes: () => [],           ← EMPTY ❌                      │
│      getAgentsFiles: () => [],      ← EMPTY ❌                      │
│      getSystemPrompt: () => "...hardcoded..."  ← HARDCODED ❌       │
│    },                                                                 │
│                                                                       │
│    sessionManager: InMemory,        ← no persistence                │
│    settingsManager: InMemory,       ← no MCP config ❌              │
│                                                                       │
│    tools: ["read","grep","find","ls","bash","report_auditor_progress"]│
│           ↑ HARDCODED LIMITED ❌                                     │
│                                                                       │
│    customTools: [reportProgressTool]                                  │
│  })                                                                   │
│                                                                       │
│  Prompt: buildGoalAuditorPrompt()  ← HARDCODED ❌                   │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### What's configurable vs hardcoded

| Aspect | Configurable? | Location |
|--------|--------------|----------|
| Model | ✅ Yes | `settings.model` |
| Provider | ✅ Yes | `settings.provider` |
| Thinking level | ✅ Yes | `settings.thinkingLevel` |
| **Prompt** | ❌ Hardcoded | `buildGoalAuditorPrompt()` |
| **System prompt** | ❌ Hardcoded | `makeAuditorResourceLoader().getSystemPrompt()` |
| **Tools** | ❌ Hardcoded | Line 325: `["read","grep","find","ls","bash",...]` |
| **MCP servers** | ❌ Not passed | `settingsManager: InMemory` (no MCP config) |
| **Skills** | ❌ Empty | `getSkills: () => []` |
| **Extensions** | ❌ Empty | `getExtensions: () => []` |
| **Subagents/ACP** | ❌ Not available | No tools, no config |
| **cwd** | ❌ Same as main | `args.ctx.cwd` |

### Design Options Visualized

```
┌─────────────────────────────────────────────────────────────────────┐
│                     WHAT SHOULD AUDITOR BE?                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Option A: Read-only verifier (current)                              │
│  ─────────────────────────────────────                               │
│  • Only reads files, runs safe bash commands                         │
│  • No MCP, no skills, no extensions                                  │
│  • Fast, isolated, predictable                                       │
│  • Cannot verify things that require MCP (databases, APIs, etc.)     │
│                                                                       │
│  Option B: Full-featured verifier                                    │
│  ─────────────────────────────────                                   │
│  • All tools from main session                                       │
│  • MCP servers (can query databases, APIs, external services)        │
│  • Skills (can use project-specific knowledge)                       │
│  • Subagents (can delegate sub-tasks)                                │
│  • Slower, more expensive, less isolated                             │
│  • Can verify anything the main agent can verify                     │
│                                                                       │
│  Option C: Configurable spectrum                                     │
│  ────────────────────────────────                                    │
│  • Default: read-only (safe)                                         │
│  • Opt-in: "full" mode with all tools/MCP/skills                     │
│  • Per-goal override: some goals need MCP, some don't                │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Questions posed to user

1. Should auditor inherit the main session's MCP config?
2. Should auditor have a "full tools" opt-in?
3. Should auditor cwd be configurable?
4. Should custom prompt be per-project or global?
5. Should auditor be able to use the same extensions as main?

---

## Status at end of turn 1

- Auditor architecture fully mapped
- All hardcoded vs configurable aspects identified
- Three design options presented (A/B/C)
- Five questions posed to user for design decisions
- Next: User provides design decisions
