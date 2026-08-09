# Log Forensics — pi Process Exit After Goal Completion

**Date:** 2026-07-14
**Probe dir:** `/tmp/pi-exit-probe`  (tmux session `pi-probe`, now EXITED)
**Goal under test (succeeded):** `mrkb54sx-d06lbn` — "Create the file probe-done.txt ... then complete."
**Bug under investigation:** after the auditor approves completion, the ENTIRE pi process exits (not just the turn).
**Analyst:** teammate `log-forensics` (read-only; no code edited, no tmux mutation, no `complete_goal` calls).

---

## TL;DR — Verdict

| # | Question | Answer |
|---|----------|--------|
| 1 | Did pi exit after goal completion? | **YES.** Goal completed `07:07:38.561Z`; process gone by poll at `07:07:55Z` (Δ ≤ ~17 s). |
| 2 | Is the cause `complete_goal`'s `terminate: true`? | **NO.** `terminate:true` only ends the *tool-call batch* within the turn (`agent-loop.js:124` `hasMoreToolCalls = !executedToolBatch.terminate`). It never calls `process.exit()`. The process wrote 3 more session entries AFTER the toolResult, then died — impossible if `terminate:true` exited the process. |
| 3 | Counterfactual: would `terminate:false` have prevented the exit? | **NO.** The exit cause is independent of `terminate`. With `terminate:false` the agent would have made one extra model round-trip and the process would still have exited. |
| 4 | What caused the exit? | A **clean, silent termination** (exit code unknown — likely `0`). **No** unhandled rejection / uncaught exception / OOM / SIGKILL anywhere. Most consistent with the **in-process auditor's session teardown** (after `agent_settled` `07:07:38.548Z`) closing shared host handles that kept the event loop alive — the "exit" half of documented bug `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` Bug 1. The G1/G2/G3 process guards installed in `goal-auditor.ts` only cover `unhandledRejection`/`uncaughtException`; they do **not** cover handle draining. |

---

## (a) Every log source read + final-state excerpt

### Source 1 — `/tmp/pi-exit-probe/pi-stdout.log`
**ABSENT.** pi was launched as `pi` inside tmux with no stdout redirection. `poll.log` confirms: `tail: cannot open '/tmp/pi-exit-probe/pi-stdout.log' for reading: No such file or directory`. **No stderr/stdout was captured to a file** — this is the single biggest forensic gap. Exit code is therefore not recoverable.

### Source 2 — `/tmp/pi-exit-probe/.pi/goals/goal_events.jsonl` (full lifecycle)
```
07:01:55.695 goal_created      mrkazn1r-zoiqsr  "run the complete_goal immediately"   ← operator's FIRST probe (agent refused to complete; cleared)
07:06:11.985 goal_created      mrkb54sx-d06lbn  "Create the file probe-done.txt ... then complete."
07:06:54.819 completion_requested mrkb54sx-d06lbn
07:06:54.819 audit_started     mrkb54sx-d06lbn
07:07:38.549 audit_result      mrkb54sx-d06lbn  verdict=approved  <approved/>
07:07:38.561 goal_completed    mrkb54sx-d06lbn  archivePath=.../goal_2026071414073855_mrkb54sx-d06lbn.md
```
**No error/exit marker after `goal_completed`.** The lifecycle ledger ends cleanly on the approved path. (Note: the originally-cited goal `mrkazn1r-zoiqsr` was a meta-probe the agent refused to complete; the operator `/goal-clear`-ed it at `07:06:08.971` and set the real goal.)

### Source 3 — `/tmp/pi-exit-probe/.pi/goals/auditor-trace.jsonl` (193 lines)
**Completely clean.** Tail:
```
07:07:38.403 phase=event eventType=turn_end
07:07:38.548 phase=event eventType=agent_end
07:07:38.548 phase=event eventType=agent_settled
07:07:38.549 phase=end  goalId=mrkb54sx-d06lbn  approved=true  disapproved=false  model=bhd-litellm/role-smart  elapsedMs=43729  outputBytes=988
```
Auditor (an in-process child agent, see Source 8) settled normally in 43.7 s. `grep -iE "error|fail|crash|exit|reject|exception|timeout|abort"` → **only the benign `argsPreview` for the auditor's own `ls/cat/wc` bash verification**, no failure markers.

### Source 4 — `/tmp/pi-exit-probe/.pi/goals/goal-trace.jsonl`
```
07:06:54.818 tool.complete_goal  start  (parentSpan 5fc7e02a687e106d)
07:07:38.551 tool.complete_goal  end    durationMs=43733  status=OK
```
`complete_goal` tool span closed with **status=OK** (not ERROR). The 43.7 s duration is exactly the auditor run.

### Source 5 — Pi SESSION log (the smoking gun)
File: `~/.pi/agent/sessions/--tmp-pi-exit-probe--/2026-07-14T07-00-37-797Z_019f5f6d-7925-773a-be10-38626f650a4d.jsonl` (80 lines total). **Final 6 entries:**
```
07:07:38.549Z  custom          pi-goal-state
07:07:38.550Z  custom          pi-goal-state
07:07:38.552Z  message         role=toolResult  tool=complete_goal   (text: "Goal audit approved. ... <approved/>")
07:07:38.561Z  custom          pi-goal-focus
07:07:38.563Z  custom_message  pi-goal-audit-event  (contentLen=251)
07:07:38.563Z  custom_message  pi-goal-audit-event  (contentLen=1069)
─── END OF FILE ───
```
`grep -ciE "unhandledRejection|uncaughtException|process.exit|SIGTERM|SIGKILL|crash|exit_code"` = **0**.

**Critical:** there is **no `turn_end` entry** after the `complete_goal` toolResult. The normal post-tool flow would emit `turn_end`; instead the process died between `07:07:38.563Z` and the poll's next sample at `07:07:55Z`. The tool body had already returned (its toolResult + 3 follow-up `appendEntry`/`sendMessage` entries are persisted), so death occurred **after the tool resolved but before the agent loop could emit `turn_end`** — i.e. during the gap where the tool result is folded back into the loop and the turn is finalized.

### Source 6 — OS-level (`journalctl --user`, `dmesg`)
- `journalctl --user` around the window: only unrelated `zcode.desktop` `exitCode:0` lines at `14:08:18`. Nothing for pi/node at `07:07`.
- `dmesg | tail` filtered for `oom|kill|pi|node|signal` → **empty**. **No OOM, no SIGKILL, no segfault.**

### Source 7 — Host global error-handler log
`~/.pi/logs/extensions/pi-global-handler.log` — the host's `process.on('unhandledRejection'|'uncaughtException')` sink (`pi-global-error-handler.ts`, which explicitly **"NEVER calls process.exit()"**).
- `grep -c "2026-07-14T07:0[6-8]"` = **0**.
- The only recent entries are an `EPIPE` storm at `07:14:33` — that is from a *different* pi process (this very session's `console.error` to a closed pipe), **not** from the pi-probe PID, and ~7 minutes after the exit.

**Conclusion:** no unhandled rejection / uncaught exception was captured for the pi-probe process at its exit time. If the exit had been driven by a floating rejection, the (still-attached, host-level) handler would have logged it. It did not.

### Source 8 — Code: `complete_goal` approved path returns `terminate: true`
`extensions/goal.ts:3650-3665` (approved branch):
```ts
setTurnStopped(state.goal?.id ?? null);
resetGetGoalNudgeState(state.goal?.id);
syncGoalTools();
updateUI(ctx);
return {
    content: [{ type: "text", text: buildCompletionReport({ ... }) }],
    details: goalDetails(state.goal),
    terminate: true,          // ← line 3665
};
```
(8 sites in goal.ts return `terminate:true`: lines 2848, 3104, 3293, 3372, **3665** (approved), 3747, 3828, 4016 — all lifecycle-ending tools: draft-create, tweak, complete, pause, abort, etc.)

### Source 9 — Code: pi-core consumer of `terminate`
`@earendil-works/pi-agent-core` `dist/agent-loop.js`:
```js
// :124
hasMoreToolCalls = !executedToolBatch.terminate;
```
`dist/agent-loop.js:378` — `shouldTerminateToolBatch`:
```js
return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
```
`dist/types.d.ts:306-318` — `AgentToolResult<T>.terminate`:
```ts
/**
 * Hint that the agent should stop after the current tool batch.
 * Early termination only happens when every finalized tool result in the batch sets this to true.
 */
terminate?: boolean;
```
**`terminate` is a turn-scoped hint only.** It sets `hasMoreToolCalls=false` so the agent loop stops scheduling further tool round-trips within the turn. It does **not** call `process.exit`, does not tear down the TUI, does not close stdin. After the loop, the interactive TUI remains alive awaiting the next user input.

### Source 10 — Code: auditor runs **in-process** with `inheritFromCwd`
`extensions/goal-auditor.ts`:
- `:437` `inheritFromCwd?: boolean;`
- `:484` `const createSession = args.createSession ?? createAgentSession;`
- `:609` logs `phase:"pre-createSession"` with `extensionsCount:53` — **all 53 host extensions are loaded into the in-process child** (incl. `pi-global-error-handler`, `session-status`, `session-activity`, `pi-print-clean-exit`, MCP adapters, `pi-subagent-cleanup`).
- `:661-662` snapshots `preUnhandledRejectionListeners` / `preUncaughtExceptionListeners` BEFORE createSession.
- `:1228-1258` (outer finally, G1/G2/G3): removes auditor's own guards + any listeners registered *during* the audit window not in the snapshot; explicitly does NOT drain abort() promises (F1 comment).
- `:946` (F1 comment) acknowledges the residual risk verbatim: *"a future refactor could throw ... surfaces as uncaughtException"* and *"floating until the process-level guards (removed in the outer finally) are gone, then hits Node's default unhandledRejection → process.exit(1)"*.

This is the **in-process** auditor — same mechanism named in `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` Bug 1: *"auditor `inheritFromCwd` loads host resources into in-process child → hang/exit"*.

---

## (b) Timestamps — exit vs. goal_completed

| Event | Timestamp (UTC) | Source |
|-------|-----------------|--------|
| `complete_goal` tool span START | `07:06:54.818Z` | goal-trace.jsonl |
| Auditor agent `agent_settled` | `07:07:38.548Z` | auditor-trace.jsonl |
| `audit_result approved` | `07:07:38.549Z` | goal_events.jsonl |
| **`goal_completed`** | **`07:07:38.561Z`** | goal_events.jsonl |
| Last session-log entry (audit-event message) | `07:07:38.563Z` | session .jsonl |
| `complete_goal` tool span END (status=OK) | `07:07:38.551Z` | goal-trace.jsonl |
| Poll iteration 1 (session ALIVE) | `07:02:55Z` | poll.log |
| **Poll iteration 2 (session EXITED)** | **`07:07:55Z`** | poll.log |

**Process died in the window `[07:07:38.563Z, 07:07:55Z]`** — at most ~17 s after `goal_completed`, and within the same sub-second burst as the complete_result finalization. The poll cadence is 5 min, so the true exit instant is bounded only on the upper side by `07:07:55Z`; the session-log truncation at `07:07:38.563Z` (no `turn_end`) places it effectively at or immediately after `07:07:38.56Z`.

---

## (c) Root-cause verdict

### What it is NOT (each eliminated with evidence)

1. **NOT `terminate:true` propagation.** `terminate` is a turn-scope hint; its sole consumer (`agent-loop.js:124`) only flips `hasMoreToolCalls=false`. No `process.exit` in pi-core is gated on `terminate`. Dispositive: the session log contains 3 entries written **after** the `complete_goal` toolResult (the `terminate:true` value is part of that result's envelope) — `pi-goal-focus` + 2× `pi-goal-audit-event` at `07:07:38.561/.563Z`. If `terminate:true` exited the process synchronously on return, those entries could not exist.
2. **NOT an unhandled rejection / uncaught exception.** The host `pi-global-handler` sink (still attached at host level; G2 does not strip host-module-load listeners) recorded **zero** entries in `[07:06, 07:08]`. No `unhandledRejection`/`uncaughtException` string anywhere in the session log.
3. **NOT OOM / SIGKILL / segfault.** `dmesg` clean; `journalctl --user` has nothing for the process.
4. **NOT an auditor failure.** Auditor trace ends `approved:true`, `agent_settled`, status OK, 43.7 s. No error markers.
5. **NOT the documented Bug 1b (bare `pi.sendMessage` reject → exit).** The deployed code uses `safeFireAndForget` (`goal.ts:551-569`) for all post-auditor sends; the auditor trace shows no `send_failure` entries.

### What it IS (best-supported explanation)

A **clean, silent process termination** occurring in the narrow window after the `complete_goal` tool body returns and before `turn_end` is emitted. Given the elimination above, the only remaining class is **event-loop draining / explicit clean exit triggered by the in-process auditor's session teardown**:

- The auditor is spawned **in-process** via `createSession({ inheritFromCwd })`, loading all **53 host extensions** (`goal-auditor.ts:609`) into the same Node process as the host TUI.
- When the auditor agent settles (`07:07:38.548Z`), the in-process session is torn down in the outer finally. The G1/G2/G3 guards only remove *listener functions*; they do **not** restore/protect shared **handles** (stdin raw mode, the TUI input reader, MCP stdio watchers, timers) that 53 host extensions may have attached *during* the audit window or that the in-process session's shutdown closes.
- If the in-process auditor's session shutdown closes (or the audit-window extensions never re-armed) a handle the host TUI depends on to keep the event loop alive, Node's loop drains and the process exits **with code 0** — synchronously, with no error output and no session-log entry. That signature matches the observed truncation exactly: last entry is a tool-body `sendMessage`, no `turn_end`.

This is the **"exit" symptom of documented Bug 1** (`flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md`). The crash-safe-auditor inheritance work (`flow/requirements/2026-07-11_crash-safe-auditor-inheritance.md`) mitigated the *rejection/exception* paths (G1/G2 + `safeFireAndForget`) but did **not** cover the *handle-draining* path. The `goal-auditor.ts:1228` comment block explicitly flags the residual risk: *"an out-of-process auditor is the only way to fully isolate side effects (timers, globalThis mutations, other event names). Residual risk documented."*

### Confidence
- **High** that the exit is clean (no rejection/exception/OOM) and **not** caused by `terminate:true`.
- **Medium** on the precise handle that drained. Because no `pi-stdout.log` was captured, the exact exit code and any final `console.error`/stack are unrecoverable. A definitive root cause requires a reproduction with `pi 2>&1 | tee pi-stdout.log` plus `NODE_OPTIONS=--trace-uncaught` (or `--trace-exit`) to see what closed the last handle.

---

## (d) Counterfactual answer (the asked question)

> *"If `complete_goal` returned `terminate:false` (or omitted it) on the approved path, would pi still exit after completion?"*

**Yes, pi would still exit.** `terminate` is orthogonal to process lifetime:

- Definition (`pi-agent-core dist/types.d.ts:311-318`): *"Hint that the agent should stop after the current tool batch."*
- Sole consumer (`agent-loop.js:124`): `hasMoreToolCalls = !executedToolBatch.terminate;` — affects only whether the agent schedules another in-turn model/tool round-trip. It has zero effect on process/TUI lifetime.
- The exit is driven by the in-process auditor teardown (independent of the tool's return envelope). Setting `terminate:false` would at most cause one additional (likely no-op) model call before the same teardown killed the process.

**Recommendation (out of scope — no code touched):** the durable fix is the one the source code already names — move the auditor **out-of-process** (subprocess/worker) so its session lifecycle cannot touch host handles. Short of that, capture stdout/stderr to a file in every reproduction so exit code + final stack are recoverable, and consider `--trace-exit` on the probe to identify the final handle.

---

## Evidence index (file:line)

| Claim | Location |
|-------|----------|
| `complete_goal` approved returns `terminate:true` | `extensions/goal.ts:3665` |
| `terminate` is a turn-batch hint | `pi-agent-core/dist/types.d.ts:311-318` |
| `terminate` consumer = `hasMoreToolCalls` flip | `pi-agent-core/dist/agent-loop.js:124`, `:378` |
| `shouldTerminateToolBatch` semantics | `pi-agent-core/dist/agent-loop.js:376-378` |
| Auditor runs in-process, 53 host extensions | `extensions/goal-auditor.ts:437, :484, :609` |
| G1/G2/G3 listener-only cleanup (residual risk) | `extensions/goal-auditor.ts:1228-1258` |
| F1 floating-rejection residual risk acknowledged | `extensions/goal-auditor.ts:940-947` |
| `safeFireAndForget` (Bug 1b fix) | `extensions/goal.ts:551-569` |
| Host error handler never exits, logs to file | `~/.pi/agent/extensions/pi-global-error-handler.ts` |
| Documented Bug 1 (inheritFromCwd → exit) | `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` |
| Session log truncation (no `turn_end`) | `~/.pi/agent/sessions/--tmp-pi-exit-probe--/2026-07-14T07-00-37-797Z_019f5f6d-*.jsonl` (line 80, last entry `07:07:38.563Z`) |
