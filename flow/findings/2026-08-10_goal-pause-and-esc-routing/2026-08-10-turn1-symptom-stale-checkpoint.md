# Explore Turn 1 — Symptom: Stale Checkpoint + Silent Pause

> Date: 2026-08-10
> Phase: troubleshoot (Mode A — symptom → diagnose)
> Status: complete — root cause located, fix handed to turn 3

## [user]

```
Let me load the worktree-lifecycle skill to create the worktree properly:
$ ls /home/bhd/.agents/skills/worktree-lifecycle/ 2>/dev/null && echo --- && ls /home/bhd/.pi/agent/skills/ | grep -i worktree
... (11 earlier lines, ctrl+o to expand)
Files Changed (worktree only, not pushed) (reports/deployment-report.md)
Files Changed (worktree only, not pushed) (_wt_dev-image-build/reports/deployment-report.md)
---
Took 1.3s
Thinking...
$ cd /home/bhd/Documents/Projects/bhd/beet-orches/components/mod-contractor-payment && echo ---Create worktree--- && git worktree add .worktrees/wt-g8-fe-invoice-buttons -b wt/g8-fe-invoice-buttons origin/dev 2>&1
... (3 earlier lines, ctrl+o to expand)
---Create worktree---
Preparing worktree (new branch wt/g8-fe-invoice-buttons)
branch wt/g8-fe-invoice-buttons set up to track origin/dev.
HEAD is now at ed8d822fc Merge branch wt/fix-calc-theater-gaps into dev
Took 1.6s
Thinking...
Worktree created. Now t2 — verify buttons exist:
$ cd /home/bhd/Documents/Projects/bhd/beet-orches/components/mod-contractor-payment/.worktrees/wt-g8-fe-invoice-buttons && echo ---Find invoice page files--- && find frontend/src -name *Invoice* -o -name *invoice* | grep -v node_modules | grep -v .test | head -20 && echo ---Check InvoicesPage for Cancel/Reissue buttons--- && rg -n Cancel|Re-issue|Reissue|cancel.*button|reissue.*button frontend/src/pages/ --type tsx -i | head -30
... (36 earlier lines, ctrl+o to expand)
Called by: confirmInvoiceForUser, createCommunicationInvoice, fullTimeTracker
getCurrentInvoice (_wt_dev-image-build/a1-anton-migration/src/invoice/query.ts)
Called by: confirmInvoiceForUser, createCommunicationInvoice, fullTimeTracker
---
Took 2.4s
hindsight: [mod-contractor-payment] retain [dc3fbce8] (async): completed (79.5s)
Thinking...
Queued checkpoint is stale — not acting on it.
Current goal: msljmjzg-yjx0hk (paused) — G8 FE Invoice Cancel/Re-issue Buttons.
Side effect from my prior turn (before stale notice): worktree wt-g8-fe-invoice-buttons was created at .worktrees/wt-g8-fe-invoice-buttons off origin/dev.
Leaving it in place; remove with git worktree remove .worktrees/wt-g8-fe-invoice-buttons if you want it gone.
Goal is paused — awaiting your direction to resume or reprioritize.
◐ Goal paused 14s · 0/11 tasks · +9 open
├
```

(verbatim — trust chain L1)

--- why the fuck do this keep unfocus the goal?

## [assistant]

Investigating. Mode A — verify symptom, find root cause in code.

```
$ ffgrep pattern=stale path=extensions
$ ffgrep pattern=checkpoint path=extensions
$ ffgrep pattern=paused path=extensions
```

Found the stale-checkpoint machinery. Reading core logic:

```
$ read extensions/goal.ts offset=3830 limit=130
$ read extensions/goal.ts offset=680 limit=40
$ read extensions/goal.ts offset=4050 limit=70
```

Now let me trace what triggers pause:

```
$ ffgrep path=extensions/goal.ts pattern=pauseActiveGoal|stopActiveGoal
$ ffgrep path=extensions pattern=isAbortedAssistantMessage
$ ffgrep path=extensions/goal.ts pattern=reconcileFocusedGoalFromDisk
```

```
$ read extensions/goal.ts offset=400 limit=25
$ read extensions/goal.ts offset=1160 limit=45
$ read extensions/goal.ts offset=3920 limit=35
$ read extensions/goal.ts offset=4170 limit=35
```

Let me look at the reconciliation logic and what triggers the pause from disk:

```
$ read extensions/goal.ts offset=787 limit=80
$ read extensions/goal.ts offset=3140 limit=50
```

```
$ read extensions/goal.ts offset=3955 limit=30
$ read extensions/goal.ts offset=1880 limit=60
```

Let me look at the continuation queueing and terminal input pause logic:

```
$ ffgrep path=extensions/goal.ts pattern=queueContinuation|function queueContinuation
$ read extensions/goal.ts offset=1205 limit=40
```

```
$ read extensions/goal.ts offset=1561 limit=55
```

```
$ read extensions/goal.ts offset=4185 limit=25
$ read extensions/goal.ts offset=3120 limit=40
```

Let me check the key matching logic — this could be a false-positive Escape detection:

```
$ ffgrep path=extensions pattern=function matchesKey|matchesKey
$ ffgrep path=extensions pattern=onTerminalInput
```

```
$ read extensions/goal.ts offset=724 limit=35
```

Let me check one more critical piece — the `sendQueuedContinuation` and what `refreshGoalDisplayFromDisk` does:

```
$ ffgrep path=extensions/goal.ts pattern=sendQueuedContinuation|function refreshGoalDisplayFromDisk
```

```
$ read extensions/goal.ts offset=1513 limit=50
$ read extensions/goal.ts offset=965 limit=25
```

Let me check for any existing findings on this exact issue:

```
$ find flow -type f -name "*.md" 2>/dev/null | xargs grep -li "pause\|stale\|abort\|unfocus" 2>/dev/null | head -10
$ ls flow/findings/ flow/bugs/ 2>/dev/null | head -30
```

```
$ read flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md
```

```
$ ls flow/findings/goal-focus-collision/ 2>/dev/null
```

Found it. Root cause traced.

**Symptom [E1]:** Goal pauses between turns → next continuation checkpoint detected stale → agent says "Queued checkpoint is stale."

**Mechanism [E2]:** `extensions/goal.ts`
- `pauseActiveGoal()` fires from 3 places:
  - `turn_end` L3939: `if (isAbortedAssistantMessage(message)) pauseActiveGoal(ctx)`
  - `agent_end` L4188: `if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) pauseActiveGoal(ctx)`
  - `syncTerminalInputPause` L1214: Escape key

**Root cause [C1]:** Something sets `stopReason="aborted"` on assistant msg OR trips `ctx.signal.aborted`. pi-goal-xx only REACTS — it doesn't generate the abort. Abort source = pi RUNTIME, not this extension.

**Cause [C2]:** "Queued checkpoint is stale" = SYMPTOM, not cause. Fires AFTER goal already paused. `isActionableContinuationGoal()` fails because `status !== "active"` → checkpoint rewritten stale by `context` hook L3855.

**Design bug [C3]:** `pauseActiveGoal` L1196 hardcodes reason `"user"`:
```
stopActiveGoal("paused", "user", ctx);
```
ALL abort-induced pauses logged as `"user"` — including programmatic ones. Ledger can't distinguish user-Esc from runtime-timeout. Diagnosis blind.

**Most likely abort triggers [A1]:**
- pi turn/agent timeout (model took too long — hindsight retain ran 79.5s async)
- context-mode CPU watchdog (`AGENTS.md`: systemd kills `server.bundle.mjs` >100% CPU)
- MCP tool failure cascade
- Escape key false-positive (`matchesKey(data,"escape")` — arrow keys/Alt send `\x1b` prefix)

**Verify [T1]:**
```bash
# In beet-orches/components/mod-contractor-payment:
cat .pi/goals/ledger.jsonl | jq 'select(.type=="goal_paused")' | tail -5
# Check aborted msgs in session:
grep -r '"stopReason":"aborted"' .pi/sessions/ | tail
# Check CPU watchdog kills:
journalctl --user -u context-mode* --since "1 hour ago" | grep -i kill
```

**Remains [R1]:** Can't pin exact abort source from here — need pi runtime logs from the beet-orches session. pi-goal-xx code is correct given its contract; the abort originates upstream.

**Callsout [CA1]:** `[C3]` makes ALL future pause debugging harder. Fix: distinguish `"user"` (Esc/cmd) from `"runtime-abort"` (signal/timeout) in `pauseActiveGoal`. Separate reason per call site.

**Callsout [CA2]:** `agent_end` L4188 `hasAbortedAssistantMessage(event.messages)` — if `event.messages` includes prior turns in the invocation, ONE early abort poisons EVERY subsequent `agent_end`. Potential recurring-pause amplifier. Needs verification of what `event.messages` contains.

**Assumptions [A]:**
- Verified: code paths in `extensions/goal.ts` (read directly).
- NOT verified: what's in pi runtime `event.messages` at `agent_end`; whether deployed `~/.pi/agent/` matches this source; actual abort source in beet-orches session.
- NOT verified: `matchesKey` impl for Escape false-positive (in `@earendil-works/pi-tui`, not read).

**Next step:** Run [T1] in the beet-orches project. The ledger `reason` field + session `stopReason` values will pin which of [A1] is firing.

---

Status at end of turn 1: Root cause located — 3 abort-detection sites fire pauseActiveGoal with hardcoded "user" reason. Fix handed to turn 3 (user's "just fucking continue" directive). Next: `2026-08-10-turn2-upstream-vs-regression.md`.
