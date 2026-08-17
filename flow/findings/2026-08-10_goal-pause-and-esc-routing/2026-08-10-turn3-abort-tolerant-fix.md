# Explore Turn 3 — Abort-Tolerant Fix Applied

> Date: 2026-08-10
> Phase: fix (RED→GREEN)
> Status: complete — 4 edits applied, typecheck passes

## [user]

No , if it aborted , we are not even skipping , just fucking continue ;

We are NOT needing it to stop ;

(verbatim — trust chain L1)

## [assistant]

Got it. On abort → continue, don't pause. Fix the 3 abort-detection sites.

Reading exact blocks + tests + impact first:

```
$ read extensions/goal.ts offset=3935 limit=12
$ read extensions/goal.ts offset=3984 limit=10
$ read extensions/goal.ts offset=4186 limit=12
$ ls tests/ 2>/dev/null | head -30; echo ---; grep -rln "isAbortedAssistantMessage\|pauseActiveGoal\|hasAbortedAssistantMessage\|pauseOnAbort\|signal.aborted" tests/ 2>/dev/null | head
```

Line numbers stale. Re-grep fresh:

```
$ grep -n "isAbortedAssistantMessage\|hasAbortedAssistantMessage\|pauseActiveGoal\|ctx.signal.*aborted" extensions/goal.ts
$ grep -rln "isAbortedAssistantMessage\|pauseActiveGoal\|hasAbortedAssistantMessage\|signal.aborted\|pauseOnAbort" tests/ 2>/dev/null
$ grep -n "pauseOnAbort\|abort" extensions/goal-settings.ts 2>/dev/null; echo ---; grep -n "pauseOnAbort\|abort" extensions/prompts/goal-prompts.ts 2>/dev/null | head
```

No tests cover abort-pause behavior. Safe to change. Reading exact contexts:

```
$ read extensions/goal.ts offset=4585 limit=15
$ read extensions/goal.ts offset=4655 limit=10
$ read extensions/goal.ts offset=4883 limit=22
$ read extensions/goal.ts offset=1575 limit=15
```

All 3 sites confirmed + 1 audit-escape bug (F1). No tests cover this. Applying fixes:

```
$ edit extensions/goal.ts edits=[4 edits]
```

First edit failed (whitespace mismatch). Re-checking:

```
$ awk 'NR==4589,NR==4593' extensions/goal.ts | cat -A | head -10
$ awk 'NR==4657,NR==4661' extensions/goal.ts | cat -A
$ awk 'NR==4895,NR==4902' extensions/goal.ts | cat -A
$ awk 'NR==3937,NR==3945' extensions/goal.ts | cat -A
```

Tabs confirmed. Re-applying:

```
$ edit extensions/goal.ts edits=[3 edits — message_end, agent_end, audit-escape]
$ edit extensions/goal.ts edits=[1 edit — turn_end]
```

Verifying + typecheck:

```
$ grep -n "pauseActiveGoal\|isAbortedAssistantMessage\|hasAbortedAssistantMessage" extensions/goal.ts
$ npx tsc --noEmit 2>&1 | tail -20
```

Typecheck clean. Remaining `pauseActiveGoal` call sites = legit (widget Esc L1600, `/goal-pause` cmd L2412, function def). Abort-detection pauses gone.

**Diff applied:**

```diff
diff --git a/extensions/goal.ts b/extensions/goal.ts
index fcae8be..b6e4ea6 100644
--- a/extensions/goal.ts
+++ b/extensions/goal.ts
@@ -3937,11 +3937,10 @@ ${objective}` : objective,
 						details: goalDetails(state.goal),
 					};
 				} else {
-					// ── Continue working → pause the goal ──────────────
-					pauseActiveGoal(ctx);
+					// ── Continue working → goal stays active (upstream parity) ──
 					setTurnStopped(state.goal?.id ?? null);
 					return {
-						content: [{ type: "text", text: "Goal paused — user chose to continue working after skipping audit." }],
+						content: [{ type: "text", text: "Audit aborted — the goal remains active and work continues." }],
 						details: state.goal ? goalDetails(state.goal) : undefined,
 					};
 				}
@@ -4586,10 +4585,10 @@ promptGuidelines: [
 		const tokens = assistantTurnTokens(message);
 		accountProgress(ctx, { completedTurnTokens: tokens });
 
-		if (isAbortedAssistantMessage(message)) {
-			pauseActiveGoal(ctx);
-			return;
-		}
+		// Abort-tolerant: runtime aborts (timeouts, MCP slow init, provider 5xx,
+		// tool-execution cancels) must NOT pause the goal. Only explicit user Esc
+		// (syncTerminalInputPause) or /goal-pause pauses. Fall through; agent_end
+		// queues the next continuation so the auto-run chain survives.
 		refreshGoalDisplayFromDisk(ctx);
@@ -4656,7 +4655,7 @@ promptGuidelines: [
 	});
 
 	pi.on("message_end", async (event, ctx) => {
-		if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx);
+		// Abort-tolerant: runtime aborts do not pause (see turn_end note).
 		const raw = asRecord(event.message);
@@ -4894,10 +4893,10 @@ promptGuidelines: [
 		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
 		if (endedGoalId && state.goal.id !== endedGoalId) return;
 		if (!reconcileFocusedGoalFromDisk(ctx)) return;
-		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
-			pauseActiveGoal(ctx);
-			return;
-		}
+		// Abort-tolerant: runtime aborts / ctx.signal.aborted do NOT pause.
+		// Only explicit user Esc (syncTerminalInputPause) or /goal-pause pauses.
+		// Fall through to queueContinuation so the auto-run chain survives
+		// transient runtime aborts (timeouts, MCP init, provider failures).
 		persist(ctx);
 		updateUI(ctx);
 		queueContinuation(ctx);
```

**Fixed [F1-F4]:**
- F1: `turn_end` abort-pause → removed
- F2: `message_end` abort-pause → removed
- F3: `agent_end` abort-pause → removed (now falls through to `queueContinuation`)
- F4: audit-escape "Continue working" → goal stays active (upstream parity)

**Remains [R1]:** `isAbortedAssistantMessage` + `hasAbortedAssistantMessage` still used for token accounting at agent_end L4886 — kept (correct, charges aborted turn tokens to goal).

**Callsout [CA1]:** Infinite-loop risk if pi runtime hard-aborts every turn (dead MCP, bad provider). Mitigation = user Esc (widget L1600 still pauses). No backoff/retry-limit added — user said "just continue". If loops observed, add `maxConsecutiveAborts` counter.

**Callsout [CA2]:** Widget Escape at L1600 returns `{ consume: true }` (swallows key) — upstream returns `undefined` (lets pi also abort the turn). Ours means: Esc pauses goal but running tool/turn completes first. Low-impact but upstream mismatch. Not touched.

**Verify [T1]:**
```bash
cd ~/Documents/Projects/bhd/pi-goal-xx
npx tsc --noEmit                                        # ✅ passed
# Deploy to test:
# (followed by pi restart in affected session)
```

**Deploy:** Need to deploy to `~/.pi/agent/` for live testing. Want me to run `mise run deploy-dev` (LOCAL→3) or stage further?

---

Status at end of turn 3: 4 edits applied (3 abort-pause sites + audit-escape fix). Typecheck clean. No tests broken (verified turn 4). Next: `2026-08-10-turn4-test-coverage-check.md`.
