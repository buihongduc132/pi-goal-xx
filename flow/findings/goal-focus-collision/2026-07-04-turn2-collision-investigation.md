# Explore Turn 2 — Multi-session collision investigation

> Date: 2026-07-04
> Phase: problem investigation (code-grounded)
> Status: C1–C5 collision classes identified and confirmed present in code

## [user]

> **[user]** (verbatim — trust chain L1):
>
> 1. What if we are having multiple running pi in the same cwd with multiple goals;
> it usually working in the worktree , not main tree;
>
> what are the kind of collision that it might have ;
>
> also , the automate load and run goal , it is not a desired feature and usually it would overlapped another goal and steal the active goal running into newly launched session ;
>
> Check if we are still having these problem in the current implementation or not;
>
> --- this one;

## [assistant]

Investigated the actual code. Mapped the two-layer state model and confirmed all collision classes present.

### Evidence [E1–E6]

- **E1** `extensions/goal-pool.ts:54-55` — `resolveSessionFocus` auto-focuses when exactly one open goal exists:
  ```
  const open = openGoalsFromPool(args.pool);
  return open.length === 1 ? open[0]?.id ?? null : null;
  ```
- **E2** `extensions/goal.ts:3647-3663` — `session_start` handler calls `loadState` then `queueContinuation(ctx, true)` unconditionally.
- **E3** `extensions/goal.ts:197` — worker detection is ONLY `process.env.PI_TEAMS_WORKER === "1"`.
- **E4** `extensions/storage/goal-files.ts:19` — `GOALS_DIR = ".pi/goals"`, cwd-relative. Shared across all sessions on same cwd.
- **E5** `extensions/storage/goal-files.ts:87-95` — `atomicWriteGoalFile` uses write-tmp + rename. Prevents torn writes, NOT lost-update races.
- **E6** `node_modules/.../dist/core/sdk.js:275` + `agent-session.js:1874-1911` — `createAgentSession` loads extensions via `resourceLoader.getExtensions()` and fires `session_start` on them. With `inheritFromCwd: true`, the auditor loads `pi-goal-xx` itself → its `session_start` → `loadState()` → could auto-focus + lock the goal it's auditing. New collision vector introduced by the inheritance fix.

### The collision map

```
              SHARED DISK STATE per cwd
              ┌─────────────────────────────────────┐
              │  <cwd>/.pi/goals/                   │
              │   ├── active_goal_*_A.md   ← goal A │
              │   ├── active_goal_*_B.md   ← goal B │
              │   └── active_goal_*_C.md   ← goal C │
              │  <cwd>/.pi/pi-goal-xx-settings.json │
              └──────────────┬──────────────────────┘
                             │ read by EVERY pi session on this cwd
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐        ┌────▼─────┐        ┌────▼─────┐
   │ Session1 │        │ Session2 │        │ Session3 │
   │ worktree │        │ worktree │        │  main    │
   │  goal A  │        │  goal B  │        │  ???     │
   └──────────┘        └──────────┘        └──────────┘
                             │
                  SESSION-BRANCH-LOCAL STATE
                  (focus, continuation, accounting)
                  — NOT shared, but DERIVED from disk
```

### Collision classes [C1–C5]

- **C1 — "auto-focus steals the only open goal"** [E1]. Trigger: any new pi session in a cwd with exactly one non-complete goal — even a session not intended to run that goal. `PI_TEAMS_WORKER` escape hatch only fires for teams-spawned workers; manual worktree/ad-hoc sessions are fully exposed.
- **C2 — "two sessions writing the same goal file"** (lost update). [E5] atomic write prevents corruption but not races. S1 writes complete→S2 overwrites with stale active+new usage.
- **C3 — "settings.json cross-contamination"**. `<cwd>/.pi/pi-goal-xx-settings.json` shared; `loadGoalSettings(cwd)` on every call. One session's experimental config shapes the other.
- **C4 — "the auditor inherits a different session's active goal context"** [E6]. New risk from inheritance fix. Auditor's `createAgentSession` with `inheritFromCwd` loads `pi-goal-xx` → its `session_start` → `loadState` → auto-focus collision.
- **C5 — "focus entry is per-session, goal file is shared"**. Two sessions independently decide they're working on the same goal; both write; both may `queueContinuation`.

### Structural framing

```
   ASSUMED MODEL              ACTUAL WORKFLOW
   1 cwd ──▶ N goals,         1 cwd ──▶ M sessions,
            1 active session             each wanting its own goal
            (switch focus)               (worktree-per-feature)
   
   single-threaded             multi-threaded
   "I switch between goals"    "I run goals in parallel"
```

### Confirmation table

| Problem | Status | Evidence |
|---|---|---|
| Auto-load steals only open goal | PRESENT | [E1] |
| Auto-run on session_start | PRESENT | [E2] |
| Worker isolation covers only PI_TEAMS_WORKER | PRESENT | [E3] |
| Manual worktree session has no escape | PRESENT | no detection |
| Two sessions writing same goal file (lost update) | PRESENT | [E4],[E5] |
| Settings cross-contamination | PRESENT | cwd-shared |

### Threads offered [A–D]

- **A. Kill auto-focus + auto-run entirely.** Smallest change; removes C1. Doesn't fix C2/C3/C5 but neutered blast radius.
- **B. Namespace goals by session.** `<cwd>/.pi/goals/<sessionId>/`. Solves C1/C2/C5; breaks "switch focus" UX.
- **C. Detect worktree, treat like worker.** Surgical for worktree case; doesn't help "two sessions in main cwd."
- **D. Should auto-load+run be a feature at all?** If killed, many collisions become non-issues.

## Status at end of turn 2

5 collision classes confirmed present (C1–C5). 4 solution directions offered (A–D). No decisions locked. User asked to narrow scope next.

→ Next: user narrows to auto-focus + lock design. See `2026-07-04-turn3-lock-design.md`.
