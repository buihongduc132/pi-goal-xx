# prompt-config-resolution Specification

## Purpose
TBD - created by archiving change unified-prompt-config. Update Purpose after archive.
## Requirements
### Requirement: Unified prompt resolution for all runtime prompts

The system SHALL provide a single resolution mechanism that applies to all 7 runtime prompts (goal-running, goal-continuation, goal-drafting, goal-tweak, goal-stale, goal-unfocused, auditor) plus tool prompt fields (promptSnippet, promptGuidelines).

#### Scenario: No configuration present

- **WHEN** no prompts block exists in settings and no `<key>.md` files exist in the prompts directories
- **THEN** each runtime prompt function returns its hardcoded default with no injected block
- **AND** the auditor prompt behaves identically to its pre-migration behavior

#### Scenario: Inline override for a runtime prompt

- **WHEN** `settings.prompts.goal-running.inline = "Always delegate implementation to a team"`
- **AND** `settings.prompts.goal-running.mode = "override"`
- **THEN** `goalPrompt()` returns ONLY the inline string, replacing the hardcoded body entirely

#### Scenario: Append mode for a runtime prompt

- **WHEN** `settings.prompts.goal-continuation.mode = "append"`
- **AND** `<cwd>/.pi/pi-goal-xx/prompts/goal-continuation.md` contains `"Require verifier-loop before completion"`
- **THEN** `continuationPrompt()` returns the hardcoded body followed by `\n\n` and the file contents

#### Scenario: global-local-merge mode combines both sources

- **WHEN** `settings.prompts.goal-drafting.mode = "global-local-merge"`
- **AND** `~/.pi/pi-goal-xx/prompts/goal-drafting.md` contains `"Global rule"`
- **AND** `<cwd>/.pi/pi-goal-xx/prompts/goal-drafting.md` contains `"Local rule"`
- **THEN** `goalDraftingPrompt()` returns hardcoded body + `\n\n` + global + `\n\n` + local

#### Scenario: global-local mode local wins

- **WHEN** `settings.prompts.goal-drafting.mode = "global-local"` (default)
- **AND** both global and local files exist
- **THEN** only the local file content is used as the resolved block

### Requirement: Resolution sources and precedence

The resolver SHALL consult sources in fixed precedence order regardless of mode: inline (always wins if present), then file sources per mode.

#### Scenario: Inline always wins regardless of mode

- **WHEN** `settings.prompts.goal-running.inline = "X"`
- **AND** both global and local files exist with different content
- **THEN** the resolved block is `"X"` and mode is recorded as `"inline"`

### Requirement: Backward compatibility for auditor settings

The system SHALL accept the legacy `auditorPrompt` and `auditorPromptMode` settings keys and treat them as aliases for `prompts.auditor.inline` and `prompts.auditor.mode` respectively.

#### Scenario: Legacy auditor settings still work

- **WHEN** settings file contains `auditorPrompt: "Y"` and `auditorPromptMode: "local"` but no `prompts.auditor` block
- **THEN** the resolver resolves the auditor prompt identically to before this change
- **AND** no warning is emitted (silent alias)

### Requirement: Path overrides for prompts directory

The system SHALL honor `settings.promptsDir` (absolute path or path relative to cwd) overriding the default `.pi/pi-goal-xx/prompts/` location for both global and local resolution.

#### Scenario: Custom prompts directory

- **WHEN** `settings.promptsDir = "/etc/pi-goals/prompts"`
- **THEN** the resolver reads global prompts from `/etc/pi-goals/prompts/` (home-relative expanded to absolute)
- **AND** reads local prompts from `<cwd>/etc/pi-goals/prompts/` if relative, or the given absolute path joined with cwd

### Requirement: Goal data always injected

The resolver SHALL guarantee that runtime fact data (objective, completion summary, verification summary, verification contract, audit checklist, verdict markers `<approved/>` / `<disapproved/>`) is present in the final prompt for any prompt key that carries fact data, regardless of resolution mode, file presence, or inline override.

The resolved persona/policy block (from inline or file) is the **persona layer**. The runtime fact block (produced by the caller, e.g. `buildGoalAuditorPrompt`) is the **fact layer**. The resolver MUST concatenate both: `final = persona-layer + "\n\n" + fact-layer`. Override mode replaces the persona layer only — never the fact layer.

This requirement exists to close BUG-1: the prior `loadAuditorPrompt` treated the file prompt as the entire prompt and dropped `buildGoalAuditorPrompt`'s goal-data blocks whenever a file existed, leaving the auditor unable to identify the goal (reproduced on pi-plugins, goal `mr72qw1x-za6kc9`, 2026-07-05).

#### Scenario: File prompt does not drop goal data

- **WHEN** `<cwd>/.pi/auditor-prompt.md` exists with persona/policy text
- **AND** no `prompts.auditor` block is present in settings
- **THEN** the final auditor prompt begins with the file's persona/policy text
- **AND** the final auditor prompt also contains the `<objective>`, `<completion_summary>`, `<goal_details>` blocks produced by `buildGoalAuditorPrompt`
- **AND** the final auditor prompt ends with the `<approved/>` / `<disapproved/>` verdict instruction

#### Scenario: Inline override does not drop goal data

- **WHEN** `settings.prompts.auditor.inline = "Be extra skeptical."`
- **AND** `settings.prompts.auditor.mode = "override"`
- **THEN** the final auditor prompt begins with `"Be extra skeptical."`
- **AND** the final auditor prompt still contains every goal-data block from `buildGoalAuditorPrompt`

#### Scenario: Override mode on a persona-only prompt is exempt

- **WHEN** a prompt key carries no runtime fact data (e.g. a tool `promptSnippet`)
- **AND** `mode = "override"` is set for that key
- **THEN** override replaces the hardcoded body entirely with no appended fact layer
- **BECAUSE** there is no fact layer to protect

