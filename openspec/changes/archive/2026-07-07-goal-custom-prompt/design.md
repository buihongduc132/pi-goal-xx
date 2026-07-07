## Context

`pi-goal-xx` ships two prompt surfaces that drive the active goal agent:

1. `goalPrompt()` (`extensions/prompts/goal-prompts.ts`) — injected at `agent_start` via `extensions/goal.ts:4076`.
2. `continuationPrompt()` (same file) — injected at every checkpoint resumption via `extensions/goal.ts:1540`.

Both are hardcoded inline. The sibling **auditor** prompt already has a clean override channel: `auditor-prompt.ts` resolves an inline `settings.auditorPrompt`, a global `~/.pi/auditor-prompt.md`, or a local `<cwd>/.pi/auditor-prompt.md`, with three merge modes (`global-local`, `local`, `global-local-merge`). Users have asked for the same power over the goal agent itself — most commonly to inject project-specific execution rules (delegation policy, TDD discipline, blocker handling, verifier-loop requirement).

Constraints:
- `additionalProperties: false` on settings — unknown keys rejected at parse time.
- Settings must round-trip through `saveGoalSettingsFileConfig()`.
- The Sisyphus discipline block (when present) must remain visible; custom prompt is supplemental.
- No new runtime deps; TS only; pure functions for testability.
- Existing tests in `tests/goal-prompts.test.ts` and `tests/goal-settings.test.ts` must still pass.

## Goals / Non-Goals

**Goals:**
- Provide an inline + file-based override channel for the runtime goal/continuation prompts, symmetric with the auditor prompt.
- Zero behavior change when nothing is configured (no injection noise).
- Resolver is a pure, unit-testable function — no I/O coupling to the prompt builders.
- Round-trip-safe settings keys (`goalPrompt`, `goalPromptMode`).

**Non-Goals:**
- Customizing the `/goal` and `/sisyphus` **drafting** instructions — those live in pi-core's `propose_goal_draft` tool schema and are out of this package's reach.
- Customizing the `goalTweakDraftingPrompt()` (tweak interview) — out of scope for this change.
- Customizing the **paused-goal** or **stale-goal** system prompts — out of scope.
- Multi-file / glob prompt loading — single global + single local only, matching auditor.
- Prompt templating / variable substitution — plain text only.
- Loading prompts from arbitrary env-var paths beyond `PI_GOAL_SETTINGS_FILE` (which already swaps the *settings* file, not the prompt file).

## Decisions

### D1: Mirror `auditor-prompt.ts` exactly (new module `goal-prompt-resolver.ts`)
**Choice:** A new pure module reusing the auditor's resolution algorithm verbatim.
**Rationale:** Identical semantics → users only learn one mental model. Pure functions → trivially unit-testable. Keeps the prompt builders free of fs/path imports.
**Alternatives considered:**
- *Extend `auditor-prompt.ts` with a "kind" param.* Rejected: couples two unrelated prompt surfaces; harder to evolve independently.
- *Inline resolution inside `goalPrompt()`.* Rejected: forces fs I/O into a builder that is currently pure; breaks existing unit tests that don't pass a real cwd.

### D2: Reuse the `AuditorPromptMode` type alias as `GoalPromptMode`
**Choice:** `export type GoalPromptMode = AuditorPromptMode;` (no new enum).
**Rationale:** Same three literal values, same meaning. Avoids drift. Reuses `asAuditorPromptMode()` parser in `goal-settings.ts`.
**Alternatives considered:**
- *New enum.* Rejected: pure ceremony, two validators to keep in sync.

### D3: Custom block wraps content in tagged markers
**Choice:** Resolved text is wrapped as:
```
[PI GOAL CUSTOM PROMPT source=<inline|local|global|merged>]
<goal_custom_prompt>
...user text...
</goal_custom_prompt>
```
**Rationale:** Matches the existing `[PI GOAL ACTIVE]` / `[SISYPHUS STYLE]` marker convention. `source=` aids debugging. XML-like tags help the model treat user text as data, not instructions-of-higher-priority (same reason `untrustedObjectiveBlock` uses `<untrusted_objective>`).
**Alternatives considered:**
- *Raw append, no wrapper.* Rejected: harder to debug; harder for the model to scope.

### D4: Append AFTER the Sisyphus discipline block
**Choice:** Custom block is the last element of both `goalPrompt()` and `continuationPrompt()`.
**Rationale:** Sisyphus discipline is structural (lifecycle rules); user custom rules are tactical (per-project). Structural first, tactical last matches how the existing prompt already layers task-workflow → completion-audit → evolution.
**Alternatives considered:**
- *Before Sisyphus.* Rejected: risks the model treating user rules as overriding Sisyphus lifecycle.

### D5: `cwd` passed as optional 3rd param to `goalPrompt()` / `continuationPrompt()`
**Choice:** Signature `goalPrompt(goal, settings?, cwd?)` — when `cwd` is undefined, no custom block is injected.
**Rationale:** Backward-compatible with existing call sites and unit tests that don't supply `cwd`. Only the two real call sites in `goal.ts` pass `ctx.cwd`.
**Alternatives considered:**
- *Required param.* Rejected: breaks ~20 existing unit tests; forces fixture cwds everywhere.

### D6: No separate env-var override (no `PI_GOAL_PROMPT_FILE`)
**Choice:** File path is fixed at `<home>/.pi/goal-prompt.md` / `<cwd>/.pi/goal-prompt.md`. Inline override is `settings.goalPrompt`.
**Rationale:** Auditor has no env-var file override either; `PI_GOAL_SETTINGS_FILE` already lets users swap the whole settings file (which can carry an inline `goalPrompt`). Adding another env var is YAGNI.

## Risks / Trade-offs

- **[Risk] User injects instructions that conflict with lifecycle rules** (e.g. "skip verifier-loop"). → *Mitigation:* none at the resolver layer — by design this is a trusted channel, same as auditor-prompt.md. The completion auditor still independently verifies; bad custom rules cannot bypass `complete_goal`'s auditor gate.
- **[Risk] Large prompt file bloats every continuation turn.** → *Mitigation:* acceptable — same trade-off as auditor prompt; user owns file size.
- **[Risk] `cwd` undefined in unit tests → silent skip of injection.** → *Mitigation:* documented in JSDoc; resolver tests use real tmpdirs.
- **[Trade-off] Two near-identical resolver modules** (`auditor-prompt.ts`, `goal-prompt-resolver.ts`). → *Accepted:* decoupling outweighs DRY here; copy is ~80 lines.

## Migration Plan

1. Land code + tests behind no flag (fully additive; default = nothing configured = no injection).
2. Document new keys in README + `docs/` config reference.
3. No data migration: no existing files or settings are renamed.
4. Rollback: revert the commit; no on-disk artifacts created at runtime.

## Open Questions

- None blocking. Optional future work (out of scope): templating support, per-goal-id prompt overrides, exposing this channel through a TUI settings dialog.
