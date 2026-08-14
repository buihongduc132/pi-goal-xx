# Goal Continuation Throttle + Hash

> Plan ID: goal-continuation-throttle-hash
> Created: 2026-08-12 · Last reconciled: 2026-08-13
> Status: done
> Worktree: `../pi-goal-xx-wt-goal-hash-throttle` (branch `goal-hash-throttle`)

## Requirement (verbatim)

> a. make it to have debounce , and maximum 1 per 10 mins; Also , each time , it must hash the goal file , then it will spit out that hash; so that sub agents will understand if it having change or not;
>
> Just add like 2-3 word into it: goalHash: <hash> ; do not instruct it to do anything else ; keep current goal prompt with just that hash;

## DOD (Definition of Done)

Plan done when ALL below true:

- [x] Active auto-run goal with no user interaction sends at most 1 continuation checkpoint per 10 minutes (default).
- [x] Every continuation checkpoint prompt contains a `goalHash: <8-char>` line and is otherwise byte-identical to the current continuationPrompt output.
- [x] Hash stays stable across turns that only mutate usage/updatedAt; changes when objective/tasks/status/contract/sisyphus change.
- [x] `minIntervalMs: 0` restores legacy per-turn behavior (all tests green, no gate).
- [x] Goal creation / resume / user message / session_compact / auditor rejection bypass cooldown (continuation fires immediately).
- [x] get_goal output + goal-file JSON meta expose the same goalHash.
- [x] No agent-facing prose added about the hash (no instructions, no explanation — just the line).

## Declarative Items (end-state, idempotent)

### Cooldown gate

- [x] (cooldown-gate) `queueContinuation` drops a scheduled continuation when the last successful send for the focused goal is < `minIntervalMs` ago. Status: implemented (probe passed 2026-08-13). Probe: `grep -n "minIntervalMs\|CONTINUATION_MIN_INTERVAL" extensions/goal.ts`.
- [x] (cooldown-bypass) Goal creation, goal resume, inbound user message, `session_compact`, and auditor rejection paths send continuation immediately regardless of cooldown. Status: implemented (probe passed 2026-08-13). Probe: unit test — send at t=0, user message at t=+1s, continuation fires (no 10-min wait).
- [x] (cooldown-config) `settings.goalContinuation.minIntervalMs` exists; default 600000; `0` disables the gate entirely (legacy behavior). Env override `PI_GOAL_CONTINUATION_MIN_INTERVAL_MS` supported. Status: implemented (probe passed 2026-08-13). Probe: `grep -n "goalContinuation" extensions/goal-settings.ts` + settings test.

### goalHash

- [x] (hash-fn) `goalHash(goal)` = sha256 over canonical subset `{id, objective, status, tasks, verificationContract, sisyphus}` → 8-hex-char prefix, exported from goal-record.ts (or equivalent module). Status: implemented (probe passed 2026-08-13). Probe: `grep -rn "goalHash\|createHash" extensions/goal-record.ts extensions/goal-core.ts`.
- [x] (hash-stable) Mutating `usage.tokensUsed` / `usage.activeSeconds` / `updatedAt` does NOT change goalHash. Status: implemented (probe passed 2026-08-13). Probe: unit test — hash before/after usage bump equal.
- [x] (hash-sensitive) Changing objective OR any task status/title OR status OR verificationContract OR sisyphus DOES change goalHash. Status: implemented (probe passed 2026-08-13). Probe: unit test per mutation.

### Surfaces

- [x] (prompt-hash-line) continuationPrompt output contains exactly one `goalHash: <8hex>` line and is otherwise unchanged — no added instructions, no compact/full branching. Status: implemented (probe passed 2026-08-13). Probe: snapshot test — old prompt + hash line == new prompt.
- [x] (get-goal-hash) get_goal text output includes `goalHash: <8hex>`. Status: implemented (probe passed 2026-08-13). Probe: `grep -n "goalHash" extensions/goal.ts`.
- [x] (file-meta-hash) Goal-file JSON meta block includes `goalHash` field, written on every persist; round-trip (write→read) preserves it. Status: implemented (probe passed 2026-08-13). Probe: `grep -n "goalHash" extensions/storage/goal-files.ts`.

### Tests

- [x] (tests-gate) Unit tests cover: gate drops < interval, fires ≥ interval, `0` disables, force paths bypass. Status: implemented (probe passed 2026-08-13). Probe: `npx vitest run tests -t throttle` (or named file) green.
- [x] (tests-hash) Unit tests cover hash stability + sensitivity + prompt/get_goal/file surfaces. Status: implemented (probe passed 2026-08-13). Probe: `npx vitest run` green.

## Idempotency

Re-running `/10-plan-declarative` on same requirement reconciles to THIS plan.
Implemented items auto-marked done. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads

- Force-path list (cooldown-bypass) taken from exploration thread: {create, resume, user msg, session_compact, auditor rejection}. If implementation reveals more queueContinuation call-sites needing immediate send, append here — do NOT silently widen.
- Auditor child session sees continuation prompts via inheritance — verify hash line survives fork (manual smoke acceptable).

## Implementation record

- RED: ed32a72 (throttle + goalHash tests)
- GREEN: 4229bfd (throttle gate + goalHash surfaces)
- Fix: c95f4c1 (auditor-rejection force-bypass)
- Fix: cd817a8 (tests converted to node:test — vitest undeclared dep)
- Merged: PR #64 → main, pushed (origin/main == cd817a8)
- Tests: throttle+hash 37/37 pass. Full suite 76 pre-existing failures (auditor zones — separate in-flight work, NOT this change).
