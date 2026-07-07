# Bug Hunt — Stale Lock + pi-web Blocking Popup (2026-07-07)

**Status:** LOCATED, not fixed. Root cause(s) hypothesized with code evidence. Needs reproduction before fix.
**Scope:** `pi-goal-xx` (bug #1) + `pi-plugins` pi-web (bug #2). These may share a root cause.

---

## Bug #1 — "Process dead but still locked"

**Symptom:** A pi session owning a focused goal dies (crash/kill/exit), but the goal lock remains "held". Other sessions see `held by session X` and cannot focus; the lock never auto-releases.

### Location
- **Primary:** `extensions/goal-lock.ts` — `isPidAlive()` (lines 78-86), `isLockHeld()` (lines 88-94), `reapStaleLock()` (189-213).
- **Call sites (all correct, but inherit the gap):** `extensions/goal.ts` `computeHeldByOther` (1762), `confirmFocusOverride` (1774), `acquireFocusedLock` (760).
- **Config:** `DEFAULT_LEASE_MS = 180_000` (3min), `DEFAULT_HEARTBEAT_MS = 60_000` (1min) — `extensions/goal.ts:225-226`.

### Design (intended)
Two-signal liveness (design D2): lock HELD iff `isPidAlive(pid)` AND `Date.now() < expiresAt`. When owner dies, PID signal fails → lock stale → `reapStaleLock` unlinks on next acquire. The lease (3min) is the fallback: even if PID check lies, lease expires.

### Root cause hypotheses (ranked)

**[H1] PID recycling — PRIMARY SUSPECT.** `isPidAlive` uses `process.kill(pid, 0)` = PID *existence* only, no process-identity check (no start-time, no cmdline nonce, no sessionId-in-/proc). When the owning pi dies and the OS recycles that PID to another process (browser, daemon, another pi), `isPidAlive` returns TRUE. If this happens within the 3-min lease window, BOTH signals falsely agree "held" → `isLockHeld=TRUE` → lock never reaped (reap only triggers when `isLockStale`, which requires `!isLockHeld`).
- **Evidence:** `goal-lock.ts:80` `process.kill(pid, 0)` — existence check only. No `startTimeMs`/nonce field on `GoalFocusLock.owner` (lines 16-24).
- **Why "still locked" persists:** the recycled PID is typically long-lived (browser/systemd). The lease DOES expire after 3min, but `reapStaleLock` is only called from `acquireLock` (line 141) — i.e. only when ANOTHER session tries to acquire. If no acquisition attempt happens, the stale lock sits on disk and `computeHeldByOther` keeps reporting it (it reads but does NOT reap, by design — line 1760 comment). So the UI shows "locked" indefinitely until someone triggers an acquire.

**[H2] Zombie session — "process alive but work dead".** The pi TUI session stays alive (window open) but the goal/agent work crashed or hung. The heartbeat `setInterval` (line 490, 724-725) keeps refreshing the lease every 60s → lease never expires → lock held forever. To the user the "process is dead" (not doing work) but `isPidAlive` correctly returns true.
- **Evidence:** `goal.ts:490` heartbeat timer; no teardown tied to goal-error/work-death, only to `clearFocusedGoal`/session exit.

**[H3] Heartbeat timer leak.** If `refreshLease`'s `setInterval` isn't cleared on certain error/abort paths, it continues refreshing after the goal logically dies.
- **Evidence:** `clearInterval(heartbeatTimer)` at 724 — gated on `!focusedGoalId`. If focus isn't cleared on the error path, timer leaks.

### Why not double-bookkeeping
Confirmed: `goal-record.ts` / `goal-ledger.ts` do NOT store lock state. Lock is purely file-based (`.pi/.../goal-<id>.lock.json` or similar). So persistence is NOT a stale record — it's the lock file + the H1/H2/H3 mechanism.

### Reproduction plan (before fix)
1. Focus a goal in session A → `cat` the lock file (note `owner.pid`, `expiresAt`).
2. `kill -9 <pid-A>` (SIGKILL, no cleanup).
3. Immediately spawn a long-lived process to recycle the PID: `yes > /dev/null &` until PID reuses (or just wait on a busy system).
4. In session B, run `/goals` or `/goal-focus` → observe "held by session A" despite A dead.
5. Wait >3min (lease expiry) WITHOUT triggering acquire → check if `computeHeldByOther` still shows locked (tests H1-persistence). Then trigger `/goal-focus` → check if reap fires (tests H1-reap-on-acquire).

### Fix directions (post-repro)
- **H1:** add process-identity signal — store `startTimeMs` (Linux `/proc/<pid>/stat` field 22, or `ps -o lstart`); on `isPidAlive`, verify the current process at that PID has a matching start time. OR store a random nonce written to a file the process holds open, check fd still open. This makes `isPidAlive` recycle-safe.
- **H2/H3:** tie heartbeat teardown to work-death (goal error/abort), not just focus-clear. Add a liveness heartbeat from the GOAL WORK (not just the session) — if no work progress in N sec, stop refreshing.
- **Mitigation (now):** `reapStaleLock` should also run from `computeHeldByOther` / periodic sweep, not only `acquireLock`, so stale locks clear even without an acquire attempt.

---

## Bug #2 — "pi-web UI keeps showing blocking popup on session launch"

**Symptom:** Launching a pi session via pi-web repeatedly surfaces a blocking popup/modal that won't dismiss or keeps reappearing.

### Location
- **pi-web frontend:** compiled bundle — TS source NOT in `pi-plugins/profile/packages/pi-extension/server/` (searched; only backend handlers there). Frontend likely a separate build artifact. Cannot read popup component source from these repos.
- **Backend launch path:** `profile/packages/pi-extension/server/agent-jobs.ts` `POST /api/agents/jobs` (line 404).
- **The popup itself is most likely a pi core UI primitive** rendered by the extension context: `ctx.ui.confirm(...)` or AskUserQuestion — see `extensions/goal.ts:1796` (focus-override confirm) and the permission/tool-intercept system.

### Root cause hypotheses (ranked)

**[H1] Cascade from Bug #1 — PRIMARY SUSPECT.** New session launches → auto-focuses a goal → lock appears held (Bug #1 false-held) → `confirmFocusOverride` (goal.ts:1774) fires `ctx.ui.confirm("Goal X held by session Y. Take over?")` → blocking modal in web UI. Even after dismiss/decline, if auto-focus or goal-resume retries on next turn, popup re-fires indefinitely.
- **Evidence:** goal.ts:1790-1805 — the takeover confirm; goal.ts:1948-1950 resume path surfaces heldByOther. Both gated on `isLockHeld` which inherits Bug #1's false-positive.
- **Why "keeps showing":** if the lock is falsely held (Bug #1) and never reaped (because the web session doesn't trigger acquire, or PID recycling defeats reap), every focus/resume attempt re-prompts.

**[H2] Permission/tool-intercept loop.** A permission prompt (cc-safety-net, or a tool that needs approval) fires on launch, user dismisses, but the same tool call retries → re-prompts. Independent of goal lock.
- **Evidence:** cc-safety-net / permission hooks in pi-plugins. Would need pi-web session logs to confirm which prompt text appears.

**[H3] pi-web modal state bug.** The web frontend's modal dismiss doesn't send the right RPC, so the backend never registers the answer and re-sends. Frontend-only bug, invisible from these repos.

### What's needed to confirm
- **Screenshot or exact popup text** from the user. If it says "held by session" / "Take over" → confirms H1 (shared root cause with Bug #1). If it's a permission/tool prompt → H2. If it's blank/generic → H3.
- **pi-web session logs** (`POST /api/agents/jobs` response stream) during a repro.
- **Frontend source** (locate the compiled web bundle or its source repo — not in pi-plugins).

---

## Cross-cutting: Bugs #1 and #2 likely share a root cause

If Bug #2's popup text mentions "goal" / "session" / "take over", both bugs are **one bug**: the falsely-held lock (Bug #1) causes the blocking popup (Bug #2) at launch. Fixing Bug #1's `isPidAlive` (PID-recycling guard) + making `reapStaleLock` run on read/sweep would resolve both.

---

## Verification status

| Item | Located? | Root cause? | Reproduced? | Fixed? |
|---|---|---|---|---|
| Bug #1 code site | ✅ goal-lock.ts:78-94 | 🟡 H1 (PID recycle) | ❌ | ❌ |
| Bug #1 persistence mechanism | ✅ reap only on acquire, not read | 🟡 | ❌ | ❌ |
| Bug #2 code site | ⚠️ likely ctx.ui.confirm goal.ts:1790; frontend src not in repo | 🟡 H1 cascade | ❌ | ❌ |
| Hindsight prior docs | ❌ recall broken; reflect empty | — | — | — |
| flow/ prior docs | ❌ none on these bugs | — | — | — |

## Next steps (need user input)
1. **Bug #2 popup text** — screenshot or exact wording → disambiguates H1 vs H2 vs H3.
2. **Reproduce Bug #1** via the plan above → confirm H1 before coding the PID-identity fix.
3. Decide: fix in `pi-goal-xx` (Bug #1) vs `pi-plugins` (Bug #2 frontend) vs both.
