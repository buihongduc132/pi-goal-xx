## Why

A goal objective can declare hard constraints that depend on environment capabilities (e.g., "MUST use pi-acp-agents", "MUST use verifier-loop CLI", "deploy runs through the full chain"). When the current env cannot satisfy such a constraint, the failure is discovered **mid-run** — after hours of RED-phase work — instead of before the goal ever starts. This is exactly the failure the in-flight `add-goal-focus-locking` Sisyphus goal hit: its "MUST use pi-acp-agents" hard constraint was unsatisfiable (ACP had zero configured agent servers), but the goal ran anyway and only failed at step 3 (delegate-to-ACP).

There is no gate today between "user confirmed the goal" and "agent started running it." A capability preflight at goal activation closes that gap: probe each declared env dependency before the goal transitions to active, and block (with a report + suggested fix) if any hard constraint is unsatisfiable.

## What Changes

- **Capability probe registry**: a new module `extensions/capability-probes.ts` exposes a registry of named env-capability probes. Each probe returns `{ available: boolean; detail: string; suggestedFix?: string }`. Initial probes cover the common delegation/verification dependencies that appear in goal objectives: `acp-agents`, `teams`, `gitnexus`, `hindsight`, `jewilo-cli`, plus a generic `cli-tool:<name>` lookup.
- **Objective constraint parsing**: a new helper parses a goal objective's `Constraints:` section for capability keywords (e.g., "pi-acp-agents", "jewilo", "verifier-loop", "deploy-full"). The parser maps keyword → probe id; unknown constraints are NOT probed (fail-open on parse, fail-loud on probe).
- **Preflight gate at goal activation**: when a goal transitions to active — via `propose_goal_draft` confirm, `propose_goal_tweak` confirm (if it materially changes constraints), or `/goal-resume` — run the matched probes. If any matched hard-constraint probe reports `available: false`, the goal does NOT auto-start: the user is shown a report listing the failing capability, the probe detail, and the suggested fix, and is asked to (a) fix the env and retry, (b) edit the constraint, or (c) explicitly bypass with an env override.
- **Bypass path**: `PI_GOAL_CAPABILITY_GATE=off` disables the gate entirely; `PI_GOAL_CAPABILITY_GATE=warn` downgrades block → warning (goal starts, but the failing capability is surfaced to the agent in the activation context). Default is `block`.
- **Cache**: probe results are cached per-session with a short TTL (default 60s) so repeated activations (e.g., tweak loop) don't re-probe expensive checks. Cache is invalidated on explicit env change signals (none wired initially — manual refresh via re-activation).
- **Reporting surface**: the gate report is shown to the user via the existing proposal-dialog / status mechanism, and (when bypassed) the failing-capability summary is injected into the goal activation context so the agent sees it.
- **NOT in scope**: auto-fixing the env (only reporting + suggested fixes), parsing free-form `Boundaries:` text for capabilities (only the `Constraints:` section is parsed), probing MCP servers generically (only the named probes above; extension points let future changes add more), gating at `session_start` auto-resume (deferred — see OQ1 in design).

## Capabilities

### New Capabilities
- `goal-capability-preflight`: A preflight gate that runs env-capability probes against the hard constraints declared in a goal objective before the goal transitions to active, blocking (or warning, per config) when a matched constraint is unsatisfiable.

### Modified Capabilities
<!-- None. The gate runs at propose_goal_draft/resume activation boundaries, not at session_start auto-resume. The interaction with the in-flight `add-goal-focus-locking` change is a documentation/README cross-reference, not a spec-level behavior change to `goal-session-focus`. -->

## Impact

- **Affected code**:
  - `extensions/capability-probes.ts` (new) — probe registry + individual probes (acp, teams, gitnexus, hindsight, jewilo, cli-tool lookup).
  - `extensions/goal-capability-preflight.ts` (new) — constraint parser, gate orchestrator, cache, report formatter.
  - `extensions/goal-draft.ts` — call the preflight gate inside the `propose_goal_draft` confirm path (after objective validation, before the goal is committed to active). Reuse for `propose_goal_tweak` confirm.
  - `extensions/goal.ts` — call the preflight gate on `/goal-resume` before transitioning paused → active. Wire `PI_GOAL_CAPABILITY_GATE` env read.
  - `extensions/goal-tool-names.ts` — no change (gate is not a tool; it's an internal gate).
- **New env flags**: `PI_GOAL_CAPABILITY_GATE` (`block` | `warn` | `off`; default `block`), `PI_GOAL_CAPABILITY_PROBE_TTL_MS` (default `60000`).
- **Dependencies**: none new. ACP/teams/gitnexus/hindsight probes read existing config files / runtime state the extensions already load; jewilo probe is a `which jewilo` + `--version` shell-out.
- **Backward compatibility**: default behavior changes — goals that previously silently started with unsatisfiable constraints will now be blocked. Users who want the old behavior set `PI_GOAL_CAPABILITY_GATE=off`. The gate is fail-open on *parse* (unknown constraint keywords are not probed) and fail-loud on *probe* (a matched probe that errors is treated as unavailable, not silently skipped).
- **Out of scope**: auto-remediation of env, generic MCP-server probing, parsing capabilities from non-`Constraints:` sections, probing at goal-draft *proposal* time (the gate runs at *confirm/activation*, not while the user is still editing the draft).
