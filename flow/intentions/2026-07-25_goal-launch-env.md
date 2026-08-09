# Intention — Goal Launch Env (PI_GOAL_ENABLE + PI_GOAL_FILE + non-TUI hardening)

> Date: 2026-07-25
> Source: user (verbatim, trust-chain L1)
> Worktree: `.worktrees/wt-launch-env` (branch `feat/goal-launch-env`)

## User request (verbatim)

> IMPLEMENT this feature (remember to delegate sub agents to come up with the solutions).
>
> a. ensure that by launching with env var , inner pi will have all the tools to create / start / resume / focus goal.
> That it can even be able to start the goal by itself when the user giving prose requirement .
> b. make the environment var that to directly load the goal file and put it to focus and running mode.
> c. ensure that whenever launching in non-tui , our goal functionalities still working normally ;
>
> ---
>
> Implement it in the worktree ;
> Then do the [verifier-loop] then [pr-creation] as well ;
>
> Ensure to go to ../pi-plugins to deployed after merge ;

## What this means concretely

Three coupled capabilities, all env-var-driven, so an outer launcher (a script,
ralph, an IDE, a CI runner) can bring up an "inner pi" that is fully
goal-capable and optionally pre-focused on a specific goal file — without a
human at a TUI.

### (a) Master enable switch — `PI_GOAL_ENABLE`

One env var that, when truthy, gives the inner pi the COMPLETE goal tool
surface: it implies `enableStartGoal=true` AND `enableCreateGoal=true` (the two
per-tool opt-ins from PR #40), and `start_goal` gains a `promptSnippet` so the
model knows to invoke it when the user describes a goal in prose. Per-tool env
vars (`PI_GOAL_ENABLE_START_GOAL=0`) still narrow it back down.

### (b) Goal-file autoload — `PI_GOAL_FILE`

Path (absolute or cwd-relative) to a goal `.md` file. At `session_start`, the
extension loads that file, focuses it, and — if its status is `active` or
`paused` — starts the auto-run loop. A `paused` goal is flipped to `active`
(explicit "load and RUN" instruction). A `complete` goal is focused but not
run. External files (not already in `.pi/goals/`) are copied into the pool
durably. Ignored in worker sessions (`PI_TEAMS_WORKER=1`).

### (c) Non-TUI / headless hardening

Today several functional decisions are gated on `ctx.hasUI` and silently no-op
in non-TUI: a `paused` goal never resumes (session_start line 4606), multi-open
focus can't resolve without a picker, lock takeover can't proceed. Fix these so
that launching non-TUI still gets full goal functionality:
- `session_start` paused-goal: auto-resume in non-TUI (honour `PI_GOAL_AUTO_RESUME=0` opt-out).
- Focus override / lock takeover: auto-proceed when `PI_GOAL_AUTO_CONFIRM=1` (re-use existing proposal-auto-confirm var).
- Use `isInteractiveTui(ctx)` (not raw `ctx.hasUI`) at functional gates — forward-compatible with `ctx.mode` even though the framework doesn't set it today (documented latent gap).

## Out of scope

- Modifying pi-core (`@earendil-works/pi-coding-agent`) to propagate `ctx.mode`.
- A new `PI_GOAL_LAUNCH_ENV` tri-state — rejected as scope creep + launcher coupling. The pragmatic path: reuse `isInteractiveTui` + `PI_GOAL_AUTO_CONFIRM` + a new `PI_GOAL_AUTO_RESUME`.
- Changing the slash-command set (`/goal-focus`, `/goal-resume` stay commands; feature (a) exposes the agent-callable `start_goal`/`create_goal` tools, which is what "tools to create/start/resume/focus" means at the agent layer).

## Acceptance (mapped to deliverables)

- `PI_GOAL_ENABLE=1` → `start_goal` + `create_goal` callable; `start_goal` has promptSnippet; agent can create+start from prose.
- `PI_GOAL_FILE=<path>` → file loaded, focused, running (active/paused) at session_start; worker-ignored; missing-file = notify, no crash.
- Non-TUI launch: paused goal auto-resumes; focus override auto-proceeds with `PI_GOAL_AUTO_CONFIRM=1`; no functional gate silently kills goal work.
- Tests RED→GREEN; `npm test` no new failures; `npm run check` clean.
- verifier-loop ≥2 unanimous APPROVE; pr-creation; merge; deploy to ../pi-plugins.
