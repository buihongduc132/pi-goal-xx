# Requirements — Goal Launch Env (2026-07-25)

> Derived from `flow/intentions/2026-07-25_goal-launch-env.md` (verbatim user request).

## R1 — Master enable switch `PI_GOAL_ENABLE`

- **R1.1** New env var `PI_GOAL_ENABLE` and settings key `enable` (boolean). Resolution: `env.PI_GOAL_ENABLE > settings.enable > false`.
- **R1.2** When `enable` is true, `enableStartGoal` and `enableCreateGoal` default to true. Explicit per-tool env/settings (`PI_GOAL_ENABLE_START_GOAL=0`, `settings.enableStartGoal=false`) override DOWN (narrow). Boolean expression:
  - `enableStartGoal = asBool(env.PI_GOAL_ENABLE_START_GOAL) ?? settings.enableStartGoal ?? enable`
  - `enableCreateGoal = asBool(env.PI_GOAL_ENABLE_CREATE_GOAL) ?? settings.enableCreateGoal ?? enable`
- **R1.3** `syncGoalTools()` needs NO structural change — it already reads the two per-tool flags from `loadGoalSettings(cachedCwd)`. The loader change cascades.
- **R1.4** `start_goal` tool gains a `promptSnippet` so the model is prompted to call it from prose. Because the host's `_rebuildSystemPrompt` auto-gates `promptSnippet` by active-set membership, the snippet is auto-hidden when the tool is inactive and auto-shown when active. `create_goal` stays snippet-less (it creates without starting; `propose_goal_draft` remains the confirmation path).
- **R1.5** Worker sessions (`PI_TEAMS_WORKER=1`): `PI_GOAL_ENABLE` is honored (workers may create goals if the leader explicitly enables). No special-casing — leaders already control worker env.

## R2 — Goal-file autoload `PI_GOAL_FILE`

- **R2.1** New env var `PI_GOAL_FILE` and settings key `goalFile` (string, absolute or cwd-relative path). Resolution: `env.PI_GOAL_FILE > settings.goalFile > none`.
- **R2.2** At `session_start`, AFTER `loadState` and BEFORE the existing resume-picker / lock-acquire / queueContinuation tail: if `goalFile` resolves and `!isWorkerSession()`, call `loadAndFocusGoalFile(ctx, filePath)`.
- **R2.3** `loadAndFocusGoalFile` contract:
  - Resolve absolute path (absolute as-is; relative → `ctx.cwd`).
  - `lstatSync`: reject symlinks, dirs, missing → `notify(error)` + return `{handled:true}`.
  - `parseGoalFile(abs)`: null → `notify(error)` + return `{handled:true}`.
  - If parsed.id already in pool → `setFocusedGoalId(existing.id, ctx, "selected")` (no disk duplicate).
  - Else → `tryWriteActiveGoalFile(ctx, parsed, false)` to copy into `.pi/goals/`, then `goalsById.set` + `setFocusedGoalId`.
  - Then `applyStatusForEnvLoad`: `complete` → notify (no run); `paused` → `setGoal({...current, status:"active", autoContinue:true, stopReason:undefined, pauseReason:undefined, pauseSuggestedAction:undefined})`; `active` → no-op.
  - Return `{handled:true}`. Lock acquire + queueContinuation are left to the existing session_start tail (single chokepoint, D6).
- **R2.4** Set `envLoadPerformed` flag; guard the resume-picker (4602) and pause-confirm (4606) blocks with `&& !envLoadPerformed` so they don't double-prompt after the env load.
- **R2.5** Worker sessions: skip entirely (no focus, no copy, no run).
- **R2.6** Lock held by other session: NOT taken over silently. The tail's `acquireFocusedLock` returns `heldByOther` → `mayAutoRun=false` + notify (matching existing session_start behavior). To forcibly take over, the launcher sets `PI_GOAL_AUTO_CONFIRM=1` (R3.3).

## R3 — Non-TUI / headless hardening

- **R3.1** `session_start` paused-goal resume (line 4606): in non-TUI, auto-resume. New env `PI_GOAL_AUTO_RESUME` (tri: `1`=force on, `0`=force off, unset=auto: prompt in TUI, auto-resume in non-TUI). Logic:
  - `PI_GOAL_AUTO_RESUME==="0"` → keep paused.
  - `isInteractiveTui(ctx) && PI_GOAL_AUTO_RESUME!=="1"` → prompt (existing TUI behavior).
  - else → notify "Auto-resuming..." + resume.
- **R3.2** Functional `ctx.hasUI` gates: replace with `isInteractiveTui(ctx)` at the FUNCTIONAL sites: `chooseOpenGoal` (1997), `focusGoalCommand` (2128), `session_start` multi-open (4602). UI-only side-effects (status refresh 796, widget register 1262, terminal input 1462, settings editor 2383) keep `ctx.hasUI` — they're genuinely TUI-only and harmless in RPC/print.
- **R3.3** Focus override / lock takeover (`confirmFocusOverride` 2090): when held by other LIVE session, auto-proceed iff `PI_GOAL_AUTO_CONFIRM=1` (reuse existing proposal var) → `releaseLock` + notify warning. Without the env, refuse + notify (unchanged for TUI).
- **R3.4** Multi-open focus in non-TUI (`chooseOpenGoal`, `focusGoalCommand`, session_start 4602): when `!isInteractiveTui(ctx)`, auto-pick the most-recent open goal (via existing `sortGoalsForPicker`) and call `confirmFocusOverride` on it. Not silent — notify which goal was picked.
- **R3.5** Document the latent gap: `ctx.mode` is NOT set by the current pi-coding-agent framework (`runner.js:createContext` has no `mode` getter). `isInteractiveTui` falls back to `ctx.hasUI` in production. The fix in R3.1–R3.4 is correct regardless because it uses `isInteractiveTui` (forward-compat) AND adds explicit env overrides.

## R4 — Tests (RED → GREEN)

- **R4.1** `tests/goal-env-enable-master.test.ts` — PI_GOAL_ENABLE=1 exposes start+create; narrow-down with `=0`; settings.enable parity; start_goal.promptSnippet truthy when enabled; no-focus bootstrap snapshot = {get_goal, start_goal, create_goal, propose_goal_draft}; end-to-end `start_goal.execute` persists a goal.
- **R4.2** `tests/goal-env-goal-file.test.ts` — absolute/relative load + focus + run; already-in-pool (no duplicate); paused→active+run; complete→no-run+notify; worker-ignored; missing-file→notify+no-crash; unparseable→notify; lock-held-by-other→focus+blocked+notify; settings.goalFile fallback; env>settings precedence.
- **R4.3** `tests/goal-headless-resume.test.ts` — print-mode paused auto-resume; `PI_GOAL_AUTO_RESUME=0` stays paused; TUI prompts; `PI_GOAL_AUTO_RESUME=1` forces resume.
- **R4.4** `tests/goal-headless-focus.test.ts` — non-TUI multi-open auto-pick; `confirmFocusOverride` with `PI_GOAL_AUTO_CONFIRM=1` takes over; without env refuses.
- **R4.5** Amend `tests/goal-env-enable-start-create-goal.test.ts` to assert start_goal.promptSnippet truthy when enabled.

## R5 — Non-functional

- **R5.1** `npm test` introduces zero new failures vs baseline (baseline = 54 pre-existing auditor-suite failures from pi-coding-agent version drift, unrelated).
- **R5.2** `npm run check` (tsc --noEmit) clean.
- **R5.3** No new sync fs in hot paths beyond the existing `loadGoalSettings` pattern (session_start already calls it).
- **R5.4** Subagent leak: `start_goal`/`create_goal` already filtered at auditor boundary by PR #40 (goal-auditor.ts OT4). No change needed; verify still holds.
