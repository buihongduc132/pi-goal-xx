## ADDED Requirements

### Requirement: Capability probe registry

The system SHALL expose a registry of named env-capability probes. Each probe SHALL be registered with a stable string id, a human-readable description, and a `probe(ctx)` function returning `{ available: boolean; detail: string; suggestedFix?: string }`. The registry SHALL be extensible at module load without modifying the gate orchestrator.

Initial registered probe ids: `acp-agents`, `teams`, `gitnexus`, `hindsight`, `jewilo-cli`, and a generic `cli-tool:<bin>` lookup family.

#### Scenario: Registered probe is callable
- **WHEN** the orchestrator asks the registry for probe `acp-agents`
- **THEN** the registry returns the probe descriptor and calling `probe(ctx)` returns a `ProbeResult`.

#### Scenario: Unknown probe id
- **WHEN** the orchestrator asks for an id that was never registered
- **THEN** the registry returns no descriptor and the gate treats the keyword as unprobed (fail-open on lookup, not a block).

### Requirement: Probe results are cached per session with TTL

The system SHALL cache each probe result per `(cwd, probeId)` pair for a configurable TTL (env `PI_GOAL_CAPABILITY_PROBE_TTL_MS`, default `60000`). A cache hit SHALL short-circuit the `probe()` call. Setting the TTL to `0` SHALL disable caching.

#### Scenario: Cache hit avoids re-probe
- **WHEN** the same probe id is requested twice within the TTL window in the same cwd
- **THEN** the underlying `probe()` function is invoked exactly once and the cached result is returned the second time.

#### Scenario: TTL expiry re-probes
- **WHEN** a cached result's age exceeds the TTL
- **THEN** the next request invokes `probe()` again and stores the fresh result.

### Requirement: Probes fail loud, not silent

A matched probe that throws or errors SHALL be treated as `available: false` with `detail: "probe error: <message>"`. The gate SHALL NOT silently skip a matched probe.

#### Scenario: Throwing probe blocks
- **WHEN** a matched probe throws during `probe()`
- **THEN** the gate treats it as unavailable (not as a skip) and the failure appears in the report.

### Requirement: Probe timeouts

Each probe invocation SHALL be bounded by a timeout (default 5 seconds, env `PI_GOAL_CAPABILITY_PROBE_TIMEOUT_MS`). A probe that exceeds the timeout SHALL be treated as `available: false` with `detail: "probe timed out after <ms>ms"`.

#### Scenario: Slow probe times out
- **WHEN** a probe does not settle within the timeout
- **THEN** the gate records an unavailable result with the timeout detail.

### Requirement: Objective constraint parsing

The system SHALL parse the `Constraints:` section of a goal objective (the same section convention used by `extractVerificationContract`'s sibling sections) for a fixed allowlist of capability keywords. Each matched keyword SHALL map to exactly one probe id. Keywords not in the allowlist SHALL be ignored (fail-open on parse).

Initial allowlist:
- `pi-acp-agents`, `acp agents`, `ACP` → `acp-agents`
- `teams`, `comrades` → `teams`
- `gitnexus` → `gitnexus`
- `hindsight` → `hindsight`
- `jewilo`, `verifier-loop cli` → `jewilo-cli`
- `cli-tool:<bin>` literal → `cli-tool:<bin>`

#### Scenario: Known keyword maps to probe
- **WHEN** the objective's `Constraints:` section contains "MUST use pi-acp-agents"
- **THEN** the parser returns probe id `acp-agents` for that constraint.

#### Scenario: Unknown keyword is ignored
- **WHEN** the `Constraints:` section contains "MUST use the flux-capacitor"
- **THEN** the parser returns no probe id for that phrase and the gate does not block on it.

#### Scenario: Only the Constraints section is parsed
- **WHEN** the keyword appears in `Boundaries:` or `Success criteria:` but not in `Constraints:`
- **THEN** the parser does not match it.

### Requirement: Preflight gate runs at goal activation

The system SHALL run the preflight gate at every transition of a goal into the active running state, specifically:
1. `propose_goal_draft` confirm path — after objective validation passes, before the goal is committed as active.
2. `/goal-resume` — before `status: paused → active`.
3. `propose_goal_tweak` confirm path — only when the tweak changed the `Constraints:` section text (diff against the prior objective).

The gate SHALL NOT run on every `queueContinuation` tick, on `session_start` auto-resume, or on draft-*proposal* (pre-confirm) views.

#### Scenario: Gate fires on draft confirm
- **WHEN** the user confirms a `propose_goal_draft` whose objective declares a matched constraint
- **THEN** the gate runs the matched probe before the goal is committed as active.

#### Scenario: Gate fires on resume
- **WHEN** the user runs `/goal-resume` on a paused goal whose objective declares a matched constraint
- **THEN** the gate runs the matched probe before the goal transitions to active.

#### Scenario: Gate skips on tweak that doesn't touch Constraints
- **WHEN** the user confirms a `propose_goal_tweak` that changed only the `Success criteria:` section
- **THEN** the gate does not run (no re-probe).

#### Scenario: Gate does not fire on continuation tick
- **WHEN** `queueContinuation` fires for an already-active goal
- **THEN** the gate is not invoked.

### Requirement: Default gate mode is block

The gate mode SHALL be controlled by env `PI_GOAL_CAPABILITY_GATE` with values `block` (default) | `warn` | `off`. In `block` mode, any matched probe reporting `available: false` SHALL prevent the goal from transitioning to active.

#### Scenario: Block mode prevents activation
- **WHEN** gate mode is `block` and a matched probe reports unavailable
- **THEN** the goal does not become active and the user is shown the gate report.

#### Scenario: Off mode skips the gate
- **WHEN** gate mode is `off`
- **THEN** no probes run and the goal activates regardless of constraint satisfaction.

### Requirement: Block-mode report and escape hatches

When the gate blocks activation, the system SHALL present a report to the user listing each failing probe: id, detail, and `suggestedFix` (if provided). The report SHALL offer three escape paths:
1. Fix the env and re-attempt activation.
2. Edit the constraint (via `/goal-tweak`).
3. Bypass for this activation by setting `PI_GOAL_CAPABILITY_GATE=warn` (or `off`).

#### Scenario: Report lists all failures
- **WHEN** two matched probes fail (e.g., `acp-agents` and `jewilo-cli`)
- **THEN** the report shows both, each with its own detail and suggestedFix.

#### Scenario: Bypass unblocks for one activation
- **WHEN** the user selects the bypass escape (`PI_GOAL_CAPABILITY_GATE=warn`)
- **THEN** the goal activates on the next attempt and the failing-capability summary is injected into the activation context.

### Requirement: Warn mode injects failure summary into agent context

In `warn` mode, the gate SHALL NOT block activation. The failing-capability summary (each failing probe's id + detail) SHALL be injected into the goal activation context that the agent receives on its first turn.

#### Scenario: Warn mode surfaces failure to agent
- **WHEN** gate mode is `warn` and a matched probe reports unavailable
- **THEN** the goal activates AND the agent's first-turn context contains a description of the failing capability.

### Requirement: Gate is stateless across activations

The gate SHALL NOT persist its results onto the goal record, the goal file, or any durable store. Probe results live only in the per-session cache (per the cache requirement) and in the transient report/context injection.

#### Scenario: No gate state on goal record
- **WHEN** the gate runs and blocks (or warns)
- **THEN** the on-disk goal record is unchanged by the gate itself (only the caller's normal activation write, if any, applies).

### Requirement: Probes read existing config, no new runtime deps

Each probe SHALL determine availability by reading config files or runtime state that pi-goal-xx already loads (e.g., ACP agent-server config, MCP metadata cache, `which <bin>` shell-outs). The change SHALL NOT add new npm runtime dependencies.

#### Scenario: ACP probe reads existing ACP state
- **WHEN** the `acp-agents` probe runs
- **THEN** it reads the same ACP agent-server configuration surface that `acp_status` reports against (zero configured servers → `available: false`).

#### Scenario: jewilo probe shells out to which
- **WHEN** the `jewilo-cli` probe runs
- **THEN** it invokes `which jewolo` (and a `--version` sanity check) and reports unavailable if the binary is missing.
