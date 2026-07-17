# Bug — `auditorTimeoutMs` global settings drift (settings file silently ignored)

- **Date:** 2026-07-17
- **Severity:** High (auditor times out at 15min default on heavy reasoning tasks → false failures / `complete_goal` rejected)
- **Status:** Diagnosed; fix pending
- **Affects:** pi-goal-xx (settings loaded only from `<cwd>/.pi/`, never from global `~/.pi/`)

## Symptom

User configures `.pi/pi-goal-xx-settings.json`:

```json
{ "auditorTimeoutMs": 3600000 }
```

The file exists at `~/.pi/pi-goal-xx-settings.json` (global pi config home, the dir above `~/.pi/agent/`). But the goal system applies the **default 900000ms (15min)**, not the configured 3600000ms (1h). On heavy reasoning auditor tasks (e.g. role-smart, 60s/turn over many turns), the auditor hits the 15min ceiling and times out.

## Root Cause

`extensions/goal-settings.ts:goalSettingsPath(cwd, env)` resolves settings to **exactly one path**:

```ts
return path.join(cwd, ".pi", "pi-goal-xx-settings.json");
```

It only ever checks `<cwd>/.pi/pi-goal-xx-settings.json` (project-local). There is **no global fallback**. The user's file at `~/.pi/pi-goal-xx-settings.json` is read ONLY when pi happens to run with `cwd === $HOME` — which is never the case for real project work (cwd is the project dir).

### Failure chain

```
pi spawns in /home/bhd/Documents/Projects/bhd/<proj>
  → ctx.cwd = <proj>
  → loadGoalSettings(ctx.cwd)
      → loadGoalSettingsFileConfig(ctx.cwd)
          → goalSettingsPath(ctx.cwd) = <proj>/.pi/pi-goal-xx-settings.json   ← DOES NOT EXIST
          → fs.existsSync(...) === false → return {} (defaults)
      → config.auditorTimeoutMs === undefined
      → effectiveTimeoutMs = DEFAULT_AUDITOR_TIMEOUT_MS = 900000 (15min)
  → auditor runs with 15min ceiling → times out on heavy reasoning
```

The `~/.pi/pi-goal-xx-settings.json` file the user edited is never consulted.

## Evidence

- `extensions/goal-settings.ts:343-351` — `goalSettingsPath` joins `cwd + ".pi" + "pi-goal-xx-settings.json"` only.
- `extensions/goal-settings.ts:483-491` — `loadGoalSettingsFileConfig` returns `{}` when `fs.existsSync(configPath)` is false.
- Disk: `~/.pi/pi-goal-xx-settings.json` exists with `auditorTimeoutMs: 3600000` (verified). Project-local `.pi/pi-goal-xx-settings.json` does NOT exist (verified). User expects the global file to apply.
- `extensions/goal-auditor.ts:715-741` — `const timeoutMs = config.auditorTimeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS;` falls to 900000 when config is empty.

## Fix

Add a **global settings file** as the base layer, with project-local overlay:

1. Resolve global path: `dirname(<pi agent dir>) + "/pi-goal-xx-settings.json"` where pi agent dir = `PI_CODING_AGENT_DIR` env (default `~/.pi/agent`). Global = `~/.pi/pi-goal-xx-settings.json`.
2. Load order: **global → project-local → env** (each layer wins per-key).
3. Merge at the parsed `GoalSettings` level (shallow overlay; arrays/objects replaced, not deep-merged — matches existing `?? fileConfig.x` semantics).
4. `loadGoalSettingsFileConfig(cwd, env)` returns the merged file config (global ⊕ local).
5. New export `globalGoalSettingsPath(env)` for tests + `/goal-settings` display.

### Precedence (env > project-local > global > defaults)

| Setting source | auditorTimeoutMs resolution |
| --- | --- |
| `PI_GOAL_AUDITOR_TIMEOUT_MS` env | wins (existing) |
| `<cwd>/.pi/pi-goal-xx-settings.json` (project-local) | overrides global |
| `~/.pi/pi-goal-xx-settings.json` (global) | base layer |
| `DEFAULT_AUDITOR_TIMEOUT_MS` (900000) | last resort |

## Why this prevents drift

The previous design forced every project to carry its own copy of the settings file. After any deploy or `git clean`, project-local files vanish → drift. With a global base layer, the user's `~/.pi/pi-goal-xx-settings.json` survives project switches, deploys, and fresh clones, so the auditor timeout (and any other global setting) stays consistent without per-project duplication.

## Regression guard

New test `tests/auditor-global-settings.test.ts` must assert:
- R1: global file loaded when project-local absent → `auditorTimeoutMs` from global.
- R2: project-local overrides global per-key.
- R3: env overrides both.
- R4: global file absent → existing behavior unchanged (defaults).
- R5: malformed global file does NOT crash (existing silent-swallow semantics preserved).
- R6: `globalGoalSettingsPath` resolves via `PI_CODING_AGENT_DIR` and falls back to `~/.pi/agent` parent.

## Verification contract

- All existing `tests/auditor-env-config.test.ts` + `tests/goal-auditor-crash-safe.test.ts` keep passing.
- New `tests/auditor-global-settings.test.ts` passes (R1–R6).
- `npm test` (full suite) green.
