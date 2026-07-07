## ADDED Requirements

### Requirement: Per-command pre/post hooks with append and override modes

The system SHALL allow registering per-command hooks for any built-in `/goal-*` slash command. Each command key supports `mode: "append"` (default) wrapping the built-in handler with optional pre and post functions, or `mode: "override"` replacing the built-in handler entirely.

#### Scenario: Append mode pre-hook transforms args

- **WHEN** `.pi/pi-goal-xx/hooks/goals.ts` exports `pre: (args, ctx) => ({transformArgs: args.replace("--team", "")})`
- **AND** `settings.commandHooks.goals.mode = "append"`
- **THEN** invoking `/goals feature --team` runs the pre-hook first, the built-in `handleGoalCommandTopic` receives `"feature"` as args, then the post-hook runs

#### Scenario: Override mode replaces built-in handler

- **WHEN** `.pi/pi-goal-xx/hooks/goal-abort.ts` exports `handler: (args, ctx) => { ctx.ui.notify("custom abort", "info"); }`
- **AND** `settings.commandHooks.goal-abort.mode = "override"`
- **THEN** invoking `/goal-abort` runs ONLY the user handler; the built-in abort logic does NOT execute

#### Scenario: Override mode can delegate to built-in

- **WHEN** an override-mode hook exports `handler: async (args, ctx, builtin) => { await ctx.ui.confirm(...); await builtin(args, ctx); }`
- **THEN** the hook receives the original built-in handler as a third argument and MAY call it conditionally

### Requirement: Hooks default off and require explicit enablement

The system SHALL NOT load or execute any command hooks unless `settings.commandHooks.enabled = true`. This is a safety gate because hooks execute user-supplied TypeScript in the extension context.

#### Scenario: Hooks configured but not enabled

- **WHEN** `.pi/pi-goal-xx/hooks/goals.ts` exists AND `settings.commandHooks.enabled` is unset or `false`
- **THEN** the goals handler runs without any hook wrapping
- **AND** no dynamic import of the hook file occurs

#### Scenario: Hooks enabled loads all configured hooks

- **WHEN** `settings.commandHooks.enabled = true`
- **AND** hooks exist for `goals` and `goal-focus` only
- **THEN** only those two commands get wrapped; other `/goal-*` commands run unwrapped

### Requirement: Hook loading and error isolation

The system SHALL load hooks via dynamic import at extension initialization. Hook load errors MUST be isolated: a failing import for one command MUST NOT crash the extension or prevent other commands from working.

#### Scenario: One hook file has a syntax error

- **WHEN** `settings.commandHooks.enabled = true`
- **AND** `.pi/pi-goal-xx/hooks/goals.ts` is malformed TypeScript
- **THEN** the goals command runs its built-in handler (no wrapping)
- **AND** the extension emits a `ui.notify` warning naming the failing hook file
- **AND** all other configured hooks still load and wrap their commands

### Requirement: Hook precedence global then local

When both global and local hooks exist for the same command, the system SHALL chain them in order: global pre → local pre → built-in → local post → global post.

#### Scenario: Both global and local append hooks exist

- **WHEN** `~/.pi/pi-goal-xx/hooks/goals.ts` exports `pre: G`
- **AND** `<cwd>/.pi/pi-goal-xx/hooks/goals.ts` exports `pre: L`
- **AND** mode is append
- **THEN** execution order is G → L → built-in → L-post → G-post

### Requirement: Override mode precedence

For override mode, local wins over global. The local handler replaces the built-in and the global handler is not invoked.

#### Scenario: Local override supersedes global override

- **WHEN** both global and local hooks for `goal-focus` are in override mode
- **THEN** only the local handler runs; the global override is silently ignored
