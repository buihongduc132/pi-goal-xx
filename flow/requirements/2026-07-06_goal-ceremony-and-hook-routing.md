# Requirements — Goal ceremony + hook routing

> Date: 2026-07-06
> Derived from: `flow/intentions/2026-07-06_goal-ceremony-and-hook-routing.md`
> Status: draft (pre-verifier-loop)

## R1 — Settings file extension (single source of truth)

**MUST** extend `.pi/pi-goal-xx-settings.json` schema (`extensions/goal-settings.ts` `GoalSettings` interface + `ALLOWED_SETTINGS_KEYS`) with new keys. Env overrides `PI_GOAL_*` follow existing pattern.

New keys:

```jsonc
{
  // ── Ceremony ────────────────────────────────────────────
  "ceremony": {
    "verifierLoopBeforeCompletion": "required" | "optional" | "disabled",
    "verifierLoopCommand": "jewilo NEW",          // default; override for non-jewilo
    "verifierLoopGoalTextSource": "objective" | "taskContracts" | "goalContract",
    "verifierLoopTimeoutMs": 1800000              // 30min floor per AGENTS.md
  },

  // ── Interruption policy (unified block/pause/question) ──
  "interruptions": {
    "mode": "hard-disable" | "soft-gate" | "passthrough",
    "scope": ["own-tools", "extension-hooks", "agent-self"],
    "disabledTools": ["pause_goal", "goal_question", "goal_questionnaire"],
    "webhook": {
      "url": "https://...",
      "method": "POST",
      "headers": { "Authorization": "Bearer ..." },
      "bodyTemplate": "{{event-json}}",           // handlebars-ish
      "timeoutMs": 5000,
      "onTimeout": "allow" | "reject" | "drop"
    },
    "auditorGate": {
      "enabled": true,
      "allowEvents": ["block", "pause", "question"],
      "rejectFallback": "demand-alternative"      // auditor down → reject
    }
  },

  // ── Teams fork-mode safety (PROMPT injection, not tool-block) ──
  "teamsSafety": {
    "promptOnForkModeDelegation": true,
    "rationale": "goal state NOT inherited by forked comrades (--no-skills L641-645, separate cwd). User words = PROMPT injection, not hard block."
  }
}
```

**R1.1** — `additionalProperties: false` preserved. Unknown keys rejected.
**R1.2** — Settings reloadable mid-session (existing pattern; no new mechanism).
**R1.3** — Per-goal override: each ceremony/interruption flag overridable at goal-create time. Field placement = NEW `overrides?: GoalCeremonyOverrides` field on `GoalRecord` (in `extensions/goal-record.ts`), serialized into goal JSON. Rationale: settings file is cwd-global; per-goal needs travel WITH the goal record so archival/resume preserves it. `propose_goal_draft` accepts optional `overrides` param; stored on goal record, NOT in settings. Settings = global default; record `overrides` = per-goal delta on top.

## R2 — Verifier-loop ceremony (REQUIRED before final completion)

**R2.1** — When `ceremony.verifierLoopBeforeCompletion === "required"`: `complete_goal.execute` MUST invoke `jewilo NEW "<goal objective or done criteria>"` BEFORE the auditor runs.
**R2.2** — jewilo output parsed for `mmddyy-XXXXXXXX` hash. No hash → completion REJECTED with message citing missing hash + jewilo stderr.
**R2.3** — Hash + `~/.verifier-loop/goals/<id>/completion.json` path written to goal record (`verifierLoopHash`, `verifierLoopProofPath`) and appended to the EXISTING `completion_requested` ledger event (single canonical ledger event — no new event type introduced).
**R2.4** — Auditor MUST reject (forced `<disapproved/>`) if hash absent when `required`. This is a hard gate — `confirmBypassAuditor` MUST NOT skip it.
**R2.5** — `optional` mode: hash collected if jewilo present, warned if absent, but does not block.
**R2.6** — `disabled` mode: ceremony off (current behavior preserved).
**R2.7** — Verifier text source selection (field name corrected against `extensions/goal-record.ts` — there is NO `doneCriteria` field; the real optional field is `GoalTask.verificationContract` and `GoalRecord.verificationContract`):
- Default (`verifierLoopGoalTextSource=objective`): `goalRecord.objective`.
- `taskContracts`: concatenate `verificationContract` strings from `goalRecord.taskList` LEAF nodes (recursively walk to leaves). Empty-leaf fallback: if a leaf has no `verificationContract`, use `leaf.title`. Join all with `\n`. Used for sisyphus goals where per-step criteria matter.
- `goalContract`: `goalRecord.verificationContract` (goal-level, if present); empty → fall back to `objective`.
Branch in `runVerifierLoop` reads `ceremony.verifierLoopGoalTextSource` (NOT `goal.sisyphus` flag — source is explicit config).
**R2.8** — jewilo failure (crash/missing binary) → per skill `verifier-loop`: fire gh issue on `buihongduc132/verifier-loop`, fall back to manual orchestrator, cite issue URL in completion record.
**R2.9** — Timeout floor: 30min (1800s) per AGENTS.md for any subprocess invoking LLM-based CLI.

## R3 — Interruption unified policy (block / pause / question)

Three modes — user picks per settings:

**R3.1 — `hard-disable`** (pre-call intercept API PROVEN to exist: `dist/core/extensions/types.d.ts:835` `on(event:"tool_call", ...)` + L648 "Fired before a tool executes. Can block." + `ToolCallEventResult.block?:boolean` L741. The `tool_call` hook IS pre-execution blockable. Prior round-3 claim citing `goal.ts:3881` as POST-exec was a consumer-behavior observation, NOT proof of API absence — that was a half-truth, corrected here):
- **(i) own-tools (MUST, hard-disable)**: tools in `interruptions.disabledTools` NOT registered when goal active.
- **(ii) extension-hooks from OTHER extensions (MUST for TOOL-based interruptions, SHOULD for non-tool)**: TOOL-based block/pause/question (tools registered by other extensions) → MUST swallow via `tool_call` pre-hook returning `{block:true, reason}`. NON-TOOL hooks (message-renderers, custom-command handlers, non-tool event surfaces) → SHOULD; spike in Phase 4 to enumerate non-tool interruption surfaces.
- **(iii) agent-self pause (MUST, hard-disable)**: `pause_goal` refuses with reason (same `tool_call` hook).

**R3.2 — `soft-gate`**: own-tools (i) + agent-self (iii) execute() routes through auditor gate (R5). TOOL-based extension-hooks (ii) gated via `tool_call` pre-hook (MUST). Non-tool hooks — SHOULD per R3.1(ii).

**R3.3 — `passthrough`**: current behavior. No change.

**R3.4** — Scope filter `interruptions.scope[]` controls which layers are affected: `own-tools` (goal-xx tools), `extension-hooks` (pi event hook from other exts), `agent-self` (agent-initiated pause). Default: all three.

**R3.5** — When goal NOT active: interruptions policy inactive. Restored on goal complete/abort.

## R4 — Hook dispatch (REST/curl capability)

**R4.1** — Every interruption event (block/pause/question, regardless of source) emitted as JSON to `interruptions.webhook.url` if configured.
**R4.2** — Event schema:
```json
{
  "event": "block" | "pause" | "question",
  "source": "own-tool" | "extension-hook" | "agent-self",
  "toolName": "pause_goal",
  "goalId": "...",
  "goalObjective": "...",
  "payload": { /* tool params or hook data */ },
  "timestamp": "ISO8601",
  "sessionId": "...",
  "cwd": "..."
}
```
**R4.3** — Fire-and-forget by default. Non-blocking. Failures logged via `ui.notify` (warning) but do NOT halt agent.
**R4.4** — Optional sync mode when `auditorGate.enabled=true`: webhook response (or local auditor) decides outcome:
```json
{ "decision": "allow" | "reject", "reason": "...", "alternativeAction": "..." }
```
**R4.5** — `onTimeout` policy: `allow` (default, fail-open), `reject` (fail-closed), `drop` (swallow event silently).
**R4.6** — Auth via `headers`. Body templating via `bodyTemplate` with `{{event-json}}` placeholder. No code eval.
**R4.7** — Webhook URL security: scheme allowlist = `https:` always allowed; `http:` allowed only when `interruptions.webhook.allowInsecure: true`. BLOCK `file:`, `ftp:`, etc. BLOCK hostnames resolving to private/loopback IP ranges (RFC1918, 127.0.0.0/8, 169.254.0.0/16, ::1) UNLESS `allowPrivateHost: true`. SSRF guard runs at settings-load + dispatch time.
**R4.8** — Secrets in `headers` (e.g. `Authorization`): NOT stored plaintext in settings file. MUST be env-var referenced via `"$PI_GOAL_WEBHOOK_AUTH"` interpolation OR loaded from `process.env` at dispatch. Document in README that literal secrets in settings file are rejected by validator.

## R5 — Auditor policy gate on hook events

**R5.1** — When `interruptions.auditorGate.enabled=true`: each event in `allowEvents[]` routed to auditor subsystem (reuse `goal-auditor.ts`) for decision.
**R5.2** — Auditor prompt augmented with event context + goal state. Returns `allow` / `reject`.
**R5.3** — `reject` → interruption cancelled, agent receives tool-result text: `"Interruption rejected by auditor: <reason>. Take alternative action: <alternativeAction>."`
**R5.4** — `rejectFallback` when auditor unavailable: `demand-alternative` (treat as reject) or `allow` (fail-open).
**R5.5** — Auditor decision logged to ledger (`interruption_decision` event).

## R6 — Teams fork-mode delegation block

**R6.1** — User-words aligned (PROMPT-ONLY, no tool-level block — verifier rounds 2-4 enforced): user asked for PROMPT injection ("add the prompt NEVER delegate teams in fork mode"), NOT tool-level block. Even though `tool_call` pre-hook block IS technically feasible (types.d.ts:835 + L648 + L741 — see R3.1), user did NOT authorize escalation to hard block. Scoping rationale: `--no-skills` is UNCONDITIONAL across all teams children (`leader.ts:641-645` + comment L641-642 confirms intentional worker isolation) — goal-xx extension NOT loaded in ANY teams child. The distinguishing factor for fork-mode: `contextMode="branch"` calls `sm.createBranchedSession(leafId)` (`leader.ts:141`) which copies session JSONL — FALSE impression of goal context carried — whereas `fresh` mode starts clean. So the false-inheritance hazard is fork-mode-specific, justifying fork-mode-only prompt per user words. NO tool-level BLOCK.
**R6.2** — (REMOVED — merged into R6.1 + R6.3. No tool-level hard-block. Downgrade of prior R6.2 which overreached.)
**R6.3** — PROMPT injection into goal continuation system prompt: append invariant verbatim "NEVER delegate via teams in fork mode (contextMode=branch). Goal state does not propagate — branch copies JSONL but child runs with `--no-skills` and goal-xx extension NOT loaded. Use contextMode=fresh + explicit objective handoff, or ACP non-fork. Evidence: pi-agent-teams/extensions/teams/leader.ts:641-645." This satisfies the user's verbatim "add the prompt NEVER delegate teams in fork mode".
**R6.4** — Evidence (line refs source-verified against `/home/bhd/.pi/agent/git/github.com/buihongduc132/pi-agent-teams/extensions/teams/leader.ts`): `leader.ts:641-645` (L641 `// Keep --no-skills for worker isolation, but allow extensions (pi-mcp-adapter)`; L642 `// so MCP tools are available...`; L643 `const teamsEntry = getTeamsExtensionEntryPath();`; L644 `if (teamsEntry) {`; L645 `argsForChild.push("--no-skills", "-e", teamsEntry);`) proves goal-xx extension not loaded in child. `leader.ts:141` (`const branched = sm.createBranchedSession(leafId);`) proves branch-mode session JSONL copy = false-inheritance signal. Citations verified via `grep -n` against canonical file.

## R7 — Non-functional

**R7.1** — All ceremony/gate logic MUST be non-blocking to session start (fire-and-forget where possible per AGENTS.md hooks rules).
**R7.2** — Ledger entries for every ceremony/gate decision (audit trail).
**R7.3** — Backward compat: missing `ceremony`/`interruptions`/`teamsSafety` keys = current behavior. Zero-config migration.
**R7.4** — Tests: each R2/R3/R4/R5/R6 requirement has a unit test in `tests/`. E2E for R2.1-R2.4 (jewilo happy path + missing-hash reject).

## Open questions — RESOLUTIONS (verifier-loop round 1 forced)
- OQ1: RESOLVED — ceremony applies to `complete_goal` final only per user words ("final"). `propose_goal_tweak` out of scope. R2 stands as-is.
- OQ2: RESOLVED — naive `{{event-json}}` string replace, zero dep. R4.6 stands. No handlebars.
- OQ3: RESOLVED — per-goal overrides live on `GoalRecord.overrides` (new field, `extensions/goal-record.ts`). NOT settings-keyed (settings = global default; record = per-goal delta). `propose_goal_draft` gains optional `overrides` param. See R1.3.
