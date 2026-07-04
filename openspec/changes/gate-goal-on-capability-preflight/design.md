## Context

pi-goal-xx lets a user commit a goal via `propose_goal_draft` (confirm) and resume a paused goal via `/goal-resume`. In both paths the goal transitions straight to "active running" with no check that the current env can satisfy the hard constraints the objective declares. The in-flight `add-goal-focus-locking` Sisyphus goal exposed the gap: its `Constraints` block said "MUST use pi-acp-agents" but `acp_status` reported zero configured agent servers — the goal ran for hours (through RED phase, commit `da87ae6`) before the failure surfaced at the delegation step.

Today's activation chain (simplified):

```
propose_goal_draft (confirm)
   └─ objective validation (focus gate, sisyphus match, non-empty)
   └─ [NO env-capability check]
   └─ commit goal to disk → status=active
   └─ queueContinuation (agent starts running)

/goal-resume
   └─ [NO env-capability check]
   └─ status: paused → active
   └─ queueContinuation
```

Stakeholders: any user running a goal whose constraints depend on env state (ACP, MCP servers, CLIs, deploy pipelines), and any agent that would otherwise burn a RED phase on an unsatisfiable goal.

Constraints driving the design:
- Fail-open on **parse** (unknown constraint keyword → not probed). Fail-loud on **probe** (matched probe error → treated as unavailable).
- No new runtime deps; probes read existing config / shell state.
- Default = block; user must be able to escape the gate (override env flag) without editing the objective.
- Gate runs at **activation**, not at draft-proposal time (the user is still editing then).

## Goals / Non-Goals

### Goals
- G1. Before a goal transitions to active, run env-capability probes against the hard constraints declared in its `Constraints:` section.
- G2. Block activation when any matched probe reports unavailable, with a user-facing report (capability, why, suggested fix) and three escape hatches (fix env, edit constraint, bypass).
- G3. Keep the probe set extensible without code surgery — a registry pattern, each probe self-contained.
- G4. Make the gate configurable: `block` (default) | `warn` | `off`.
- G5. Surface the failing-capability summary to the agent when the gate is bypassed, so the agent doesn't silently proceed as if everything is fine.
- G6. Apply uniformly to both activation entry points: `propose_goal_draft` confirm and `/goal-resume`. (And `propose_goal_tweak` confirm when the tweak materially changes constraints.)

### Non-Goals
- N1. Auto-remediating the env (installing missing CLIs, wiring ACP agents). Reports only.
- N2. Generic MCP-server probing. Only the named probes ship initially; future changes add more via the registry.
- N3. Parsing capabilities from `Boundaries:`, `Success criteria:`, or free-form prose. Only the `Constraints:` section is parsed (matches how `extractVerificationContract` already scopes itself to a named section).
- N4. Running the gate at draft-*proposal* time. The user is still iterating on the objective then; gating would be noisy.
- N5. Persisting gate results onto the goal record. The gate is a transient activation-time check, not goal state.
- N6. Probing at every `queueContinuation` tick. Once-per-activation (with a short cache) is enough — env doesn't usually change mid-goal.

## Decisions

### D1: Gate location — inside `propose_goal_draft` / `propose_goal_tweak` confirm and `/goal-resume`, NOT inside `queueContinuation`

**Decision**: The gate runs once, at the moment the goal is about to become active. For `propose_goal_draft`/`propose_goal_tweak` that's right after objective validation passes and right before the goal is committed to disk as active. For `/goal-resume` that's right before `status: paused → active`.

**Rationale**: `queueContinuation` fires on every continuation tick (turn end, agent end, etc.) — running probes there would be both expensive and semantically wrong (the env was already checked when the goal started). The activation boundary is the natural chokepoint: one check, clear semantics ("you may now start").

**Alternatives**:
- Gate inside `queueContinuation` with heavy caching — rejected: wrong layer, cache-invalidation complexity, semantically muddled.
- Gate inside `loadState`/`resolveSessionFocus` (where the focus-locking change hooks in) — rejected: those run on session_start/tree nav too, where we don't want to block (a resumed session shouldn't be re-blocked on every restart unless the user explicitly resumes the goal).

### D2: Probe registry pattern — id → `{ probe(), meta }`

**Decision**: A `CapabilityProbeRegistry` maps string ids (`"acp-agents"`, `"teams"`, `"gitnexus"`, `"hindsight"`, `"jewilo-cli"`, `"cli-tool:<bin>"`) to probe descriptors:
```ts
type ProbeResult = { available: boolean; detail: string; suggestedFix?: string };
type ProbeDescriptor = {
  id: string;
  description: string;
  probe: (ctx: ProbeContext) => Promise<ProbeResult> | ProbeResult;
};
```
`ProbeContext` carries the cwd + a shared cache handle so probes can memoize within a single gate run.

**Rationale**: Extensible without editing the orchestrator. A future change adding e.g. an `archon-workflow` probe just registers it; the orchestrator and parser don't change. Each probe is independently testable.

**Alternatives**:
- Single `checkCapabilities(names)` function with a switch — rejected: not extensible, grows unboundedly.
- Probes-as-config (YAML declaring shell commands) — rejected: too lossy for probes that need real logic (e.g., ACP needs to read JSON state, not just `which`).

### D3: Constraint keyword → probe id mapping — explicit allowlist, fail-open on unknown

**Decision**: A small mapping table from objective-text keyword → probe id:
```
"pi-acp-agents" | "acp agents" | "ACP"     → "acp-agents"
"teams" | "comrades"                        → "teams"
"gitnexus"                                  → "gitnexus"
"hindsight"                                 → "hindsight"
"jewilo"                                    → "jewilo-cli"
"verifier-loop cli"                         → "jewilo-cli"  (alias)
"deploy-full" | "deploy-prod" | "mise run deploy" → "cli-tool:mise"
```
The parser scans the `Constraints:` section (extracted via a sibling helper to `extractVerificationContract`) for these keywords. **Unknown keywords are ignored** — we do not invent probes for words we don't recognize. This is fail-open on parse.

**Rationale**: Constraining the parser to an allowlist keeps false positives near zero (we never accidentally probe something the user didn't mean). The cost is incomplete coverage — but the user can always add a probe via the registry extension point.

**Alternatives**:
- LLM-driven constraint parsing — rejected: non-deterministic, hard to test, would need a model call per gate run.
- Probe everything always — rejected: expensive, noisy reports, false positives.

### D4: Default mode = `block`; override via `PI_GOAL_CAPABILITY_GATE`

**Decision**: `PI_GOAL_CAPABILITY_GATE` accepts `block` (default) | `warn` | `off`.
- `block`: failing probe → goal does NOT activate. User gets the report + the three escape hatches (fix env, edit constraint via `/goal-tweak`, set `PI_GOAL_CAPABILITY_GATE=warn|off`).
- `warn`: failing probe → goal activates, but the failing-capability summary is injected into the activation context (so the agent sees it on its first turn).
- `off`: gate skipped entirely.

**Rationale**: Block-by-default is the whole point — catch the failure before it wastes hours. But the user must always have an escape (envs vary, probes can have false negatives, the user may know better). `warn` is the "I know, proceed but tell the agent" middle ground.

**Alternatives**:
- Default `warn` — rejected: defeats the purpose (the agent still starts running on an unsatisfiable goal).
- No override — rejected: traps the user when a probe is wrong.

### D5: Fail-loud on probe error vs fail-open

**Decision**: A matched probe that throws / errors is treated as `available: false` with `detail: "probe error: <message>"`. NOT silently skipped.

**Rationale**: If `acp_status` errors out, that's a signal the env is broken in a way relevant to the constraint — treating it as "skip" would let the goal run into the same broken state mid-flight. Fail-loud surfaces it at the gate where the user can act.

**Trade-off**: A flaky probe (e.g., gitnexus HTTP timeout) could block a goal that would actually work. Mitigation: probe timeouts are short (default 5s) and the `warn`/`off` overrides exist.

**Alternatives**:
- Fail-open on probe error — rejected: silently swallows real env failures, the exact bug this change exists to prevent.

### D6: Per-session cache with short TTL

**Decision**: Probe results cached in a module-level `Map<probeId, { result, expiresAt }>` keyed by cwd+probeId. Default TTL 60s (`PI_GOAL_CAPABILITY_PROBE_TTL_MS`). Cache lookup happens before `probe()` invocation.

**Rationale**: A tweak-confirm loop re-runs the gate; we don't want to re-shell-out `which jewilo` every time. 60s is short enough that env changes (user fixes something) are picked up on the next manual activation.

**Alternatives**:
- No cache — rejected: tweak loop becomes expensive.
- Persistent cache across sessions — rejected: env can change between sessions; per-session is the right scope.

### D7: Reporting surface — proposal-dialog for block, context-injection for warn

**Decision**:
- `block`: render the report via the same `showProposalDialog` path used for `propose_goal_draft` confirmations. The dialog lists each failing probe: id, detail, suggestedFix. Buttons map to the three escapes (the "edit constraint" path tells the user to run `/goal-tweak`; the "bypass" path is one-click setting `PI_GOAL_CAPABILITY_GATE=warn` for this activation only).
- `warn`: the report is returned from the gate as a string and the caller injects it into the goal activation context (the same place verifiers/lock-state would surface context to the agent).

**Rationale**: Reuses existing UX for block (no new dialog component). For warn, the agent needs to see it — context injection is the established channel.

**Alternatives**:
- New dedicated gate-report widget — rejected: YAGNI; proposal dialog already handles multi-line reports.
- UI-only indicator for warn — rejected: violates the "agent must see bypassed failures" goal (G5).

## Risks / Trade-offs

- **[R1] False-negative probes block a working goal** → Mitigation: `warn`/`off` overrides; short probe timeouts; fail-open on parse so only matched keywords are probed.
- **[R2] Constraint keyword allowlist gets stale as new tools appear** → Mitigation: registry is the extension point; adding a probe + allowlist entry is a small, local change. Documented in tasks.
- **[R3] Gate runs on `propose_goal_tweak` confirm and annoys users tweaking unrelated fields** → Mitigation: only re-run the gate if the tweak changed the `Constraints:` section (diff check). Tasks spell this out.
- **[R4] Probe cache hides an env fix the user just made** → Mitigation: 60s TTL is short; manual re-activation (re-confirm) bypasses cache; `PI_GOAL_CAPABILITY_PROBE_TTL_MS=0` disables cache.
- **[R5] ACP/teams probes need to read runtime state that may itself be lazily loaded** → Mitigation: probes call the same status functions the user-facing tools (`acp_status`, etc.) use; if those are lazy, the probe is too — that's correct behavior.
- **[R6] Block-by-default changes behavior for existing goals** → Mitigation: `PI_GOAL_CAPABILITY_GATE=off` restores prior behavior; documented in README + AGENTS.md.

## Migration Plan

1. Ship behind the existing env flag (`PI_GOAL_CAPABILITY_GATE`, default `block`).
2. Users who hit false negatives set `PI_GOAL_CAPABILITY_GATE=warn` (keeps the report, drops the block) or `off`.
3. No data migration — the gate is transient, writes nothing to the goal record.
4. Rollback: set `PI_GOAL_CAPABILITY_GATE=off` globally; the gate becomes a no-op. Code rollback is a single revert (the gate is isolated to two new modules + two call sites).

## Open Questions

- **OQ1**: Should the gate also fire on `session_start` auto-resume (when a focused+active goal is inherited by a resumed session)? Initial answer: **no** — that path is already gated by the focus-locking change's lock check, and re-probing on every session start is noisy. Revisit if real-world use shows env drift mid-session.
- **OQ2**: Should `warn`-mode failures be persisted to the goal ledger so the user can audit later? Initial answer: **no** (N5) — keep the gate stateless. Revisit if users ask for it.
- **OQ3**: Probe for `mise run deploy-*` (the deploy-chain constraint) — should it actually invoke `mise run deploy-status` or just `which mise`? Initial answer: `which mise` only (cheap, no side effects); the deploy-chain failure mode is better caught by the deploy skill's own checks.
