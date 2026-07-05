## Context

pi-goal-xx has 7 runtime prompt builders + tool prompt fields + 12 `/goal-*` slash commands, all hardcoded. The single configurable surface is the auditor prompt (`extensions/auditor-prompt.ts`, ~114 LOC, 3-source resolution). Users asked for override + append on every prompt, on commands (C2), and reusable contract templates.

Constraints:
- No new pi-core API. Everything inside this extension.
- `auditor-prompt.ts` already shipped + tested → proven pattern to generalize.
- Settings round-trip must preserve `additionalProperties: false` (existing invariant).
- Command hooks execute user-supplied TS → security concern → default off.

Stakeholders: end users configuring prompts/hooks/templates; the auditor subsystem (must keep working unchanged externally).

## Goals / Non-Goals

**Goals:**
- Single resolution primitive covers all 7 runtime prompts + auditor + tool fields.
- Override + append + 3 legacy modes available uniformly.
- Per-command pre/post hooks with append + override modes, default off.
- Contract `{{snippet}}` templating expanded at write time.
- Backward compatible: legacy `auditorPrompt*` keys keep working.
- Supersede the queued `goal-custom-prompt` change.

**Non-Goals:**
- Lazy / per-turn tool prompt resolution. Tool prompts resolve at extension load (require `/reload` to pick up file changes). Push to follow-up.
- Hook hot-reload. Hooks load once at init. Editing a hook requires `/reload`.
- Per-goal prompt overrides (`<goalId>.md` files). Power but complexity; deferred.
- Template conditionals (`{{#if}}`). `{{name}}` interpolation only.
- pi-core `replaceCommand` API. Not needed — extension self-wraps at registration.
- A GUI editor for these settings. `/goal-settings` menu additions only.

## Decisions

### D1: One resolver module, three modes, shared shape

Generalize `auditor-prompt.ts` into `prompt-resolver.ts`. Public API:

```typescript
type PromptMode = "override" | "append" | "global-local" | "local" | "global-local-merge" | "off";
interface PromptConfig { mode?: PromptMode; inline?: string; }
interface ResolvedPrompt { body: string; source: "inline" | "global" | "local" | "merged" | "none"; }
function resolvePrompt(key: string, cfg: PromptConfig | undefined, cwd: string, hardcodedDefault: string): { final: string; injected?: string };
```

`final` = mode `override` → `cfg.inline ?? file-body` : `hardcodedDefault + (resolved ? "\n\n" + resolved : "")`.

Caller (each prompt fn) does:
```typescript
const { final } = resolvePrompt("goal-running", settings?.prompts?.["goal-running"], cwd, hardcodedBody);
return final;
```

**Why one module**: 3 surfaces (runtime prompts, auditor, tool prompts) share identical resolution semantics. Code dedup. Tests dedup. Single mental model in docs.

**Alternatives considered**:
- Per-surface resolver: rejected — 3x code, drift risk.
- Settings-only (no file channels): rejected — long prompts in JSON are unreadable.

### D2: Override mode added on top of existing 3

Legacy modes (`global-local`, `local`, `global-local-merge`) are append-style: they prepend the hardcoded body. New `override` mode replaces it entirely. Default remains `global-local` (append) → backward compatible.

`off` mode added as explicit "do not inject even if files exist" — useful for tool prompts where injection is unwanted.

### D3: Tool prompts resolve at load via defineTool wrapper

Tool `promptSnippet` and `promptGuidelines` are static at registration. Two options:
- (A) Wrap `defineTool` to merge resolver output at registration time.
- (B) Lazy resolution via `before_agent_start` event hook rewriting system prompt.

Pick A. Simpler, no per-turn overhead. Trade-off: requires `/reload` after editing tool prompt files. Documented in non-goals.

### D4: Command hooks via registration-time wrapping

At extension init, after all `pi.registerCommand` calls, walk the registered commands. For each matching `settings.commandHooks[cmd]`, wrap the handler with a dispatcher that loads the user hook file via dynamic `import()`.

```typescript
function wrapHandler(name: string, original: CommandHandler, settings, cwd): CommandHandler {
  if (!settings.commandHooks?.enabled) return original;
  const cfg = settings.commandHooks[name];
  if (!cfg) return original;
  return async (args, ctx) => {
    const hook = await loadHook(name, cwd);  // dynamic import, error-isolated
    if (cfg.mode === "override" && hook?.handler) {
      return hook.handler(args, ctx, original);
    }
    const pre = cfg.mode === "append" ? await hook?.pre?.(args, ctx) : undefined;
    const finalArgs = pre?.transformArgs ?? args;
    await original(finalArgs, ctx);
    if (cfg.mode === "append" && hook?.post) await hook.post(args, ctx, undefined);
  };
}
```

Hook signature (user-supplied `.ts`):
```typescript
export const pre?: (args: string, ctx: ExtensionContext) => Promise<{transformArgs?: string} | void>;
export const post?: (args: string, ctx: ExtensionContext, result: unknown) => Promise<void>;
export const handler?: (args: string, ctx: ExtensionContext, builtin: CommandHandler) => Promise<void>;
```

**Why no pi-core API**: `pi.registerCommand` is a one-shot call; wrapping the returned handler at registration time is sufficient. Future pi-core `wrapCommand` would be cleaner but is out of scope.

**Alternatives**:
- Pre-registration override via settings map only (no TS files): rejected — users wanted real logic.
- Event-based hooks (`tool_call`-style): rejected — slash commands don't emit tool_call events.

### D5: Hooks default off, gated by `commandHooks.enabled`

User TS in extension context = arbitrary file I/O, network, child_process. Must be opt-in. Two gates:
1. `settings.commandHooks.enabled: true` (explicit)
2. Dynamic import wrapped in try/catch + `ui.notify` on failure (one bad hook doesn't crash the rest)

Document footgun in README: "Hooks run with full extension privileges. Audit hook files before enabling."

### D6: Contract templating expands at write time

`extractVerificationContract()` in `goal-draft.ts` calls a new `expandContractTemplates(contract, cwd, settings)` before returning. Expanded form persisted in goal file.

**Why write-time**: Goal files must be self-contained (auditor reads them, files may be archived/moved). Runtime expansion would couple goal correctness to FS state at audit time.

Snippet resolution: local wins per name. Missing snippet → placeholder preserved + warning.

### D7: Settings schema extension via three new top-level blocks

```jsonc
{
  "prompts": { "<key>": { "mode": "...", "inline": "..." } },
  "promptsDir": ".pi/pi-goal-xx/prompts/",
  "commandHooks": { "enabled": false, "<cmd>": { "mode": "append", "preInline": "...", "postInline": "..." } },
  "hooksDir": ".pi/pi-goal-xx/hooks/",
  "contractTemplates": true,
  "contractsDir": ".pi/pi-goal-xx/contracts/"
}
```

All optional. Existing keys untouched. Legacy `auditorPrompt` / `auditorPromptMode` mapped during parse to `prompts.auditor.*` (silent alias).

### D8: Migration path for auditor

`auditor-prompt.ts` keeps its public API. Internally delegates to `prompt-resolver.ts`. Existing tests for auditor prompt behavior continue to pass. The `auditorPrompt`/`auditorPromptMode` settings keys keep working via the alias map (D7).

### D9: Goal-data injection MUST always happen (BUG-1 fix)

**Latent bug.** The current `loadAuditorPrompt` treats the file prompt as the **entire** prompt — the hardcoded `defaultPrompt` (= `buildGoalAuditorPrompt()`, which carries `<objective>`, `<completion_summary>`, `<verification_summary>`, `<verification_contract>`, the audit checklist, and the `<approved/>` / `<disapproved/>` verdict instruction) is only a **fallback** when NO file exists. Once any `.pi/auditor-prompt.md` is present, the file **replaces** the structured goal-data prompt entirely → the auditor model receives policy/persona text but zero goal data → it asks the user to provide a goal ID.

**Evidence.** Reproduced on pi-plugins (goal `mr72qw1x-za6kc9`, 2026-07-05): trace `auditor-trace.jsonl` shows `promptBytes=4154` (the file size only), prompt preview starts with `# Goal Auditor — Strict Verification & Anti-False-Block Policy` (the file), NOT with `You are the independent completion auditor for pi-goal.` (the code default). The model's verdict was a request for the goal ID (`Could you provide the goal ID or file path...`). The hardcoded `buildGoalAuditorPrompt` was never reached.

**Rule.** No resolution mode, file, or inline override may suppress the goal-data block. The file/inline prompt is the **persona/policy** layer; the goal-data block is the **fact** layer. The resolver MUST always concatenate both: `final = <resolved persona/policy block> + "\n\n" + <goal-data block>`. Override mode replaces the persona/policy layer only — never the fact layer. This invariant applies to every prompt that carries runtime fact data (auditor today; tool prompts later are persona-only and exempt).

**Migration consequence.** The auditor migration step (D8) is no longer a pure refactor — it MUST change behavior so that an existing `.pi/auditor-prompt.md` file stops killing goal-data injection. The pre-migration behavior is the bug; the post-migration behavior is the fix. Any test asserting "file replaces default entirely" is asserting the bug and MUST be inverted.

## Risks / Trade-offs

- **[User TS in hooks runs with full extension privileges]** → Mitigation: default off, documented footgun, error isolation per hook, future addition of allowlist.
- **[Tool prompt changes require `/reload`]** → Mitigation: documented in non-goals. Lazy resolution deferred to follow-up change.
- **[Override mode silently replaces hardcoded safety prompts]** → Mitigation: `mode: "override"` is explicit; the resolver logs a `ui.notify` info on first override per session. User owns the choice.
- **[BUG-1 — File prompt kills goal-data injection (auditor)]** → Current `loadAuditorPrompt` treats the file as the entire prompt and drops `buildGoalAuditorPrompt`'s `<objective>` / `<completion_summary>` / `<verification_summary>` / `<verification_contract>` blocks whenever a file exists. The auditor then sees persona-only text and cannot identify the goal. Mitigation: D9 mandates that goal-data injection always happens regardless of mode; the migration step for auditor MUST fix this before any other unified-resolver work is safe. Until then, any project with `.pi/auditor-prompt.md` is in the broken state.
- **[Template syntax `{{name}}` collides with mustache / other templating]** → Mitigation: only expanded inside `verificationContract` field, not anywhere else. Documented scope.
- **[Legacy alias silently keeps `auditorPrompt` working]** → Mitigation: documented in migration notes; future deprecation cycle if removed.
- **[Settings schema bloat]** → Mitigation: 3 new top-level blocks, each well-bounded. `additionalProperties: false` preserved.
- **[Resolver called on every prompt build → perf]** → Mitigation: resolver does at most 2 file reads per call; cache file contents in-memory keyed by mtime. Negligible.

## Migration Plan

1. Land `prompt-resolver.ts` + migrate `auditor-prompt.ts` to use it. Auditor behavior unchanged (existing tests prove it).
2. Wire resolver into 6 remaining runtime prompt fns. No new settings surface yet — files at default paths just work.
3. Add `prompts` block to settings schema + parse/save round-trip.
4. Add tool-prompt wrapping (defineTool wrapper).
5. Add `command-hook-loader.ts` + `commandHooks` settings (default off).
6. Add `contract-templating.ts` + `contractTemplates`/`contractsDir` settings.
7. Update README + `docs/` with all new keys, paths, modes, hook safety model.
8. Close `goal-custom-prompt` change as superseded.

**Rollback**: each step is independently revertible. Removing the new modules + settings keys restores prior behavior (legacy `auditorPrompt*` keys still work since they're parsed at root regardless).

## Open Questions

1. **Hook inline pre/post strings in settings** — should `preInline` / `postInline` be evaluated as JS, or treated as prompt-only text appended after the command runs? Leaning prompt-only (safer, no eval). Confirm before implementing.
2. **Tool prompt override granularity** — per-tool (`prompts.tool-create-goal`) or one global tool prompt block? Leaning per-tool to match the key-per-prompt pattern. Confirm.
3. **Should override mode emit a startup warning** the first time per session, or stay silent? Leaning silent (user opted in explicitly).
4. **Snippet file extension** — `.md` only, or also `.txt`? Leaning `.md` for editor highlighting.
5. **Hook file extension** — `.ts` only (requires TS loader) or also `.js`? Leaning `.ts` to match extension ecosystem; runtime strips types via Node's `--experimental-strip-types` (already used by tests).
