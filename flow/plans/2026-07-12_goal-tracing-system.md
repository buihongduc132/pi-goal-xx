# Plan — Unified logging & tracing system for pi-goal-xx

## ID
2026-07-12-goal-tracing

## Summarize
A crash-safe, structured JSONL tracing layer (`goal-trace.jsonl`) covering every
step of the goal lifecycle — all 13 tools, all `/goal*` commands, focus-lock
ops, auto-run, heartbeat, `syncGoalTools`, `tool_call` blocks, reconciliation
drift, lock-release, and hook dispatch — so the recurring crashes / exits /
silent failures leave a forensic trail.

## Motivation
The project suffered multiple crash/exit bugs (PR #21, #24) with **no logging**
on most code paths. Pre-existing sinks covered only part of the surface:
- `goal_events.jsonl` (ledger) — event-sourced lifecycle milestones; MUST NOT
  rotate.
- `auditor-trace.jsonl` — rotating forensic trace, scoped to `complete_goal`
  audit only.

Gaps (from a full inventory): 9 of 13 tools had zero tracing; focus-lock
failures were `console.warn`-only; `syncGoalTools`, auto-run chokepoint,
`tool_call` blocks, reconciliation drift, and 3 lock-release sites swallowed
errors silently.

## Design
**Reuse, don't rebuild.** New `extensions/goal-trace.ts` mirrors `auditor-log.ts`:
- `logGoalTrace(cwd, entry, sink?)` — sync `appendFileSync` + `rotateIfNeeded`
  (10MB × 3), wrapped in `try/catch{}` → **never throws** (project invariant #1).
- `traceStep(step, cwd, fn, opts)` — wraps any sync/async op: emits start/end
  (with `durationMs`) or error; passes return/throw through unchanged.
- `wrapExecuteWithTrace(step, fn, {getSink, fallbackCwd})` — shared helper for
  registration chokepoints.

**Three DRY insertion strategies:**
- A. Tool spans via `regTool` → covers all 11 goal tools + 2 questionnaire tools.
- B. Command spans via `wrapCmdDef` → covers every `/goal*`, `/goals`, `/sisyphus`.
- C. Point-logging at blind spots: focus-lock (7 sites), syncGoalTools (2),
  auto-run block, heartbeat lock-loss, tool_call blocks (2), reconcile drift,
  3 lock-release silent catches, hook-loader (import/pre/post/override).

**Settings:** new `logging` section (`GoalLoggingConfig { level?, toStderr? }`)
following the `asCommandHooksBlock` pattern: interface + `ALLOWED_SETTINGS_KEYS`
+ `asLoggingConfig` coercer + parse/load/save wiring + `PI_GOAL_LOG_LEVEL` env.
Default level `info`; `off` disables all trace writes. Level floor gates only
free-form `event` entries — span skeleton (start/end/error) always emits so step
boundaries are never lost to a level filter.

## Non-goals (preserved invariants)
- `goal_events.jsonl` ledger: untouched (event-sourced, no rotation).
- `auditor-trace.jsonl`: untouched (already rotating).
- All trace writes best-effort + sync + never-throw.

## Tests
`tests/goal-trace.test.ts` (20 tests): low-level never-throws / append / level
filtering / `resolveTraceSink` / `previewBytes`+`previewError` / `traceStep`
(sync+async, success+error, OFF sink, context propagation) /
`wrapExecuteWithTrace` (cwd recovery, fallback, rethrow, OFF) / rotation reuse /
integration via `_harness.ts` (get_goal span, cmd span, `off` disables). Plus
`goal-settings.test.ts` extended with logging parse/round-trip/env tests.

Full suite: 1035 tests, 0 fail. `tsc --noEmit` clean.
