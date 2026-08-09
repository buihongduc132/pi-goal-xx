# Counterfactual: `terminate: true` in `complete_goal` return value

**Date:** 2026-07-14
**Task:** #5 (counterfactual investigation)
**Repo:** `/home/bhd/Documents/Projects/bhd/pi-goal-xx`
**Verdict:** `terminate: true` is **NOT** the cause of "pi exits after completion." It ends the agent *autonomy loop* and returns control to the user; it does **not** exit the process. The two "terminate" concepts are distinct and pi-core does **not** conflate them.

---

## 1. The approved-path return of `complete_goal.execute`

`extensions/goal.ts` lines **3657–3667** (auditor-approved path):

```js
return {
    content: [{
        type: "text",
        text: buildCompletionReport({
            detailedSummary: detailedSummary(state.goal),
            completionSummary: params.completionSummary,
            auditorReport: auditor.output,
            taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
        }),
    }],
    details: goalDetails(state.goal),
    terminate: true,
};
```

Yes, it sets `terminate: true`.

## 2. EVERY return site of `complete_goal.execute`

`complete_goal` spans `name: "complete_goal"` (line 3127) → closing of `execute` (line 3667). 15 return sites enumerated:

| # | Path | `terminate: true`? | Notes |
|---|------|--------------------|-------|
| 1 | Length-cap rejection (overlong summary) | ❌ no | top of execute |
| 2 | `completionGate` rejection | ❌ no | |
| 3 | `taskWarning` (pending tasks block) | ❌ no | |
| 4 | `contractGate` rejection | ❌ no | |
| 5 | `writeResult3` rollback (per-goal-disabled disk-write fail) | ❌ no | |
| 6 | **Per-goal auditor disabled** (`auditTarget.skipAuditor`) | ✅ **YES** (line 3293) | goal completed |
| 7 | Global `settings.disabled`, user not yet confirmed (asks to bypass) | ❌ no | asks user |
| 8 | `writeResult4` rollback (settings-disabled disk-write fail) | ❌ no | |
| 9 | **Global settings disabled + bypass confirmed** | ✅ **YES** (line 3372) | goal completed |
| 10 | Escape dialog → `complete_without_audit` | ❌ no | goal completed but NO terminate |
| 11 | Escape dialog → continue working (pause) | ❌ no | |
| 12 | `writeResult5` rollback (escape-bypass disk-write fail) | ❌ no | |
| 13 | **Auditor rejected** (`!auditor.approved`) | ❌ **no** | goal stays open |
| 14 | `writeResult6` rollback (approved-path disk-write fail) | ❌ no | |
| 15 | **Auditor approved** | ✅ **YES** (line 3665) | goal completed |

**Pattern:** `terminate: true` is set on exactly **3 of 15** paths — all three are "goal successfully marked complete" flows (#6 per-goal-disabled, #9 global-settings-disabled+bypassed, #15 auditor-approved). Notably:
- The **reject** path (#13) does NOT set it (correct: agent should keep working).
- The **Escape bypass** path (#10) does NOT set it, even though the goal is completed — that is an *inconsistency* (likely a latent bug, but a cosmetic one: the agent would just make one more turn before stopping).

## 3. Comparison with upstream `tmonk/pi-goal-x`

`git show upstream/main:extensions/goal.ts` — upstream `complete_goal` approved path (lines 2718–2731):

```js
updateUI(ctx);
return {
    content: [{
        type: "text",
        text: buildCompletionReport({
            detailedSummary: detailedSummary(state.goal),
            completionSummary: params.completionSummary,
            auditorReport: auditor.output,
            taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
        }),
    }],
    details: goalDetails(state.goal),
    terminate: true,
};
```

**Upstream ALSO returns `terminate: true` on approval** (confirmed — upstream-diff teammate was correct). Upstream has 8 `terminate: true` sites vs pi-goal-xx's 8; the complete_goal approved path is identical. This is **inherited, intended upstream behavior**, not a pi-goal-xx regression.

## 4. The pi-core consumer of the `terminate` field

File: `@earendil-works/pi-agent-core/dist/agent-loop.js`

### 4a. Decision function (line 345)
```js
function shouldTerminateToolBatch(finalizedCalls) {
    return finalizedCalls.length > 0
        && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```
Returns `true` only if **every** tool result in the batch set `terminate: true`.

### 4b. The batch return (lines 296, 341)
```js
return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
};
```

### 4c. The agent loop (lines 116–119) — **the only behavioral effect**
```js
const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
toolResults.push(...executedToolBatch.messages);
hasMoreToolCalls = !executedToolBatch.terminate;   // ← THE effect
```

Then later in the loop:
```js
// Agent would stop here. Check for follow-up messages.
const followUpMessages = (await config.getFollowUpMessages?.()) || [];
if (followUpMessages.length > 0) { pendingMessages = followUpMessages; continue; }
break;                          // ← exit the while loop
```
await emit({ type: "agent_end", messages: newMessages });
```

**What pi-core DOES when a tool returns `terminate: true`:**
- Sets `hasMoreToolCalls = false`.
- Skips requesting another LLM assistant turn.
- Emits `agent_end` and **returns** from `runAgentLoop()` to its caller.

**This is option (a): end the current agent turn and return control to the caller (the interactive TUI / harness), which keeps the process alive awaiting the next user input.** It is NOT option (b) process exit.

### 4d. afterToolCall hook can override it (agent-loop.js line 456)
```js
if (afterResult) {
    result = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
        terminate: afterResult.terminate ?? result.terminate,   // hook can override
    };
    isError = afterResult.isError ?? isError;
}
```
The harness `tool_result` hook (`harness/agent-harness.js` line 380) forwards `patch.terminate` — so an extension *could* force `terminate`, but none in pi-goal-xx does.

### 4e. No `process.exit` is tied to `terminate`
`grep -rn "process.exit" pi-agent-core/dist --include='*.js'` (excluding `.map`) → **zero hits**. The only `exitCode` references in the package are bash-command exit codes and shell-output handling — unrelated to tool-result `terminate`. **pi-core never translates `terminate: true` into process exit.**

## 5. Counterfactual answer

**"If `complete_goal` returned `terminate: false` on the approved path, would the pi process stay alive after completion?"**

The pi process already **stays alive** with `terminate: true`. The premise of the question is wrong. `terminate: true` does not kill the process — it ends the *agent autonomy loop* and hands control back to the user. That is the normal, correct terminal state of a completed goal: the agent stops autonomously calling tools and waits for the next human instruction.

If the approved path returned `terminate: false` instead:
- `hasMoreToolCalls` would be `true` → pi-core would request **another** LLM turn.
- The model would receive the completion report as its tool result and would likely continue working — calling more tools, re-reading files, or calling `complete_goal` again (which would then hit `validateGoalCompletion` and reject, since status is already `complete`).
- The process would **still stay alive** (terminate never exited it). The agent would simply run one or more extra (wasteful, possibly confusing) turns before the model decided to stop on its own or the user interrupted.
- **It would NOT fix any "exit" symptom** — if anything, `terminate: false` makes the agent *run longer*, the opposite of exiting.

### KEY DISTINCTION — verified

There are two unrelated "terminate" concepts:

| Concept | Meaning | Mechanism | Causes process exit? |
|---------|---------|-----------|----------------------|
| (1) Tool-result `terminate: true` | End the agent autonomy loop; return control to user | `hasMoreToolCalls = !executedToolBatch.terminate` → `agent_end` → `break` | **No** |
| (2) Process exit | Node process terminates | `process.exit(n)`, uncaught throw, `unhandledRejection` | Yes |

pi-goal-xx means **concept (1)**. pi-core implements **concept (1)** and does **not** conflate it with (2). There is no code path in `pi-agent-core` that turns `terminate: true` into `process.exit`.

## 6. Conclusion / recommendation

- **Eliminate `terminate: true` as the prime suspect.** It is upstream-intended, ends the agent loop cleanly, and keeps the process alive.
- The actual "pi exits after completion" symptom (if real) must originate from a **concept (2)** source: an uncaught rejection, a thrown error, or a literal `process.exit` reached on the completion path. The known prime candidates are documented in `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` (auditor `inheritFromCwd` hang/exit; bare `pi.sendMessage` without `.catch()` → unhandledRejection → exit). The crash-safe-auditor-inheritance work (R1–R6) targets those.
- **Minor latent bug (not the symptom):** Escape-dialog `complete_without_audit` path (#10) marks the goal complete but omits `terminate: true`, unlike the other two completion paths. Cosmetic — agent makes one extra turn. Worth aligning for consistency but unrelated to process exit.

## Evidence files

- `extensions/goal.ts:3127-3667` (complete_goal execute, all 15 returns)
- `extensions/goal.ts:3657-3667` (approved-path return)
- upstream `extensions/goal.ts:2718-2731` (upstream approved-path return — identical `terminate: true`)
- `@earendil-works/pi-agent-core/dist/agent-loop.js:116-119` (hasMoreToolCalls effect)
- `@earendil-works/pi-agent-core/dist/agent-loop.js:345` (`shouldTerminateToolBatch`)
- `@earendil-works/pi-agent-core/dist/agent-loop.js:456` (afterToolCall override)
- `@earendil-works/pi-agent-core/dist/harness/agent-harness.js:380` (hook forwards terminate)
- `grep process.exit pi-agent-core/dist` → zero hits (no conflation)
