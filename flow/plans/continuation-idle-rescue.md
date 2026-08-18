# Continuation Idle Rescue (fix cooldown-drop deadlock)

> Plan ID: `continuation-idle-rescue`
> Created: 2026-08-17 · Last reconciled: 2026-08-18
> Status: done
> Items: 15 total (15 implemented, 0 pending) + 5/5 DOD criteria satisfied
> Branch: main
> Location: flow/plans/continuation-idle-rescue.md

## Requirement (verbatim)

Source: current context — exploration session 2026-08-17, captured in `flow/intentions/2026-08-17_continuation-idle-rescue.md`.

> --- problem: - agent usually answer premature and stop working on the goal; previously we keep injecting the message every turn , but we have the feature that to dedup / debounce it ; But seems like that feature mostly / completely disable the injecting to make new turn while the agent not yet completed; --- could we: - check message send , then if it session_idle (goal !completed) , if it 30s passed by and no new turn , then send the injected message to keep it running ? - injected message will be configurable , using jinja template , could be rotate in the pool of message instead of fixed ?

> - last send < 10 mins -> put to queue. setTimeout (next to be rescue time , check: currentTime - lastMessageTime = 30s && idling => send);
> - 1 in queue , drop the rest; Also , either it is 30s or 10 mins , the amount of send is 1 message ;
>
> Discard the rotation for now , we will do it later ;

**Root cause** (verified in code): `sendQueuedContinuation` (extensions/goal.ts ~L1980) drops on `shouldSendContinuation()===false` and returns WITHOUT rescheduling. Continuation is the only turn-driver in auto-run → cooldown drop = permanent stall. Gates verified: `shouldSendContinuation` in extensions/goal-core.ts, config in extensions/goal-settings.ts (`goalContinuation.minIntervalMs`, default 600000, env `PI_GOAL_CONTINUATION_MIN_INTERVAL_MS`), existing single-slot vars `continuationQueuedFor`/`continuationScheduledFor`/`continuationTimer`.

## DOD (Definition of Done)

Plan done when ALL below true:

- [x] Active auto-run goal with incomplete work never sits idle past `idleRescueMs` (default 30s) — a rescue continuation arrives and triggers a new turn (no manual re-prompt).
- [x] At most 1 continuation send per window regardless of firing path (rescue T1 vs cooldown T2) — no double-send.
- [x] Continuously-working sessions keep existing 10-min cooldown semantics unchanged (T2-only path).
- [x] `idleRescueMs: 0` restores pure-cooldown behavior (reschedule fix retained, T1 disabled).
- [x] Message rotation pool NOT implemented (deferred — user decision).

## Tasks

### Scheduling

- [x] `reschedule-on-drop`: cooldown drop path in `sendQueuedContinuation` keeps the slot armed and schedules exactly ONE timer `fireAt = min(lastAgentActivity + idleRescueMs, lastSendAt + minIntervalMs)` instead of returning dead. Probe: `rg -n "fireAt|min\(" extensions/goal.ts`.
- [x] `activity-stamp`: `lastAgentActivity` timestamp stamped on assistant `message_end` (extensions/goal.ts message_end handler). Probe: `rg -n "lastAgentActivity" extensions/goal.ts`.
- [x] `fire-dispatch`: timer fire routes — T2 elapsed → send; else idle ≥ idleRescueMs + no pending msgs → send (T1); else re-arm with recomputed fireAt. Probe: unit test busy-vs-idle fire dispatch.
- [x] `single-slot`: exactly 1 armed continuation max; enqueue while slot occupied → dropped (existing `continuationQueuedFor`/`continuationScheduledFor` guard retained; drop path no longer clears slot). Probe: unit test double-enqueue.

### Send invariant

- [x] `one-stamp`: BOTH T1 and T2 send paths route through the single `serializedSend` send fn and stamp `lastContinuationSentAt` + `lastContinuationSentGoalId` (1-send invariant). Probe: unit test — rescue send pushes next T2 eligibility to `sentAt + minIntervalMs`.
- [x] `same-prompt`: rescue send reuses `continuationPrompt(goal, settings, cwd)` unchanged (full checkpoint + `goalHash:` line) — no new prompt content, no rotation. Probe: snapshot — rescue message content identical to normal continuation for same goal state.
- [x] `no-new-bypass`: rescue path preserves ALL upstream gates — `isActionableContinuationGoal`, D6 focus-lock chokepoint (checked at enqueue), work-tool gate (upstream at message_end). No new force/bypass surface introduced. Probe: `rg -n "force" extensions/goal.ts` shows no new force path in rescue code.

### Cancellation

- [x] `user-msg-cancel`: inbound user message clears armed slot + timer AND performs existing `resetContinuationThrottle("user_message")` — stale rescue never fires mid-conversation. Probe: unit test — arm rescue, send user msg, no continuation fires.
- [x] `lifecycle-cancel`: goal pause / complete / archive / abort clears armed slot + timer (same path as existing `clearContinuationTimer` call sites). Probe: `rg -n "clearContinuationTimer" extensions/goal.ts` — rescue timers covered.

### Config

- [x] `config-schema`: `goalContinuation.idleRescueMs` exists in `GoalContinuationConfig` (extensions/goal-settings.ts), non-negative int, default 30000, `0` disables T1; validated in `asGoalContinuationBlock` (unknown-nested-key + value checks). Probe: `rg -n "idleRescueMs" extensions/goal-settings.ts`.
- [x] `config-env`: env override `PI_GOAL_CONTINUATION_IDLE_RESCUE_MS` resolved in `resolveContinuationGate` (or sibling) with source tracking (env > file > default), mirroring `minIntervalMs` pattern. Probe: `rg -n "PI_GOAL_CONTINUATION_IDLE_RESCUE_MS" extensions/goal-settings.ts`.

### Observability

- [x] `trace-steps`: `auto_run.rescue_arm` (fields: `fireAt`, `via` = T1|T2 projection) and `auto_run.rescue_fire` (fields: `via`) emitted via `logGoalTrace`, alongside existing `auto_run.queue` / `auto_run.cooldown_drop` / `auto_run.send.success`. Probe: `rg -n "rescue_arm|rescue_fire" extensions/goal.ts`.

### Tests

- [x] `tests-scheduling`: node:test coverage for — drop→reschedule (slot armed, no dead return), T1 fire at 30s idle, busy→re-arm, double-enqueue drop, `idleRescueMs=0` disables T1 (cooldown-only still reschedules). Probe: `npx tsx --test tests/goal-continuation-rescue.test.ts` green (or equivalent file).
- [x] `tests-invariant`: coverage for 1-send invariant — T1 fire stamps `lastSentAt` (next T2 = +10min), T2 fire stamps, no double-send when both conditions true simultaneously. Probe: same test file green.
- [x] `tests-cancellation`: coverage for user-msg cancel + pause/complete cancel of armed rescue. Probe: same test file green.

## Idempotency

Re-running `/10-plan-declarative` on same requirement reconciles to THIS plan.
Implemented items auto-marked `- [x]`. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads

- Rotation pool (configurable jinja-templated message pool) — DEFERRED by user. Rescue send currently reuses `continuationPrompt` verbatim. When rotation lands, T1/T2 send path reads from pool; scheduler untouched.
- Pace consequence (CA1, accepted): T1 dominates stall cycles — effective pace ≈ 1 send per stall cycle, not 1 per 10 min, whenever agent stalls ≥30s repeatedly. Anti-spam rests on: real-turn-between-rescues + work-tool gate.
- Lock re-check at fire time: existing 50ms idle-retry loop already fires long after enqueue without lock re-check — rescue timer has same risk profile. NOT widened in this plan; revisit only if dual-session rescue misfires appear.
