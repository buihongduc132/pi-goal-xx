# Goal Continuation Throttle + Hash

> Plan ID: goal-continuation-throttle-hash
> Created: 2026-08-12 · Last reconciled: 2026-08-12
> Status: pending
> Worktree: `../pi-goal-xx-wt-goal-hash-throttle` (branch `goal-hash-throttle`)

## Requirement (verbatim)

> a. make it to have debounce , and maximum 1 per 10 mins; Also , each time , it must hash the goal file , then it will spit out that hash; so that sub agents will understand if it having change or not;
>
> Just add like 2-3 word into it: goalHash: <hash> ; do not instruct it to do anything else ; keep current goal prompt with just that hash;

## DOD (Definition of Done)

Plan done when ALL below true:

- [ ] Active auto-run goal with no user interaction sends at most 1 continuation checkpoint per 10 minutes (default).
- [ ] Every continuation checkpoint prompt contains a `goalHash: <8-char>` line and is otherwise byte-identical to the current continuationPrompt output.
- [ ] Hash stays stable across turns that only mutate usage/updatedAt; changes when objective/tasks/status/contract/sisyphus change.
- [ ] `minIntervalMs: 0` restores legacy per-turn behavior (all tests green, no gate).
- [ ] Goal creation / resume / user message / session_compact / auditor rejection bypass cooldown (continuation fires immediately).
- [ ] get_goal output + goal-file JSON meta expose the same goalHash.
- [ ] No agent-facing prose added about the hash (no instructions, no explanation — just the line).

## Declarative Items (end-state, idempotent)

### Cooldown gate

- [ ] (cooldown-gate) `queueContinuation` drops a scheduled continuation when the last successful send for the focused goal is < `minIntervalMs` ago. Status: pending. Probe: `grep -n "minIntervalMs\|CONTINUATION_MIN_INTERVAL" extensions/goal.ts`.
- [ ] (cooldown-bypass) Goal creation, goal resume, inbound user message, `session_compact`, and auditor rejection paths send continuation immediately regardless of cooldown. Status: pending. Probe: unit test — send at t=0, user message at t=+1s, continuation fires (no 10-min wait).
- [ ] (cooldown-config) `settings.goalContinuation.minIntervalMs` exists; default 600000; `0` disables the gate entirely (legacy behavior). Env override `PI_GOAL_CONTINUATION_MIN_INTERVAL_MS` supported. Status: pending. Probe: `grep -n "goalContinuation" extensions/goal-settings.ts` + settings test.

### goalHash

- [ ] (hash-fn) `goalHash(goal)` = sha256 over canonical subset `{id, objective, status, tasks, verificationContract, sisyphus}` → 8-hex-char prefix, exported from goal-record.ts (or equivalent module). Status: pending. Probe: `grep -rn "goalHash\|createHash" extensions/goal-record.ts extensions/goal-core.ts`.
- [ ] (hash-stable) Mutating `usage.tokensUsed` / `usage.activeSeconds` / `updatedAt` does NOT change goalHash. Status: pending. Probe: unit test — hash before/after usage bump equal.
- [ ] (hash-sensitive) Changing objective OR any task status/title OR status OR verificationContract OR sisyphus DOES change goalHash. Status: pending. Probe: unit test per mutation.

### Surfaces

- [ ] (prompt-hash-line) continuationPrompt output contains exactly one `goalHash: <8hex>` line and is otherwise unchanged — no added instructions, no compact/full branching. Status: pending. Probe: snapshot test — old prompt + hash line == new prompt.
- [ ] (get-goal-hash) get_goal text output includes `goalHash: <8hex>`. Status: pending. Probe: `grep -n "goalHash" extensions/goal.ts`.
- [ ] (file-meta-hash) Goal-file JSON meta block includes `goalHash` field, written on every persist; round-trip (write→read) preserves it. Status: pending. Probe: `grep -n "goalHash" extensions/storage/goal-files.ts`.

### Tests

- [ ] (tests-gate) Unit tests cover: gate drops < interval, fires ≥ interval, `0` disables, force paths bypass. Status: pending. Probe: `npx vitest run tests -t throttle` (or named file) green.
- [ ] (tests-hash) Unit tests cover hash stability + sensitivity + prompt/get_goal/file surfaces. Status: pending. Probe: `npx vitest run` green.

## Idempotency

Re-running `/10-plan-declarative` on same requirement reconciles to THIS plan.
Implemented items auto-marked done. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads

- Force-path list (cooldown-bypass) taken from exploration thread: {create, resume, user msg, session_compact, auditor rejection}. If implementation reveals more queueContinuation call-sites needing immediate send, append here — do NOT silently widen.
- Auditor child session sees continuation prompts via inheritance — verify hash line survives fork (manual smoke acceptable).
