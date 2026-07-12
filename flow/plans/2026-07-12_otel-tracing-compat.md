# Plan — OTel-compatible tracing + remove all console.*

## ID
2026-07-12-otel-tracing-compat

## Summarize
Make the goal-trace logger emit **OpenTelemetry-shaped** JSONL (no new deps) and
route ALL logging through the module — zero `console.*` calls in `extensions/`.

## Why
PR #26 added the crash-safe tracing layer. This follow-up makes the output
ingestible by OTel collectors (traceId/spanId/parentSpanId/spanKind/status/attrs)
so spans reconstruct into a real trace tree, and closes the last loophole:
diagnostics that bypassed the module via `console.warn/error`.

## Design (no new dependencies)

### OTel-shaped JSONL — extensions/goal-trace.ts
Additive OTel fields stamped at emit time on every line:
- `traceId` (W3C 32-hex), `spanId` (16-hex) — generated per span, shared by the
  start+end/error pair so a collector correlates them into one span.
- `parentSpanId` — links nested spans into a tree.
- `spanName` (= step), `spanKind` (INTERNAL/CLIENT/SERVER/...), `status`
  (UNSET/OK/ERROR + statusMessage), `attrs` (semantic-convention bag).

**Context propagation:** a module-private `AsyncLocalStorage` (node:async_hooks,
built-in) holds the active span. `traceStep` generates ids, resolves the parent
from the store, and runs `fn` inside `store.run({traceId,spanId})` so nested
calls chain automatically — even across `await`. Zero overhead when sink is OFF
(early-return before context push).

**Id generation:** `crypto.randomBytes` (node:crypto, built-in), try/catch with
a timestamp fallback. W3C-valid (never all-zero). Exported `newTraceId`/
`newSpanId`/`isValidTraceId`/`isValidSpanId`/`getCurrentSpan`.

**Backward compat:** OTel fields are additive; existing call sites/tests
unchanged. `goalId`/context fields are also copied into `attrs` for OTel
consumers.

### Remove all console.* (13 sites)
- `goal-lock.ts` (7): every lock-failure console.warn removed; `logGoalTrace`
  is now the sole sink.
- `goal.ts` (6): syncGoalTools (2), heartbeat, lock.release_failed,
  auto_run.blocked, and the held-by-other warn (converted to a trace entry).
- `grep "console\.(log|error|warn|info|debug)" extensions/` → **zero**.
- Permanent guard: `tests/no-console.test.ts` greps source (comments stripped)
  and fails on any console call.

### spanKind wiring
- `regTool` → `spanKind:"CLIENT"` (tools invoke the host/model).
- `wrapCmdDef` → `spanKind:"SERVER"` (commands are user-initiated).
- Point-logging sites default INTERNAL (no change).

## Tests
`tests/goal-trace.test.ts` extended (+17 OTel tests): id generation/validation,
OTel fields on entries, pair correlation (shared traceId+spanId, status OK/ERROR),
parent linking (nested sync + async, getCurrentSpan), spanKind via
wrapExecuteWithTrace. New `tests/no-console.test.ts` guard.
Full suite: **1122 pass / 0 fail**. `tsc --noEmit` clean.

## Delivery
Worktree `pi-goal-xx-wt-otel` on `feat/otel-tracing`. verifier-loop → PR → merge.
