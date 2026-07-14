# OTEL-style Exit Capture — Implementation Note

> Date: 2026-07-14
> Author: teammate `w1-otel-proof` (task #2)
> Status: **IMPLEMENTED, validation PASSED** (commit-ready, not committed)
> Bug ref: `flow/bugs/2026-07-14_pi-process-exits-after-completion.md`

## What was added (additive logging ONLY — zero behavior change)

The bug is that the in-process **goal auditor child session** inherits the host's
`pi-print-clean-exit` extension, runs headless, and on its `agent_end` arms a
1500 ms `setTimeout` that later calls `process.exit(0)` — killing the host TUI
~1 s after `complete_goal`. It was only proven via `NODE_OPTIONS=--trace-exit`.

This change adds a lightweight JSONL forensic trace so the bug is provable
**deterministically, without `--trace-exit`**, and the captured log becomes the
regression fixture + deploy proof artifact.

### Files modified

#### 1. `pi-plugins/profile/extensions/pi-print-clean-exit/index.ts`

Added an inert `traceLog(phase, fields, ctx?)` helper (top-level `import * as fs`
+ `node:path`) that appends one JSON line per event. Every call is wrapped in
`try/catch` — logging **cannot** throw, cannot change the exit decision, and
cannot itself call `process.exit`/reject.

**Log path resolution** (priority):
1. env `PI_PRINT_CLEAN_EXIT_TRACE` (absolute — for test harness / leader probe)
2. `${ctx.cwd}/.pi/print-clean-exit-trace.jsonl`
3. cached `lastTracePath` (so `safeExit`, which has no `ctx`, can still emit)

Five trace points:

| Phase | Where | Proves |
|-------|-------|--------|
| `agent_end_seen` | top of `pi.on("agent_end")` — BEFORE the headless guard | Fires in BOTH auditor child (headless) AND interactive host. `mode`/`isHeadless` field distinguishes them. |
| `arm_clean_exit` | `armCleanExit()`, before `setTimeout` | WHO armed the killer timer. Fields: `mode`, `hasPending`, `exitGraceMs`, `exitCode`, `pid`, `ppid`. |
| `safe_exit` | `safeExit()`, before `process.exit` | WHO actually called `process.exit`. Correlate by `pid`. |
| `disarm` | `pi.on("agent_start")` | A new turn cancelled the timer (proves "no new turn → no disarm → timer fires"). |
| `agent_end_seen` also carries `isHeadless` so you can see the auditor child's headless arm even though the *host* is interactive. |

No exported API changed. `__test__` export unchanged (`computeExitCode`,
`isHeadlessMode`, `EXIT_GRACE_MS`). Existing 12 unit tests still pass (the 1
failing test `EXIT_GRACE_MS >= 2000` is **pre-existing** — the constant is 1500
at HEAD and is unrelated to this change; do not touch it, it is out of scope).

#### 2. `pi-goal-xx/extensions/goal-auditor.ts`

Inside the existing `session.subscribe(...)` forensic-trace `try/catch` block
(right after the existing `logAuditorTrace(..., buildEventEntry(...))` call),
added an additional `logAuditorTrace` entry when `event.type === "agent_end"`:

```jsonc
{ "phase": "auditor_agent_end", "source": "goal-auditor",
  "goalId": "<id>", "pid": <pid>, "ppid": <ppid> }
```

This writes to the **existing** `<cwd>/.pi/goals/auditor-trace.jsonl` (sibling
file, no new path). It proves the auditor child session **emitted** `agent_end`
— the trigger that the inherited `pi-print-clean-exit` arms on. Protected by
the existing surrounding `try/catch` — inert.

## How the leader produces the proof log

You don't need `--trace-exit`. Run a real goal completion in the TUI; after the
host dies ~1 s post-`complete_goal`, two files tell the full story:

1. **`<cwd>/.pi/print-clean-exit-trace.jsonl`** — the killer's own confession.
2. **`<cwd>/.pi/goals/auditor-trace.jsonl`** — the auditor's `agent_end` event.

### The deterministic proof (correlate by `pid`)

```
# In auditor-trace.jsonl:
{ "phase":"auditor_agent_end", "goalId":"...", "pid":<HOST_PID>, "ppid":<SHELL_PID>, ... }
                       │ same pid │
# In print-clean-exit-trace.jsonl:
{ "phase":"agent_end_seen", "pid":<HOST_PID>, "mode":"print", "isHeadless":true, "hasPending":false }
{ "phase":"arm_clean_exit", "pid":<HOST_PID>, "mode":"print", "exitGraceMs":1500, "exitCode":0 }
   ... ~1500 ms later ...
{ "phase":"safe_exit",      "pid":<HOST_PID>, "code":0 }   ← host dies here
```

**The smoking gun:** the `agent_end_seen` / `arm_clean_exit` lines have
`mode:"print"` + `isHeadless:true` while the host is an **interactive** TUI.
That means a headless ctx — i.e. the in-process auditor child — armed the timer
in the host process, and the same `pid` later shows `safe_exit`. No
`--trace-exit` needed.

### Optional: force a known log path for the probe

```sh
PI_PRINT_CLEAN_EXIT_TRACE=/tmp/pce-probe.jsonl pi
```

## NON-pi validation (already run — ALL CHECKS PASSED)

A harness at `/tmp/pce-validate.ts` (run with `bun`) loads the extension's
default export, drives `agent_end` with a fake headless ctx, stubs
`process.exit` so the process survives, waits 1900 ms, and asserts the trace
file contains `agent_end_seen` + `arm_clean_exit` + `safe_exit` with
`exit code 0`. Captured output:

```
{"phase":"agent_end_seen","source":"pi-print-clean-exit","pid":882347,"ppid":882346,"mode":"print","hasPending":false,"isHeadless":true}
{"phase":"arm_clean_exit","source":"pi-print-clean-exit","pid":882347,"ppid":882346,"mode":"print","hasPending":false,"exitGraceMs":1500,"exitCode":0}
{"phase":"safe_exit","source":"pi-print-clean-exit","pid":882347,"ppid":882346,"code":0}
RESULT: ALL CHECKS PASSED
```

(Note: two `safe_exit` lines appear in the real run — the armCleanExit timer
has BOTH a `stdout.write` callback AND a 200 ms fallback that each call
`safeExit`. This is pre-existing behavior, now simply visible in the log; it
does not affect the exit code.)

## Verifier angles (self-checked)

- **Angle A (scope):** `agent_end_seen` fires for EVERY `agent_end` (before the
  headless guard), so it logs in both the auditor child (headless) and a real
  top-level `pi -p` invocation. The `mode` + `isHeadless` + `pid` fields let you
  tell them apart and correlate with `auditor_agent_end`.
- **Angle B (logic / inertness):** `traceLog` is fully `try/catch`'d, uses only
  `fs.appendFileSync` + `mkdirSync`, and never calls `process.exit`. The
  validation harness confirms no unhandled rejection / crash. If the path can't
  be resolved, `traceLog` returns silently (no throw).
- **Angle C (purity):** No control-flow change. The `hasPending` computation was
  hoisted above the headless guard only so it could be logged — its value and
  effect are identical (same early-return). `armCleanExit` gained an optional
  `hasPending` param (default `false`) passed through to the log only. 12/13
  pre-existing tests pass; the 1 failure predates this change.

## Deliverables

1. ✅ `pi-plugins/profile/extensions/pi-print-clean-exit/index.ts` — modified (commit-ready)
2. ✅ `pi-goal-xx/extensions/goal-auditor.ts` — modified (commit-ready)
3. ✅ `/tmp/pce-validate.ts` — NON-pi validation harness (passed)
4. ✅ This note

**Not done (out of scope, per task):** did NOT commit, did NOT spawn pi/tmux,
did NOT modify the bug logic, did NOT call `complete_goal`.
