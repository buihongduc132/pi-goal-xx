# Plan — Goal ceremony + hook routing

> Date: 2026-07-06
> Derived from: `flow/requirements/2026-07-06_goal-ceremony-and-hook-routing.md`
> Status: draft (pre-verifier-loop)

## Architecture

```
complete_goal.execute
  ├─ [NEW] ceremony.verifierLoopGate()        → jewilo NEW → hash or REJECT
  ├─ [EXISTING] validateGoalCompletion
  ├─ [EXISTING] task/contract gates
  ├─ [EXISTING] auditor (now hard-rejects if no hash when required)
  └─ archive

pause_goal / goal_question / goal_questionnaire .execute
  ├─ [NEW] interruptions.policyCheck(event)    → hard-disable | soft-gate | passthrough
  │     ├─ hard-disable → refuse (shouldn't reach here; tool not registered)
  │     ├─ soft-gate    → webhook.dispatch + auditorGate.decide
  │     └─ passthrough  → existing behavior
  └─ [EXISTING] execute

extension hook events (pi.on)
  ├─ [NEW] interruptions.interceptHook(event)  → same policyCheck path
  └─ existing handlers

teams tool / acp_spawn
  ├─ [NEW] teamsSafety.promptOnForkMode()      → inject continuation prompt if contextMode=branch
  └─ existing
```

New module: `extensions/ceremony/` housing all new logic. Single entry `ceremony.ts` re-exports.

## Phases

### Phase 1 — Settings schema (foundation)

**Files:**
- `extensions/goal-settings.ts` — extend `GoalSettings`, `ALLOWED_SETTINGS_KEYS`, parsers, validators.

**Tasks:**
1. Add `CeremonyConfig`, `InterruptionsConfig`, `WebhookConfig`, `AuditorGateConfig`, `TeamsSafetyConfig`, `GoalCeremonyOverrides` interfaces.
2. Add keys to `GoalSettings`: `ceremony?`, `interruptions?`, `teamsSafety?`.
3. Add keys to `ALLOWED_SETTINGS_KEYS`.
4. Add env overrides: `PI_GOAL_VERIFIER_LOOP` (required/optional/disabled), `PI_GOAL_INTERRUPTIONS_MODE`, `PI_GOAL_TEAMS_BLOCK_FORK`.
5. Validators: enum checks, webhook URL scheme allowlist (R4.7 — https always; http only if `allowInsecure`; block file/ftp/private-IP/loopback/link-local unless explicit opt-in), secret-handling check (R4.8 — reject literal `Authorization`/`Bearer`/`X-Api-Key` values in `headers`; require `$ENV_VAR` interpolation form), timeout floor assertions (verifier ≥1800000ms per AGENTS.md LLM-CLI rule).
6. Tests: `tests/ceremony-settings.test.ts` — schema accept/reject cases INCLUDING: bad URL scheme, private-IP host, plaintext secret header, missing hash on required-mode, bad enum.

**DOD:** `mise run check` passes; new tests green; validator rejects all R4.7/R4.8 violations.

### Phase 1b — Per-goal overrides (R1.3)

**Files:**
- `extensions/goal-record.ts` — add `overrides?: GoalCeremonyOverrides`.
- `extensions/goal-draft.ts` — `propose_goal_draft` accepts optional `overrides` param; validated against same schema as settings keys (subset).
- `extensions/goal-settings.ts` — `resolveEffectiveCeremony(settings, goalRecord)` merges global settings + per-record overrides (record wins).

**Tasks:**
1. Define `GoalCeremonyOverrides` = partial pick of `CeremonyConfig`, `InterruptionsConfig`, `TeamsSafetyConfig`.
2. Extend `GoalRecord` with optional `overrides`.
3. `propose_goal_draft` param + validator.
4. All ceremony/gate call sites use `resolveEffectiveCeremony()` instead of raw settings.
5. Tests: `tests/goal-overrides.test.ts` — override wins over global; archival preserves overrides; resume restores.

**DOD:** per-goal override round-trips through create→archive→resume.

### Phase 2 — Verifier-loop gate (R2)

**Files:**
- `extensions/ceremony/verifier-loop-gate.ts` (new)
- `extensions/goal.ts` — wire into `complete_goal.execute` BEFORE auditor.

**Tasks:**
1. `runVerifierLoop({goalRecord, settings, cwd, signal}): Promise<{hash, proofPath} | {error}>`:
   - Text source selection (R2.7 — field name corrected; GoalTask has NO `doneCriteria`, real field is optional `verificationContract`):
     - `ceremony.verifierLoopGoalTextSource=objective` → `goalRecord.objective`.
     - `=taskContracts` → recursively walk `goalRecord.taskList` to leaves; for each leaf use `leaf.verificationContract` if present else `leaf.title` (empty-leaf fallback); join all with `\n`.
     - `=goalContract` → `goalRecord.verificationContract` if present else fall back to `objective`.
   - Spawn `jewilo NEW "<text>"` with timeout `ceremony.verifierLoopTimeoutMs` (default 1800000).
   - Parse stdout for `mmddyy-XXXXXXXX` regex.
   - Read `~/.verifier-loop/goals/<id>/completion.json` for proof path.
   - On crash/missing binary: per skill `verifier-loop`, return `{error, fallback: "manual-orchestrator", issueUrl}`.
2. Wire into `complete_goal.execute` (tool def L2790, execute L2811, body ends L3256):
   - AFTER `validateGoalCompletion` (L2826) AND after task/contract gates (L2829-2847).
   - BEFORE the two existing `skipAuditor` branches: per-goal skip (L2877 `auditTarget.skipAuditor`) AND settings-disabled skip (L2928 `settings.disabled === true`). Rationale: verifier-loop is the upstream gate of the auditor itself — `confirmBypassAuditor` MUST NOT skip it (R2.4 hard gate). Verifier-loop `required` runs even when auditor would be skipped, so a skip-auditor goal still needs the hash.
   - `required` mode: no hash → return reject message (R2.2), do NOT archive, do NOT enter skip-auditor branches.
   - `optional`: collect hash, warn if missing via `ui.notify`, continue into existing branches.
   - `disabled`: skip entirely (existing behavior).
3. Augment `GoalRecord` with `verifierLoopHash?`, `verifierLoopProofPath?`.
4. Augment auditor prompt: inject hash requirement when `required`. Force `<disapproved/>` if hash absent AND mode=required. If mode=optional+missing, warn but do not force-disapprove.
5. Ledger: AUGMENT the existing `completion_requested` event (do NOT create new event type) with `verifierLoopHash`, `verifierLoopProofPath`, `verifierLoopMode`, `verifierLoopError` fields. Single canonical ledger event for completion ceremony.
6. Tests: `tests/verifier-loop-gate.test.ts` — mock jewilo spawn: (a) happy path hash found; (b) missing hash → reject pre-auditor; (c) crash → fallback path; (d) `taskContracts` text-source branch (sisyphus goal walks taskList leaves); (e) required-mode + skipAuditor goal still gated.

**DOD:** jewilo-mocked tests pass; manual smoke against real jewilo (separate task); ceremony gate sits at L2847→L2877 boundary (post-contract-gate, pre-skip-auditor).

### Phase 3 — Interruption policy + webhook (R3, R4)

**Files:**
- `extensions/ceremony/interruptions.ts` (new)
- `extensions/goal.ts` — wrap `pause_goal`, `goal_question`, `goal_questionnaire` execute().
- `extensions/goal-tool-names.ts` — conditional registration based on `hard-disable`.

**Tasks:**
1. `policyCheck(ctx, event): Promise<PolicyResult>`:
   - Read settings. If goal not active → passthrough.
   - `hard-disable` + event.source in scope → `{allow: false, reason}`.
   - `soft-gate` → `webhook.dispatch(event)` + `auditorGate.decide(event, response)`.
   - `passthrough` → `{allow: true}`.
2. `webhook.dispatch(event): Promise<WebhookResult | undefined>`:
   - If no `webhook.url` → undefined.
   - `fetch(url, {method, headers, body: renderTemplate(bodyTemplate, event)})` with `AbortController` timeout.
   - `onTimeout` policy: `allow`/`reject`/`drop`.
   - Non-blocking in fire-and-forget mode (Promise rejected → caught → `ui.notify` warning).
3. Conditional tool registration: in `syncGoalTools()`, if `hard-disable` + `own-tools` scope, omit `pause_goal`/`goal_question`/`goal_questionnaire` from registration.
4. Agent-self pause intercept: `pause_goal.execute` checks policy first.
5. Tests: `tests/interruptions.test.ts` — three modes, timeout policies, webhook mock via `undici` interceptor.

**DOD:** all interruption paths gated; tests green.

### Phase 4 — Extension hook interception (R3.1 ii)

**Files:**
- `extensions/ceremony/hook-interceptor.ts` (new)
- `extensions/goal.ts` — register `pi.on("tool_call", handler)` returning `ToolCallEventResult` with `block:true` (PROVEN pre-call API: `dist/core/extensions/types.d.ts:835` event name `"tool_call"`; L648 "Fired before a tool executes. Can block."; L741 `ToolCallEventResult.block?:boolean`).

**Tasks:**
1. Register `pi.on("tool_call", (event, ctx) => ...)` interceptor in goal-xx `session_start` handler. Handler checks `event.toolName` against interruption tool registry + `interruptions.scope` filter; routes matches through `policyCheck` (R3); returns `{block:true, reason}` for hard-disable + rejected soft-gate, `{block:false}` otherwise.
2. TOOL-based interruptions from OTHER extensions (e.g. a pause tool registered by another plugin) → caught by same `tool_call` hook (it fires for ALL registered tools, per types.d.ts:647-654). MUST swallow per R3.1(ii).
3. NON-TOOL interruption surfaces (message-renderers, custom-command handlers, non-tool events) → enumerate in spike; document explicitly which are NOT catchable. SHOULD per R3.1(ii).
4. Tests: `tests/hook-interceptor.test.ts` — mock `tool_call` event, assert block/allow decisions across hard-disable/soft-gate/passthrough modes.

**DOD:** TOOL-based cross-extension interruption events blocked/audited via `tool_call` hook (MUST). Non-tool surfaces enumerated with explicit callout (SHOULD).

### Phase 5 — Auditor gate (R5)

**Files:**
- `extensions/ceremony/auditor-gate.ts` (new)
- `extensions/goal-auditor.ts` — extend prompt builder for interruption decisions.

**Tasks:**
1. `auditorGate.decide(event, webhookResponse?): Promise<{decision, reason, alternativeAction?}>`:
   - Build auditor prompt with event context + goal state.
   - Parse auditor response for `allow`/`reject`.
   - `rejectFallback` when auditor unavailable.
2. Reuse existing auditor spawn mechanism (`goal-auditor.ts`).
3. Ledger event `interruption_decision`.
4. Tests: `tests/auditor-gate.test.ts` — allow/reject/timeout fallback.

**DOD:** gate functional; tests green.

### Phase 6 — Teams fork-mode PROMPT injection (R6, user-words aligned)

**Files:**
- `extensions/ceremony/teams-safety.ts` (new)
- `extensions/goal.ts` — inject continuation prompt only (NO tool-level block per user words).

**Tasks:**
1. NO tool-level block (downgraded from prior plan per verifier round-2 — user asked for prompt only: "add the prompt NEVER delegate teams in fork mode").
2. Inject invariant into goal continuation system prompt when `teamsSafety.promptOnForkModeDelegation=true`: "NEVER delegate via teams in fork mode (contextMode=branch). Goal state does not propagate — branch copies JSONL but child runs with `--no-skills` and goal-xx extension NOT loaded. Use contextMode=fresh + explicit objective handoff, or ACP non-fork. Evidence: pi-agent-teams/extensions/teams/leader.ts:641-645 (comment + `argsForChild.push('--no-skills', '-e', teamsEntry)`), leader.ts:141 (`sm.createBranchedSession(leafId)`)."
3. Tests: `tests/teams-safety.test.ts` — prompt contains invariant text when flag on; absent when off.

**DOD:** invariant prompt injected into continuation when flag on.

### Phase 7 — Integration + docs

**Tasks:**
1. E2E test: full ceremony flow (jewilo mock → hash → auditor approve → archive).
2. E2E test: missing hash → reject → goal stays open.
3. E2E test: interruption webhook fire-and-forget.
4. Update `README.md` settings section.
5. Update `AGENTS.md` lesson-learn entry for TEAMS fork inheritance.
6. `_STATE.md` entry if any manual config needed.

## Sequencing + dependencies

```
P1 (settings) ──→ P1b (per-goal overrides) ──┬─→ P2 (verifier gate)
                                              ├─→ P3 (interruptions) ──→ P4 (hooks)
                                              │                        ──→ P5 (auditor gate)
                                              └─→ P6 (teams safety)
P7 (integration) after P2-P6 all green
```

P2, P3, P6 parallelizable after P1. P4, P5 depend on P3.

## Risk / gotchas

- **G1**: jewilo spawn blocking the agent loop. Mitigation: `executionMode: "sequential"` already isolates; 30min timeout floor.
- **G2**: Webhook latency blocking interruptions. Mitigation: fire-and-forget default; sync only when `auditorGate.enabled`.
- **G3**: `tool_call` proven for TOOL-based interruptions from other extensions (types.d.ts:835+648+741). Non-tool surfaces (message-renderers, custom-commands) unproven — P4 spike enumerates, SHOULD only.
- **G4**: Auditor subprocess cost — every interruption triggering auditor = expensive. Mitigation: `allowEvents[]` filter, debounce.
- **G5**: jewilo config (`~/.verifier-loop/config.json`) must be set per-work. Ceremony assumes it's configured; document prereq in README.
- **G6**: Backward compat — every new key optional with current-behavior default. Zero-config migration verified in P7.
- **G7**: R2.4 hard-gate vs skipAuditor interaction — verifier-loop MUST run even when auditor skipped per-goal. Resolved by gate placement (post-contract, pre-skip-auditor branches). Test e covers.
- **G8**: R4.7 SSRF — admin-controlled settings but multi-tenant risk if settings committed. Validator at load+dispatch. allowPrivateHost opt-in.
- **G9**: R4.8 secret plaintext — validator rejects; env-interpolation required.

## Out of scope

- jewilo itself (use as-is; fix upstream if broken per skill).
- pi-agent-teams fork inheritance fix (separate repo; only block here).
- Per-task verifier loop (user said final only).
- Webhook retry/backoff (fire-and-forget; future enhancement).

## References

- Skill: `~/.agents/skills/verifier-loop/SKILL.md`
- Existing auditor: `extensions/goal-auditor.ts`, `flow/findings/auditor-config-design/`
- Settings: `extensions/goal-settings.ts`
- TEAMS evidence: `pi-agent-teams/extensions/teams/leader.ts:641-645` (L641 comment; L643 teamsEntry; L644 if-check; L645 `argsForChild.push('--no-skills', '-e', teamsEntry)`), `:141` (`const branched = sm.createBranchedSession(leafId);`)
- complete_goal current: `extensions/goal.ts:2790` (tool name), `:2811` (execute), `:2826` (validateGoalCompletion), `:2829-2847` (task/contract gates), `:2877` (per-goal skipAuditor), `:2928` (settings.disabled), `:3256` (def ends)
- GoalRecord: `extensions/goal-record.ts`
- Verifier skill: `~/.agents/skills/verifier-loop/SKILL.md`
