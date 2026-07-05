# Contract templates

`{{snippet-name}}` expansion in **verification contracts** at goal-create and goal-tweak time. Compose reusable contract clauses (verifier-loop requirement, e2e gate, security checklist) without copy-pasting.

## How it works

When you write a goal objective containing a `Verification contract:` section with `{{snippet}}` placeholders, pi-goal-xx expands them **at write time** (goal creation or `/goal-tweak`) and persists the expanded form in the goal file.

```
Verification contract: {{verifier-loop}} + {{e2e-required}}
```

becomes (stored in `active_goal_*.md`):

```
Verification contract: Run verifier-loop and require <approved/> before complete_goal + All e2e tests must pass
```

## Snippet files

Default directory: `.pi/pi-goal-xx/contracts/`

- Global: `~/.pi/pi-goal-xx/contracts/<name>.md`
- Local: `<cwd>/.pi/pi-goal-xx/contracts/<name>.md` — **local wins** per name.

Override the directory via `settings.contractsDir`.

File extension: `.md` only.

Snippet name charset: letters, digits, hyphens, underscores. `{{verifier-loop}}`, `{{e2e_required}}`, `{{check3}}` are valid.

## Compose patterns

**Single snippet:**

```
Verification contract: {{verifier-loop}}
```

**Multiple snippets composed:**

```
Verification contract: {{verifier-loop}} + {{e2e-required}} + {{security-checklist}}
```

**Adjacent (no separator):**

```
Verification contract: {{preamble}}{{verifier-loop}}
```

## Missing snippets

If `{{does-not-exist}}` has no matching file:

- The literal `{{does-not-exist}}` is **preserved** in the stored contract.
- A `ui.notify` warning names the missing snippet.

## Write-time only

Expansion happens **only** at goal-create and goal-tweak. The expanded form is persisted. Runtime reads (continuation prompts, auditor) do **not** re-expand — the goal file is self-contained at audit time.

Editing a snippet file after a goal was created does **not** retroactively update that goal. Only new goals (or `/goal-tweak` invocations) pick up the new snippet content.

## Disable

```jsonc
{ "contractTemplates": false }
```

Or via env: `PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true`

When disabled, placeholders are left literal and no warnings are emitted.

## Settings

```jsonc
{
  "contractTemplates": true,  // default true
  "contractsDir": ".pi/pi-goal-xx/contracts/"
}
```

`PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true` env var overrides the settings file (forces false).
