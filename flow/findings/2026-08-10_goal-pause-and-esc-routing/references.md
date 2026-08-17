# References

> Sources consulted during this explore session.

## Source files

### pi-goal-xx (`/home/bhd/Documents/Projects/bhd/pi-goal-xx/`)

- `extensions/goal.ts` — Main extension file. Contains pauseActiveGoal, abort-detection handlers (turn_end/message_end/agent_end), Esc key handler, queueContinuation, reconcileFocusedGoalFromDisk. 4928 statements, 70.5% coverage.
- `extensions/goal-settings.ts` — Settings schema. Added PauseConfig type, PauseReason type, asPauseConfig validator, resolvePauseConfigFromEnv, env var constants (PI_GOAL_PAUSE_ESCAPE_ENV etc.).
- `extensions/goal-record.ts` — Type definitions. StopReason extended from `"user"|"agent"` to include `"escape"|"command"|"abort"`.
- `extensions/goal-core.ts` — GoalDisplayRecordLike.stopReason now uses StopReason type (was hardcoded).
- `extensions/goal-policy.ts` — StopReasonLike aliased to StopReason.
- `extensions/goal-ledger.ts` — Ledger event types. goal_paused event has `reason: string` field.
- `tests/pause-config.test.ts` — 7 new tests covering parseGoalSettings, resolvePauseConfigFromEnv, loadGoalSettings integration.
- `tests/fixtures/pause-config-escape-off.json` — Test fixture for pauseConfig.
- `package.json` — Scripts: check (tsc), test (node --test), test:coverage (c8).
- `.gitignore` — Excludes node_modules, coverage, .pi/goals, worktrees.

### pi-plugins (`/home/bhd/Documents/Projects/bhd/pi-plugins/`)

- `profile/pi-goal-xx-settings.json` — Global config. Added `"pauseConfig": { "escape": false, "command": true, "abort": false }`.
- `.mise.toml` — Mise tasks: deploy-dev, deploy-staging, deploy-prod, deploy-full, rollback-staging, rollback-prod, test-deploy-bats.
- `.mise/plugins/deploy/scripts/deploy-to-dev.sh` — Dev deploy script.
- `.mise/plugins/deploy/scripts/deploy-to-staging.sh` — Staging deploy script.
- `.mise/plugins/deploy/scripts/deploy-to-prod.sh` — Prod deploy script.
- `.mise/plugins/deploy/scripts/smoke-test.sh` — Smoke test runner (has "Deployment Prompt Template" test).
- `.mise/plugins/deploy/scripts/deploy-lib.sh` — Deploy library (anti-cheat Layer 3 provenance check).

### beet-orches (`/home/bhd/Documents/Projects/bhd/beet-orches/components/mod-contractor-payment/`)

- `.pi/goals/active_goal_2026080901150000_lxn5e2w7-t3k8mq.md` — Goal file read for context.
- `.pi/goals/goal_events.jsonl` — Ledger showing all pauses as reason="user".

### llm-configuration (`/home/bhd/Documents/Projects/bhd/llm-configuration/`)

- `.pi/goals/active_goal_2026081017212698_msn3085m-ma0g21.md` — Goal file showing stopReason="user", status="paused".
- `.pi/goals/goal_events.jsonl` — Ledger showing pauses at 10:45:12 and 10:46:39, both reason="user".

### pi-core (`~/.pi/agent/`)

- `git/github.com/buihongduc132/pi-goal-xx/extensions/goal.ts` — Deployed prod copy. md5 matches source.
- `pi-goal-xx-settings.json` — Deployed prod config. Contains pauseConfig.escape=false.

## Documents

### pi-coding-agent SDK

- `/home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension lifecycle, event hooks.
- `/home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` — SDK types.

### pi-tui (TerminalInputHandler contract)

- `~/.pi/agent/node_modules/@earendil-works/pi-tui/dist/tui.js:549-571` — `handleTerminalInput()` implementation. Shows the exact contract: `result?.consume → return` (swallow), `result?.data → transform`, `undefined → continue to built-in handlers`.
- `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:48-53` — `TerminalInputHandler` type: `(data: string) => { consume?: boolean; data?: string } | undefined`.

### Existing findings

- `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md` — Related stale-lock bug (PID recycling). Different symptom (lock stuck), same area (pause/lock machinery).
- `flow/findings/goal-focus-collision/` — Focus collision investigation. Related to goal unfocus symptom.

## Code patterns

### Abort-detection sites (3 sites, all upstream-identical)

- `turn_end`: `if (isAbortedAssistantMessage(message)) pauseActiveGoal(ctx)` — REMOVED in commit `d9c915a`/`07a6487`
- `message_end`: `if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx)` — REMOVED
- `agent_end`: `if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) pauseActiveGoal(ctx)` — REMOVED

### Esc key handler (widget)

- `syncTerminalInputPause` in goal.ts — `matchesKey(data, "escape")` + `return { consume: true }` (original) vs `return undefined` (fixed for escape=false in commit `d7fd46a`)

### Per-reason pause config

- `pauseActiveGoal(ctx, reason: PauseReason)` — checks `pauseConfig[reason]`, skips if disabled, logs distinct reason in ledger

### Deploy chain

- LOCAL → dev(3): `mise run deploy-dev` (no auth, marks adhoc)
- dev(3) → staging(2): `CLI_AGENT_DEPLOY_ALLOW_TO=$(cat ~/.pi-dev-pi-plugins/.deploy-token) PI_CODING_AGENT_DIR=/home/bhd/.pi-dev-pi-plugins mise run deploy-staging`
- staging(2) → prod(1): same pattern with staging token + `SMOKE_SKIP_GIT_FRESHNESS=1`
- Provenance fix: `jq '.deployed_by = "pi-agent"' deploy-manifest.json` (manual workaround for adhoc deploys)
