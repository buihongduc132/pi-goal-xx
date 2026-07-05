# Command hooks

Per-command **pre/post/override** hooks for every built-in `/goal-*` slash command. Lets you wrap or replace command behavior with user-supplied TypeScript — e.g. inject a team-delegation prompt before `/goals`, log after `/goal-abort`, or fully replace `/goal-clear` with custom archival logic.

## ⚠️ Security warning

**Hooks execute user-supplied TypeScript with full extension privileges.** A hook file can read/write any file, spawn child processes, and make network calls. **Audit every hook file before enabling hooks.** This is why hooks are **off by default** and gated behind an explicit `enabled: true`.

## Enable

```jsonc
{
  "commandHooks": {
    "enabled": true,
    "goals": { "mode": "append" },
    "goal-abort": { "mode": "override" }
  },
  "hooksDir": ".pi/pi-goal-xx/hooks/"
}
```

`commandHooks.enabled` MUST be `true` for any hook to load. When false (or absent), all `/goal-*` commands run their built-in handlers unwrapped — zero behavior change.

## Hook file

Create `.pi/pi-goal-xx/hooks/<command>.ts` (local) or `~/.pi/pi-goal-xx/hooks/<command>.ts` (global). Local wins over global. File extension: `.ts` only (Node strips types via `--experimental-strip-types`, the same loader the extension runtime uses).

```typescript
// .pi/pi-goal-xx/hooks/goals.ts
export const pre = async (args: string, ctx: unknown) => {
  console.log(`[hook] /goals invoked with: ${args}`);
  return { transformArgs: args.replace("--team", "").trim() };
};

export const post = async (args: string, ctx: unknown, result: unknown) => {
  console.log(`[hook] /goals completed`);
};

// Override mode only:
export const handler = async (args: string, ctx: unknown, builtin: (args: string, ctx: unknown) => unknown) => {
  // Custom logic here. Optionally delegate to the built-in:
  await builtin(args, ctx);
};
```

## Modes

### `append` (default)

Wraps the built-in handler:

```
pre  →  builtin(transformedArgs)  →  post
```

- `pre` may return `{ transformArgs: string }` to rewrite the args the builtin receives.
- `pre`/`post` errors are **isolated**: a throwing pre-hook falls back to the original args + a `ui.notify` warning; a throwing post-hook logs a warning but the builtin result is preserved.

### `override`

Replaces the built-in handler entirely:

```
hook.handler(args, ctx, builtin)
```

- The built-in handler is passed as the **3rd argument** so the hook MAY delegate to it conditionally.
- Override-handler errors **propagate** (the user opted into full control).
- When both global and local hooks exist in override mode, **local wins**; the global override is silently ignored.

## Precedence (both global + local present, append mode)

```
global-pre  →  local-pre  →  builtin  →  local-post  →  global-post
```

## Error isolation

A malformed hook file (syntax error, missing export, thrown import) does **not** crash the extension:

- The dynamic import is wrapped in try/catch.
- On failure, the built-in handler runs unwrapped.
- A `ui.notify` warning names the failing hook file.
- All other configured hooks continue to load and wrap their commands.

## Commands covered

All 14 `/goal-*` commands: `goal`, `goal-status`, `goal-list`, `goal-focus`, `goal-settings`, `goals`, `sisyphus`, `goals-set`, `sisyphus-set`, `goal-tweak`, `goal-clear`, `goal-abort`, `goal-pause`, `goal-resume`.

## `/reload` requirement

Hooks load once at extension init (lazy on first invocation, then cached). Editing a hook file requires `/reload` to pick up the change.
