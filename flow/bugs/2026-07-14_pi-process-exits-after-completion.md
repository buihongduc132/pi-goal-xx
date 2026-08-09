# Bug — pi PROCESS exits after goal completion (true-TUI probe)

> Date: 2026-07-14
> Status: **ROOT CAUSE FOUND (definitive)**. Fix not yet applied.
> Related: `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` (different symptom — that was hang/crash; THIS is clean `process.exit(0)`).

## Symptom

After `complete_goal` is approved by the auditor and the goal is archived, the **entire pi process exits cleanly (code 0)** ~1 second later. The TUI disappears. User perceives "pi died / goal unresolved." This — NOT the surfacing gap, NOT the crash-on-run bug — is the true cause of the "unresolved like a plague" report.

## Root cause (DEFINITIVE — proven via `NODE_OPTIONS=--trace-exit`)

**`pi-print-clean-exit` extension kills the host process.**

`--trace-exit` stack trace captured at exit (Run 3):
```
at safeExit (/home/bhd/.pi/agent/extensions/pi-print-clean-exit/index.ts:107:13)   ← process.exit(code)
at /home/bhd/.pi/agent/extensions/pi-print-clean-exit/index.ts:88:107              ← setTimeout callback in armCleanExit
at afterWrite (node:internal/streams/writable:710:5)
at afterWriteTick (node:internal/streams/writable:696:10)
at processTicksAndRejections (node:internal/process/task_queues:88:21)
```

### Mechanism (chain of facts)

1. The completion auditor runs **in-process** — `createSession({ sessionManager: SessionManager.inMemory(...) })` (`extensions/goal-auditor.ts:738-749`). Same Node process as the host TUI.
2. The auditor **inherits all host extensions** via `inheritFromCwd` + `makeAuditorResourceLoader` (`goal-auditor.ts:609` logs `extensionsCount: 53`). `pi-print-clean-exit` is among them.
3. The in-memory auditor child session runs in a **headless mode** (`ctx.mode === "print"` or `"json"` — the default for SDK/in-memory sessions; CLI default "text" does not apply here).
4. `pi-print-clean-exit`'s `agent_end` handler checks `isHeadlessMode(ctx)` (`index.ts:24-27`) → **passes** for the auditor child → checks `hasPendingMessages` (none after audit) → calls `armCleanExit` (`index.ts:74`).
5. `armCleanExit` schedules a `setTimeout(..., 1500)` (`EXIT_GRACE_MS`) that calls `safeExit` → `process.exit(0)` (`index.ts:88, 107`). The timer is `.unref()`d so it doesn't hold the loop, but it still FIRES after 1.5s.
6. The host's own `agent_end` fires afterward but in interactive TUI mode → `isHeadlessMode` is false → returns early. It does **not** `disarm()` the timer.
7. `disarm()` only fires on `agent_start` (a new turn). After a completed goal (`terminate:true` ends the agent loop + `turn_start` early-returns on `status==="complete"`), **no new turn ever starts** → the armed timer is never cancelled.
8. ~1.5s after the auditor's `agent_end`, the timer fires → `process.exit(0)` → **host pi process dies.** Clean exit, code 0, no error, no log entry.

### Why the two counterfactual teammates missed it

Both `log-forensics` and `terminate-counterfactual` read `isHeadlessMode(ctx)` and concluded "interactive TUI → inert." They did NOT account for the in-process auditor CHILD having a headless `ctx.mode` while sharing the host process. `log-forensics` even listed `pi-print-clean-exit` among the 53 inherited extensions (`goal-auditor.ts:609`) but dismissed it on the same flawed reasoning. `--trace-exit` overrode the theoretical elimination with empirical proof.

### Why the earlier crash-safe work (PRs #24–#31) didn't catch it

G1/G2/G3 guards (`goal-auditor.ts:661, 721–730`) intercept `unhandledRejection` / `uncaughtException`. They do NOT intercept an extension **deliberately** calling `process.exit(0)`. `process.exit` cannot be caught by those guards — it's a normal, intentional API call from the extension's perspective.

## Reproduction (true TUI, 3 runs)

Method: detached tmux, real PTY, bare `pi` (pipe breaks TTY → instant headless self-exit). Real completable objective (agent refuses blind "call complete_goal" probes under current verifier-loop rules). `remain-on-exit on` + exit-code wrapper for clean capture.

| Run | Goal | goal_completed | pi exit | Δ | code |
|----|------|----------------|---------|---|------|
| 1 | mrkb54sx-d06lbn | 07:07:38.561 | ≤07:07:55 | ≤17s (poll-bound) | (confounded: tmux server died) |
| 2 | mrkb54sx (pi2) | 07:24:22.974 | **07:24:24** | **~1s** | **0** (remain-on-exit: "Pane is dead status 0") |
| 3 | mrkbzlt0 (pi3, `--trace-exit`) | 07:31:41.278 | **07:31:42** | **~1s** | **0** + trace stack pointing at pi-print-clean-exit |

Run 3 is dispositive: the trace stack names the exact extension + lines.

### Exit is CLEAN (not a crash)

- Session log ends at the `complete_goal` toolResult + audit-event messages. `grep -iE "terminate|unhandled|uncaught|process.exit|SIGTERM|fatal"` → **0 matches**.
- Host `pi-global-error-handler` log: **0 entries** in the exit window.
- `dmesg` / `journalctl`: no OOM/SIGKILL/segfault.
- `tmux-livelock-watchdog` (`/tmp/tmux-watchdog.log`): empty — did NOT fire.

## Eliminated suspects (each with evidence)

| Suspect | Eliminated by |
|---------|---------------|
| `complete_goal` returns `terminate:true` | `terminate` is a turn-batch hint (`agent-loop.js:124` flips `hasMoreToolCalls`); **no** `process.exit` in pi-core gated on it. Both teammates + my Run 3 trace concur. |
| `tmux-livelock-watchdog` killed server | `/tmp/tmux-watchdog.log` empty, no capture dirs. |
| OOM / SIGKILL / segfault | `dmesg` clean. |
| unhandledRejection / uncaughtException | host error-handler log empty in window; session log clean. |
| Run 1 tmux-server-death confound | Run 2 + Run 3 used `remain-on-exit on` — pane persisted, showed clean status 0, server stayed up. Exit is pi's own. |

## Fix options (NOT applied — user to decide)

| Option | Where | Tradeoff |
|--------|-------|----------|
| **A — Exclude pi-print-clean-exit from auditor inheritance** | pi-goal-xx `makeAuditorResourceLoader` / `isGoalSelfExtension`-style filter (add `pi-print-clean-exit` + any `process.exit`-calling extension to the exclude set) | **Most surgical.** Auditor child should NEVER inherit a process-exit extension. Mirrors existing self-extension filter pattern. |
| B — pi-print-clean-exit detects in-process child | `~/.pi/agent/extensions/pi-print-clean-exit/index.ts`: skip arming when `ctx` is an in-memory/child session (detect `SessionManager.inMemory` or no real stdin) | Correct globally but touches a shared global extension (affects every project). |
| C — Move auditor out-of-process | `goal-auditor.ts`: subprocess/worker instead of in-process | The documented ultimate fix (`goal-auditor.ts:1228` comment). Largest change; fully isolates all side effects. |
| D — process.exit override during audit window | `goal-auditor.ts`: monkey-patch `process.exit` for the audit window, restore after | Fragile; `process.exit` overriding is unreliable. Not recommended. |

**Recommended: Option A** (smallest, pi-goal-xx-local, directly addresses "auditor child inherits a host-killer extension"). Long-term: Option C.

## Sub-agent deliverables (verified)

| Agent | File | Verdict |
|-------|------|---------|
| `log-forensics` | `flow/findings/2026-07-14_pi-exit-log-forensics.md` | Correctly eliminated terminate/rejection/OOM; theorized handle-draining (MEDIUM) — close but not exact; missed pi-print-clean-exit. |
| `terminate-counterfactual` | `flow/findings/2026-07-14_counterfactual-terminate-field.md` | Definitively cleared `terminate:true`. Correct. |
| `--trace-exit` Run 3 (this session) | this doc | Pinned pi-print-clean-exit as the killer. |

## Lesson

**Empirical `--trace-exit` beats theoretical source-elimination.** Two capable sub-agents reasoned past the real cause by trusting a mode-guard that the in-process child silently defeated. When a process exits with no error signature, `NODE_OPTIONS=--trace-exit` (or `--trace-uncaught`) is the deterministic disambiguator — run it before theorizing.

## Evidence files

- Repro 1: `/tmp/pi-exit-probe/` (goal_events, auditor-trace, session log `~/.pi/agent/sessions/--tmp-pi-exit-probe--/...019f5f6d...jsonl`)
- Repro 2: `/tmp/pi-exit-probe2/` + `exit.txt` (code=0, ~1s Δ)
- Repro 3: `/tmp/pi-exit-probe3/` + `exit.txt` + pane capture (`--trace-exit` stack)
- Killer: `/home/bhd/.pi/agent/extensions/pi-print-clean-exit/index.ts:88, 107`
- In-process auditor inheritance: `extensions/goal-auditor.ts:609, 738-749`
