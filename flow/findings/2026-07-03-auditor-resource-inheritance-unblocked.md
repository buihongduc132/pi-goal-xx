# Auditor resource inheritance — false-premise blocker resolved

> Date: 2026-07-03
> Status: resolved
> Related: configurable-auditor change; PR #4 (`feat/auditor-inherit-cwd-resources`)
> Supersedes: the "Upstream-blocked items summary" previously at the bottom of `openspec/changes/configurable-auditor/tasks.md`

## Problem

Tasks 5.3, 5.4 (e2e), 5.5 (e2e), 6.7, 6.8 of the configurable-auditor change were
initially marked **blocked** on `@earendil-works/pi-coding-agent` exposing the
main session's `ResourceLoader`, MCP config, skills list, and extensions list to
extensions. The public `ExtensionAPI` only exposes `getActiveTools()`.

This was a **false premise**. The auditor does not need access to the main
session's loader.

## Investigation method

Two sub-agents (claude + pi) were delegated in parallel to read the installed
`@earendil-works/pi-coding-agent` dist directly. Both converged on the same
conclusion.

## Findings

### F1 — `createAgentSession({ cwd })` auto-discovers from cwd

`dist/core/sdk.js:83-99`:

```js
export async function createAgentSession(options = {}) {
    const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
    const agentDir = options.agentDir ?? getDefaultAgentDir();
    let resourceLoader = options.resourceLoader;
    ...
    const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
    ...
    if (!resourceLoader) {
        resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
        await resourceLoader.reload();
    }
}
```

When `resourceLoader` is omitted/undefined, pi builds a `DefaultResourceLoader`
bound to `cwd` and `.reload()`s it. This is the **same** path the real `pi`
binary uses — there is no special "host" code path. An omitted loader does NOT
mean "empty resources"; it means "full standard discovery".

### F2 — `DefaultResourceLoader` is exported and constructible

- `dist/index.d.ts:14` re-exports `DefaultResourceLoader` from `./core/resource-loader.js`.
- `dist/index.d.ts:1` re-exports `getAgentDir` from `./config.js`.
- Constructor: `new DefaultResourceLoader({ cwd, agentDir, settingsManager })`
  (`dist/core/resource-loader.d.ts:56-107`, optional `*Override` / `*Paths` /
  `no*` knobs available).

### F3 — What `DefaultResourceLoader.reload()` discovers from cwd

`DefaultResourceLoader.reload()` → `packageManager.resolve()`
(`dist/core/package-manager.js`), base dir `join(cwd, CONFIG_DIR_NAME)` =
`<cwd>/.pi` (`CONFIG_DIR_NAME` = `.pi`, `dist/config.js`):

| Resource | Discovered? | Evidence |
|---|---|---|
| `<cwd>/.pi/extensions/` (tools live here) | ✅ | `RESOURCE_TYPES` includes `extensions` |
| `<cwd>/.pi/skills/` | ✅ | `RESOURCE_TYPES` includes `skills` |
| `<cwd>/.pi/prompts/` | ✅ | `RESOURCE_TYPES` includes `prompts` |
| `<cwd>/.pi/themes/` | ✅ | `RESOURCE_TYPES` includes `themes` |
| `~/.pi/agent/{extensions,skills,...}/` (user) | ✅ | user scope |
| `~/.agents/skills/` (global) | ✅ | global scope |
| `<cwd>/AGENTS.md` / `CLAUDE.md` (context) | ✅ | `loadProjectContextFiles`, walks cwd → root |
| `<cwd>/.pi/SYSTEM.md` / `APPEND_SYSTEM.md` | ✅ | system prompt discovery |
| `.pi/settings.json` | ✅ | `SettingsManager.create(cwd, agentDir)` |

### F4 — MCP is NOT a pi-core concept

Grep across `dist/` (excluding vendor highlight.js) for
`mcp.json|McpServer|loadMcp|registerMcp` → **zero matches**. The npm SDK has no
MCP code. MCP is wired by the separate `pi-mcp-adapter` package (per
`flow/findings/pi-mcp-adapter-implementation.md` in the pi-plugins repo), which
registers as a normal extension. Therefore:

- `DefaultResourceLoader` does NOT load MCP directly.
- BUT it discovers the `pi-mcp-adapter` extension, which (once loaded by the
  ExtensionRunner) attaches MCP servers to the session.
- → An auditor that inherits extensions via `DefaultResourceLoader` inherits
  MCP servers automatically.

To strip MCP from the auditor, exclude the adapter:
`auditorExclude.extensions: ["pi-mcp-adapter*"]`.

## Decision / fix

Added `MainSessionResources.inheritFromCwd: boolean`:

- When `true` (production wiring in `goal.ts`), `runGoalCompletionAuditor`
  builds its own `DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager })`,
  awaits `.reload()`, and uses it as the resource source.
- Derives the skill / extension allow-lists from the loader's own
  `getSkills()` / `getExtensions()` discovery (when the caller didn't pass them
  explicitly), so `auditorExclude` / `auditorInclude` filters operate on the
  resources the auditor will actually see.
- Wraps the loader with the existing isolation proxy (`makeAuditorResourceLoader`)
  which overrides `getSystemPrompt` (auditor's read-only prompt) and
  `getAppendSystemPrompt` (returns `[]` → executor's APPEND_SYSTEM.md does NOT
  leak). This is critical: a bare omitted `resourceLoader` WOULD inherit the
  executor's append prompts, breaking isolation.

Tests keep the legacy empty-loader path by omitting `inheritFromCwd`.

## Why not just omit `resourceLoader` from `createAgentSession`?

That was the alternative. Rejected because:

1. The current code passes a custom `resourceLoader` to enforce isolation
   (custom system prompt + no append-prompt leakage). Omitting it would inherit
   the executor's `APPEND_SYSTEM.md`, polluting the auditor's prompt.
2. We still need to apply `auditorExclude` / `auditorInclude` filters, which
   requires a wrapper around the discovered resources.
3. Building `DefaultResourceLoader` ourselves + wrapping it gives full control
   over both isolation and filtering, with identical discovery results.

## Verification

- `npm test`: 654 pass, 0 fail, exits in 1.5s.
- `npm run check`: tsc clean.
- @verifier (claude sub-agent) APPROVED with file:line evidence on all 5 intent
  points (construction shape, isolation, filterability, allow-list derivation,
  no legacy regression). Traced isolation + filter claims into pi-coding-agent
  internals (`agent-session.js:661-663` sources prompt from
  `resourceLoader.getSystemPrompt()`; `runner.js:118,215-266` derives active
  tools from the filtered `this.extensions` array, not from `runtime`).
- Final @verifier APPROVED FOR MERGE.
- Gemini-code-assist review: 2 medium findings (optional chaining on loader
  returns, tmp-dir cleanup in tests) — both applied in `ed09b7a`. Gemini then
  re-anchored the same findings to the new SHA (stale pattern); replied on the
  PR documenting they were already fixed.

## Lesson

**Verify the premise of "blocked on upstream" before accepting it.** The
original tasks.md marked 5 tasks as blocked on an extension-API gap. A 5-minute
read of the installed package's `dist/` showed the auditor could inherit
everything by constructing its own loader from the same cwd — no upstream
change needed.

When you find yourself saying "blocked on upstream API", check whether the
upstream already provides a *factory* (e.g. `DefaultResourceLoader`) that lets
you build the missing object yourself from the inputs you DO have.
