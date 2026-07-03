# Goal Focus Collision

> Date range: 2026-07-04 → 2026-07-04
> Status: proposal-written (explore concluded, change `add-goal-focus-locking` to be created)

## Topics

### Multi-session goal focus collision + lock design (2026-07-04)
Explored what happens when multiple pi sessions run in the same cwd with multiple goals. Confirmed 5 collision classes (C1–C5) present in the current implementation via code investigation. Root cause: per-session focus state is auto-derived from a cwd-shared `.pi/goals/` disk pool on every `session_start`, with no gate between "discovered a goal" and "started running it" (`loadState` → `resolveSessionFocus` → `queueContinuation`). User narrowed scope to the auto-focus + auto-run + stealing problem (C1, C5) and excluded settings sharing (C3) and worktree specifics. Designed a lease-based advisory lock with two-signal liveness (PID + lease TTL), reap-on-acquire, and acquisition that gates auto-run. 3 design decisions locked (LD1: no suspend edge-case handling; LD2: ask-before-steal on explicit override; LD3: auto-focus resume-only by default, env-flag-gated). Proposal `add-goal-focus-locking` authorized.

## Pick up next time
1. Read `2026-07-04-locked-decisions.yaml` for LD1–LD3 (the design decisions to formalize).
2. Read `2026-07-04-turn3-lock-design.md` for the full lock mechanism (liveness, heartbeat, acquisition, release, reap).
3. Read `2026-07-04-turn2-collision-investigation.md` for C1–C5 evidence (file:line citations).
4. Next step: create openspec change `add-goal-focus-locking` capturing LD1–LD3 + the turn-3 design.
5. Open: OT7 (MCP connects in auditor?) and OT8 (AGENTS.md coupling) — separate concerns, flagged during this explore.
