## ADDED Requirements

### Requirement: Contract snippets expand via template syntax

The system SHALL expand `{{snippet-name}}` placeholders in a `verificationContract` string by replacing them with the contents of a snippet file resolved from the contracts directories.

#### Scenario: Single snippet expansion

- **WHEN** `~/.pi/pi-goal-xx/contracts/verifier-loop.md` contains `"Run verifier-loop and require <approved/> before complete_goal"`
- **AND** a goal's verificationContract is `"{{verifier-loop}}"`
- **THEN** the stored contract in `active_goal_*.md` becomes the full expanded text, not the placeholder

#### Scenario: Multiple snippets compose

- **WHEN** `verifier-loop.md` and `e2e-required.md` both exist
- **AND** a goal's contract is `"{{verifier-loop}} + {{e2e-required}}"`
- **THEN** the stored contract contains both expanded snippets joined by ` + `

#### Scenario: Unknown snippet leaves placeholder intact

- **WHEN** a contract references `{{does-not-exist}}`
- **AND** no `does-not-exist.md` exists in any contracts directory
- **THEN** the literal `{{does-not-exist}}` is preserved in the stored contract
- **AND** a `ui.notify` warning is emitted naming the missing snippet

### Requirement: Template expansion happens at write time only

The system SHALL expand templates ONLY at goal-create and goal-tweak time. The expanded form is persisted in the goal file. Runtime reads (continuation prompts, auditor) MUST NOT re-expand.

#### Scenario: Expanded contract stored in goal file

- **WHEN** `/goals-set` is invoked with a templated contract
- **THEN** `active_goal_*.md` stores the fully expanded contract text
- **AND** subsequent reads of `goal.verificationContract` return the expanded form

#### Scenario: Snippet edited after goal creation does not retroactively update

- **WHEN** a goal was created with `{{verifier-loop}}` expanded at time T1
- **AND** the `verifier-loop.md` snippet is edited at T2 > T1
- **THEN** the existing goal's contract remains the T1 expansion
- **AND** only new goals or `/goal-tweak` invocations pick up the new snippet content

### Requirement: Snippet resolution order local then global

The system SHALL resolve snippets from local (`<cwd>/.pi/pi-goal-xx/contracts/`) before global (`~/.pi/pi-goal-xx/contracts/`). Local wins per snippet name.

#### Scenario: Local snippet overrides global of same name

- **WHEN** both `~/.pi/pi-goal-xx/contracts/verifier-loop.md` and `<cwd>/.pi/pi-goal-xx/contracts/verifier-loop.md` exist
- **THEN** the local file's content is used for `{{verifier-loop}}` expansion

### Requirement: Path override for contracts directory

The system SHALL honor `settings.contractsDir` overriding the default `.pi/pi-goal-xx/contracts/` location.

#### Scenario: Custom contracts directory

- **WHEN** `settings.contractsDir = "./legal/contracts"`
- **THEN** local snippets resolve from `<cwd>/legal/contracts/`
- **AND** global snippets resolve from `~/.pi/pi-goal-xx/legal/contracts/` (or as documented)

### Requirement: Templates disabled switch

The system SHALL honor `settings.contractTemplates = false` (or `PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true` env) disabling all template expansion. Placeholders are left literal.

#### Scenario: Templates disabled leaves placeholders

- **WHEN** `settings.contractTemplates = false`
- **AND** a contract contains `{{verifier-loop}}`
- **THEN** the literal `{{verifier-loop}}` is stored with no warning emitted
