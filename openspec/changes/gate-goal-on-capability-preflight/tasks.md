## 1. Capability probe registry + initial probes (new module `extensions/capability-probes.ts`)

- [ ] 1.1 Define types: `ProbeResult = { available: boolean; detail: string; suggestedFix?: string }`, `ProbeContext = { cwd: string; cache: ProbeCache; timeoutMs: number }`, `ProbeDescriptor = { id: string; description: string; probe: (ctx: ProbeContext) => Promise<ProbeResult> | ProbeResult }`.
- [ ] 1.2 Implement `CapabilityProbeRegistry` (Map<id, ProbeDescriptor>) with `register(desc)`, `get(id): ProbeDescriptor | undefined`, `list(): ProbeDescriptor[]`.
- [ ] 1.3 Implement `acp-agents` probe: read the same ACP agent-server config surface `acp_status` reports against; return `{ available: configuredAgentServers > 0, detail, suggestedFix: "wire ACP agents in profile/config.toml (claude/gemini/ocxo/hermes) or set PI_GOAL_CAPABILITY_GATE=warn" }`. **Fail-loud**: probe error → `available: false` with detail `probe error: <msg>`.
- [ ] 1.4 Implement `teams` probe: return `available: true` always initially (teams is always available in pi) — detail notes the assumption. Keep as a probe so future changes can tighten the check.
- [ ] 1.5 Implement `gitnexus` probe: hit `gitnexus_local_status`-equivalent (read local status / config); `available: true` if reachable, else `false` with suggestedFix.
- [ ] 1.6 Implement `hindsight` probe: check the configured Hindsight bank connection (`hindsight_bank_profile` equivalent); `available: true` if connected.
- [ ] 1.7 Implement `jewilo-cli` probe: `which jewilo` + `jewilo --version` sanity; `available: false` if missing/non-zero.
- [ ] 1.8 Implement `cli-tool:<bin>` family: generic lookup that resolves `<bin>` from the id at probe time (`which <bin>`); registered as a single wildcard descriptor the orchestrator consults when an id starts with `cli-tool:`.
- [ ] 1.9 Register all probes at module load (a single `registerBuiltInProbes(registry)` function called once).
- [ ] 1.10 Add unit tests: each probe's available/unavailable/error path; registry get/register/list; wildcard `cli-tool:` resolution.

## 1b. Verify probe surfaces exist (PRECONDITION before task 2 wiring)

- [ ] 1b.1 Confirm the ACP agent-server config read path: grep `extensions/` and `node_modules/@earendil-works/pi-coding-agent/dist` for how `acp_status` resolves `configuredAgentServers`. If it reads from a runtime singleton that isn't importable from pi-goal-xx, fall back to reading `<runtimeRoot>/runtime/tasks.json` existence + the config's agentServers declaration. Document the actual source chosen.
- [ ] 1b.2 Confirm the Hindsight bank connection check: find how `hindsight_bank_profile` resolves connection state (env var? HTTP probe to `:24300`?). Record the chosen signal.
- [ ] 1b.3 Confirm `gitnexus_local_status` is callable from the extension context (it's exposed as an MCP tool, not a TS import). Decide: (a) HTTP probe to `http://<host>:4747/health`, or (b) read `mcp-cache.json` for the gitnexus entry's `connected` state. Pick (b) if cheap, (a) as fallback. Document choice.

## 2. Constraint parser (new module `extensions/goal-capability-preflight.ts`)

- [ ] 2.1 Implement `extractConstraintsSection(objective): string` — extract the `Constraints:` section (sibling logic to `extractVerificationContract` in `goal-draft.ts`). Returns empty string if no section.
- [ ] 2.2 Implement the allowlist map (keyword regex → probe id) per design D3. Use word-boundary regexes; case-insensitive.
- [ ] 2.3 Implement `parseConstraintProbeIds(constraintsText): string[]` — scan for allowlist keywords, return deduped probe ids. Unknown text ignored.
- [ ] 2.4 Add unit tests: known keyword → probe id; unknown keyword → ignored; only Constraints section parsed (Boundaries/Success-criteria keyword NOT matched); multiple matches deduped; case-insensitivity.

## 3. Gate orchestrator + cache (same module `extensions/goal-capability-preflight.ts`)

- [ ] 3.1 Implement `ProbeCache` (Map<`${cwd}::${probeId}`, { result, expiresAt }>) with `get`, `set`, `clear`, and TTL from `PI_GOAL_CAPABILITY_PROBE_TTL_MS` (default 60000; 0 disables).
- [ ] 3.2 Implement `runProbeWithTimeout(probe, ctx, timeoutMs)` (default 5000, env `PI_GOAL_CAPABILITY_PROBE_TIMEOUT_MS`): wraps probe in a Promise.race against a timeout; on timeout returns `{ available: false, detail: "probe timed out after <ms>ms" }`; on throw returns `{ available: false, detail: "probe error: <msg>" }`.
- [ ] 3.3 Implement `runPreflightGate({ cwd, objective, registry }): { mode, results: Array<{ probeId, result }>, failing: ProbeResult[], passing: ProbeResult[] }`. Reads `PI_GOAL_CAPABILITY_GATE` (block|warn|off). For `off`, returns immediately with empty results. For block/warn: parse constraints → probe ids → for each, cache-or-probe → partition into failing/passing.
- [ ] 3.4 Add unit tests: cache hit short-circuits probe; TTL expiry re-probes; TTL=0 disables cache; throw → unavailable; timeout → unavailable; mode=off returns empty.

## 4. Report formatter + escape hatches

- [ ] 4.1 Implement `formatGateReport({ failing }): string` — renders a multi-line report (one block per failing probe: id, detail, suggestedFix). Plain text, suitable for the proposal dialog.
- [ ] 4.2 Implement `formatWarnContext({ failing }): string` — shorter summary for agent-context injection (one line per failing probe: `⚠ <probeId>: <detail>`).
- [ ] 4.3 Define escape-hatch instructions text: (1) fix env + retry, (2) `/goal-tweak` to edit Constraints, (3) set `PI_GOAL_CAPABILITY_GATE=warn` (or `off`) and re-attempt. Include in the block-mode report.
- [ ] 4.4 Add unit tests: formatter output shape; multiple failures render in order; missing suggestedFix omits the line gracefully.

## 5. Wire gate into `propose_goal_draft` confirm path

- [ ] 5.1 In `extensions/goal-draft.ts`, locate the confirm-success path (after focus gate + sisyphus-match + non-empty objective checks, before the goal is committed as active). Insert a call to `runPreflightGate`.
- [ ] 5.2 On `mode=block` AND `failing.length > 0`: do NOT commit the goal as active. Render the report via the existing `showProposalDialog` path used for draft confirmations. Return early; keep the goal in drafting state so the user can `/goal-tweak` or change env.
- [ ] 5.3 On `mode=warn` AND `failing.length > 0`: commit the goal as active (normal path) AND inject `formatWarnContext` output into the activation context the agent receives on its first turn.
- [ ] 5.4 On `mode=off` OR `failing.length === 0`: normal activation, no gate output.
- [ ] 5.5 Add integration tests: block prevents activation (goal stays drafting); warn activates + context contains probe id; off activates normally.

## 6. Wire gate into `/goal-resume` + `propose_goal_tweak` confirm paths

- [ ] 6.1 In `extensions/goal.ts`, locate the `/goal-resume` handler (paused → active transition). Insert `runPreflightGate` before the status flip. Block/warn/off semantics identical to task 5.
- [ ] 6.2 In `extensions/goal-draft.ts` (or wherever `propose_goal_tweak` confirm lives), insert `runPreflightGate` ONLY when the tweaked objective's `Constraints:` section differs from the prior objective's `Constraints:` section (string diff after `extractConstraintsSection`). If unchanged, skip the gate.
- [ ] 6.3 Ensure gate does NOT fire on: `queueContinuation`, `session_start` auto-resume, draft-*proposal* (pre-confirm) views. Add negative tests asserting non-invocation on each.
- [ ] 6.4 Add integration tests: resume-block keeps goal paused; resume-warn resumes + injects context; tweak-with-unchanged-constraints skips gate; tweak-with-changed-constraints runs gate.

## 7. Env-flag plumbing + defaults

- [ ] 7.1 Read `PI_GOAL_CAPABILITY_GATE` (block|warn|off; default `block`) — single resolver function, called by `runPreflightGate`.
- [ ] 7.2 Read `PI_GOAL_CAPABILITY_PROBE_TTL_MS` (default 60000) and `PI_GOAL_CAPABILITY_PROBE_TIMEOUT_MS` (default 5000).
- [ ] 7.3 Validate values; on invalid `PI_GOAL_CAPABILITY_GATE` value, fall back to `block` with a UI warning (do NOT crash).
- [ ] 7.4 Unit tests: defaults applied when env unset; invalid value → block + warning; explicit values respected.

## 8. README + AGENTS.md + flow docs

- [ ] 8.1 Add a "Capability preflight gate" section to `README.md`: what it does, the three modes, the env flags, how to add a new probe (registry extension point), the allowlist keyword→probe table.
- [ ] 8.2 Add a one-line callout to `AGENTS.md` (or the project's equivalent) pointing at the gate, the default block behavior, and the override env flag — so future agents know the escape hatch exists.
- [ ] 8.3 Create `flow/findings/goal-capability-preflight/` with the locked-decisions note (D1–D7 verbatim from design.md) so implementation can reference it without re-deriving.
- [ ] 8.4 Cross-reference: note in `flow/` that the in-flight `add-goal-focus-locking` goal's "MUST use pi-acp-agents" failure mode is the motivating incident for this change (link the RED-phase commit context).

## 9. Verification (TDD-style — RED before GREEN per project discipline)

- [ ] 9.1 **RED**: write failing tests for every requirement in `specs/goal-capability-preflight/spec.md` (registry, cache, fail-loud, timeout, parser, gate-at-activation, block-default, report+escapes, warn-context-injection, stateless, no-new-deps). Commit; confirm RED.
- [ ] 9.2 **GREEN**: implement tasks 1–7 against the RED tests. Confirm all green.
- [ ] 9.3 Run `openspec validate gate-goal-on-capability-preflight` — must pass.
- [ ] 9.4 Run `npm test` (existing + new) and `npm run check` (tsc) — both clean.
- [ ] 9.5 Smoke: construct a fake objective with `Constraints: MUST use pi-acp-agents` in a test cwd where ACP has zero configured servers; confirm the gate blocks with the expected report. Then set `PI_GOAL_CAPABILITY_GATE=warn`; confirm activation + context injection. Then `=off`; confirm bypass.
- [ ] 9.6 Smoke: construct a fake objective with an unknown constraint keyword ("flux-capacitor"); confirm gate does NOT block (fail-open on parse).
