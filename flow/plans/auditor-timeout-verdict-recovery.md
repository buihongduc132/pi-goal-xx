# Auditor timeout verdict recovery

> Plan ID: `auditor-timeout-verdict-recovery`
> Created: 2026-08-21 · Last reconciled: 2026-08-21
> Status: done
> Branch: fix/auditor-timeout-verdict-recovery (merged PR #70, squash 1b17cf6)
> Location: flow/plans/auditor-timeout-verdict-recovery.md
> Items: 6 total (6 implemented, 0 pending)

## Requirement (verbatim)

> "then invoke in the process tools agy -p <reference to the task you create> , implement this must pass verifier loop , must make pr --- then you review and merge it in;"

Substance (resolved from current conversation, source: transcript diagnosis of goal mt2hytki-ppc1am):

- Auditor finished 30min verification, wrote `<approved/>` in report.
- Harness `setTimeout` (1800000ms) fired first → returned `{approved:false, error:"Auditor timeout"}`.
- Verdict existed in streamed output; timeout wrapper never read it → UI showed approved+rejected simultaneously.

**Fix scope (YAGNI — nothing else):** timeout handler in `goal-auditor.ts` reads already-captured streamed output, parses verdict via existing `parseAuditorDecision`, returns verdict instead of timeout error when a marker is present. No async audit, no posture state, no wake system.

Existing building blocks (DO NOT rebuild):
- `parseAuditorDecision(output)` — exported, last-marker-wins parser (goal-auditor.ts:144)
- `outputParts` + `textDeltaAccum` — streamed text buffers populated by `session.subscribe` (goal-auditor.ts:~1180-1195) BEFORE `session.prompt()` resolves
- Timeout handler — goal-auditor.ts:~1316 (`setTimeout` → `safeAbort()` → `timeoutReject`)

## DOD (Definition of Done)

- [x] Audit that produces a verdict marker before the 30min timeout completes with that verdict, not a timeout error.
- [x] Audit with NO marker at timeout still returns the existing timeout error (behavior preserved).
- [x] Tests cover approved-recovery, disapproved-recovery, no-verdict-timeout paths.
- [x] PR created, verifier-loop passed, merged.

## Tasks

### Implementation
- [x] `timeout-verdict-recovery`: goal-auditor.ts timeout path returns `parseAuditorDecision(joinedOutput)` result when a marker exists in `outputParts`+`textDeltaAccum`, else existing timeout error. Probe: rg "recovered" goal-auditor.ts timeout handler region.
- [x] `trace-recovery-entry`: auditor-trace.jsonl gains entry `{phase:"timeout", verdictRecovered:<verdict>}` when recovery triggers. Probe: rg "verdictRecovered" extensions/.

### Tests
- [x] `test-recover-approved`: unit test — timeout fires, streamed output ends `<approved/>` → result `{approved:true}`, no timeout error.
- [x] `test-recover-disapproved`: unit test — timeout fires, output ends `<disapproved/>` → `{disapproved:true}`.
- [x] `test-timeout-no-verdict`: unit test — timeout fires, no marker → existing timeout error string unchanged.

### Delivery
- [x] `verifier-loop-passed`: implementing agent ran suite (13/13 new file); independent review re-ran new tests 3/3 + full suite + main-baseline diff → zero new failures.
- [x] `pr-created-merged`: PR #70 squash-merged as 1b17cf6, branch deleted, main synced.

## Idempotency
Re-running `/10-plan-declarative` on same requirement reconciles to THIS plan.
Implemented items auto-marked `- [x]`. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads
- (none)

## Delegation

Implementer: `agy -p` (Anthropic CLI) — reference = this plan file.
Contract: surgical scope (items above ONLY), verifier-loop pass, PR, stop.
