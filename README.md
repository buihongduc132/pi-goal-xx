# pi-goal-xx

**Owner:** [buihongduc132](https://github.com/buihongduc132)  
**Upstream:** Fork of [pi-goal-x](https://github.com/tmonk/pi-goal-x) (which forked [@capyup/pi-goal](https://github.com/capyup/pi-goal))

`pi-goal-xx` is a long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). It gives the agent a durable objective, a visible lifecycle, and schema-gated tools for drafting, executing, pausing, resuming, and completing work.

The extension is designed around one rule: **the user owns intent; the agent executes only after the goal is explicit and confirmed**.

---

## Table of Contents

- [Quick Start](#quick-start) — Create your first goal in 30 seconds
- [User Commands](#user-commands) — All `/goal-*` slash commands
- [Agent Tools](#agent-tools) — Tools available to the AI agent
- [Tools That Interrupt](#tools-that-interrupt) — Tools that pause/stop the running state
- [Auditor Subscriptions](#auditor-subscriptions) — Async event forwarding to auditor
- [Configuration](#configuration) — Settings file and environment variables
- [Configurable Auditor](#configurable-auditor) — Modes, wildcard filters, prompt files
- [Multi-session Goal Focus](#multi-session-goal-focus) — Lease-based advisory lock for concurrent sessions
- [Worker Session Isolation](#worker-session-isolation) — Prevent goal inheritance in teams
- [Advanced Features](#advanced-features) — Verification contracts, task lists, schema gates
- [Development](#development) — Build, test, and package

---

## Features

- **Two goal styles** — Regular goals for open-ended research and implementation. Sisyphus goals for patient ordered execution, one step at a time.
- **Simple goal creation** — Use `/goals` to discuss and confirm a draft. Use `/goals-set` to skip discussion and start immediately.
- **Full lifecycle** — Pause blocked goals, resume when unblocked, abort obsolete work, complete when done. Auto-continue keeps the agent working across turns until completion, interruption, or the empty-turn guard.
- **Multiple open goals** — Keep several goals in `.pi/goals/`. Each session focuses one at a time; switch with `/goal-focus`.
- **Above-editor status widget** — See the current goal, status, file path, and progress at a glance while the agent works.
- **Structured task lists with subtasks** — Break goals into trackable tasks. Agents can mark individual tasks or subtasks complete without stopping the turn. Subtask IDs are validated for uniqueness and depth.
- **Verification contracts** — Attach plain-text requirements to a goal or task (e.g. "Run npm test, zero failures"). The agent must provide matching evidence before `complete_goal` or `complete_task` will succeed.
- **Independent completion auditor** — When a goal is marked complete, a separate pi agent inspects the workspace, verifies every success criterion, and approves or rejects before the goal is archived. You can press Escape during an audit to abort it. Configure the auditor model via `/goal-settings`.
- **Schema-gated tools** — Agents see only the tools relevant to the current lifecycle phase: drafting, active, paused, or tweaking. Lifecycle tools like `pause_goal`, `complete_task`, and `abort_goal` appear and disappear automatically.
- **Immutable objective** — The agent cannot silently change your goal. Objective updates require a `/goal-tweak` drafting flow with explicit user confirmation.
- **Built-in questionnaire tools** — During drafting, agents can ask structured questions through `goal_question` and `goal_questionnaire` without depending on external packages.
- **Disk-backed state** — Active and archived goals persist in `.pi/goals/`. Goal state survives session compaction, workspace switches, and context churn.
- **Configurable settings** — Tune the auditor model, disable the task system or contracts, and set subtask depth through `/goal-settings` or `.pi/pi-goal-xx-settings.json`.
- **Worker session isolation** — When spawned as a pi-agent-teams worker (`PI_TEAMS_WORKER=1`), the extension skips goal focus inheritance from the leader's branch context. Workers start goal-unfocused and can still read goal files from disk without inheriting the leader's active goal.

> **Fork lineage:** pi-goal-xx ← [pi-goal-x](https://github.com/tmonk/pi-goal-x) ← [@capyup/pi-goal](https://github.com/capyup/pi-goal)
>
> pi-goal-xx preserves all upstream features and adds: verification contracts (per-goal and per-task), unified goal+task acceptance in a single confirmation dialog, recursive task lists with subtasks, an immutable objective enforced by tools, deferred archival with cleaner lifecycle hooks, an improved completion auditor with configurable model and progress widget, drafting UX refinements, worker session isolation for pi-agent-teams, and lifecycle reliability fixes (including zombie process prevention via comprehensive timer cleanup).

## Install

From npm:

```bash
pi install npm:pi-goal-xx
```

From a local checkout:

```bash
pi install .
```

Try once without installing:

```bash
pi -e .
```

## Quick start

### Regular goal

```text
/goals add structured logging to the auth module
```

Flow:

1. The agent clarifies, researches, or grills only when the goal contract needs it.
2. The agent calls `propose_goal_draft` with a concrete objective once the contract is clear.
3. pi shows a full plain-text confirmation report.
4. If confirmed, the full finalized goal is printed into the conversation and written to `.pi/goals/`.
5. The new goal becomes this session's focus. Existing open goals remain in `.pi/goals/` and can be selected later with `/goal-focus`.
6. The agent works only on the focused goal until it calls `complete_goal`, pauses, aborts, produces an empty/non-progress turn, or the user interrupts.

### Sisyphus goal

```text
/sisyphus Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests.
```

Sisyphus mode is for patient ordered execution. It uses the same lifecycle and tools as a regular goal; the difference is the prompt style and completion standard: preserve the user's order, do not rush, do not invent preflight/reconnaissance steps, and stop to ask when blocked.

If the objective is already final and should start immediately, use:

```text
/goals-set add structured logging to the auth module
/sisyphus-set Refactor auth flow exactly as ordered: 1) extract token validation. 2) wire it into login. 3) update tests.
```

## User commands

```text
/goals <topic>          Discuss/research/grill a regular goal, then confirm a draft
/sisyphus <topic>       Discuss/grill a Sisyphus-style goal, then confirm a draft
/goals-set <objective>  Immediately create and start a regular goal
/sisyphus-set <objective> Immediately create and start a Sisyphus-style goal
/goal-status            Show focused goal state
/goal-list              List all open goals in .pi/goals/
/goal-focus             Choose this session's focused goal
/goal-tweak <change>    Draft a revision to the focused active/paused goal
/goal-pause             Pause the focused active goal
/goal-resume            Resume a paused goal
/goal-settings          Configure pi-goal settings, including auditor model settings
/goal-abort             Abort/archive the focused goal or cancel drafting
/goal-clear             Archive the focused goal or cancel drafting
```

Pressing `Esc` or aborting an active run pauses the goal so it does not remain falsely active.

## Multiple open goals and focus

`pi-goal` separates durable goals from session focus:

- **Goal pool**: every open goal is an `active_goal_*.md` file under `.pi/goals/`.
- **Focused goal**: the current pi session has one focused goal id stored in a `pi-goal-focus` custom session entry.
- **No focus in markdown**: goal files describe the goal itself; they do not record which session is focused on them.
- **Branch-local focus**: because focus is reconstructed from the current session branch, `/tree` navigation can restore a different focus for a different branch.
- **One continuation chain**: auto-continue only schedules work for the focused goal in the current session.

Creating a goal with `/goals`, `/sisyphus`, `/goals-set`, or `/sisyphus-set` no longer clears other open goals. It creates a new active goal file and focuses it. Use `/goal-list` to inspect open goals and `/goal-focus` to switch the session focus. If the latest focus entry explicitly clears focus, or points at a missing/stale goal, a remaining single open goal is not auto-focused; single-open auto-focus only happens when no focus entry exists at all. If multiple open goals exist and the session has no valid focus, `/goal-resume`, `/goal-clear`, `/goal-abort`, `/goal-pause`, and `/goal-tweak` ask the user to choose a goal instead of acting on all of them.

## Multi-session goal focus

When multiple pi sessions run in the same cwd (worktree-per-feature, parallel verification, an ad-hoc second session), a fresh session previously auto-focused the only open goal and started running it — stealing the goal from the session that was actively working on it. pi-goal now coordinates concurrent sessions with a lease-based advisory lock.

- **Per-goal lock sidecar**: when a session focuses an active goal, it writes `<cwd>/.pi/goals/.locks/<goalId>.lock` (JSON). The file records `owner.sessionId`, `owner.pid`, `acquiredAt`, `expiresAt`, and `heartbeatAt`. The `.locks/` subdir keeps these out of the active-goal pool scan.
- **Two-signal liveness**: a lock is HELD iff BOTH the owning PID is alive AND the lease has not lapsed. Either signal going stale makes the lock reapable. PID-alive correctly treats `EPERM` (cross-user process) as alive — only `ESRCH` (no such process) counts as dead. This catches crashes near-instantly (PID dead) and hangs within the lease window (lease lapses while the PID still looks alive).
- **Auto-run chokepoint**: `queueContinuation` (the auto-run trigger) only fires when THIS session holds the focused goal's lock. No lock, no lock file, or a lock held by another live session → no auto-run.
- **Auto-focus restricted to `reason: "resume"` by default** (LD3): a brand-new session, a hot-reload, a fork, or `/tree` navigation does NOT auto-focus the only open goal. Only a resumed session (the user coming back to their own session) auto-focuses. This eliminates the "I opened pi for an unrelated task and it stole my goal" case.
- **`/goal-focus` override is advisory**: running `/goal-focus <id>` on a goal locked by another LIVE session prompts "Session <sessionId> (pid <pid>) looks alive — take over anyway?". On a STALE lock (PID dead or lease lapsed), the lock is silently reaped and acquired with no prompt. In headless contexts (`!ctx.hasUI`), override is refused with a warning.
- **Heartbeat refresh**: the lock owner extends its lease via a single 60-second backstop `setInterval` timer while focused and active. The timer refreshes the 3-minute lease ~3× within its window, covering both idle presence and long tool executions. No event-driven refresh on `turn_end` or `tool_execution_end` (timer-only — the least-resistant path).
- **Fail-open on fs errors**: a permissions misconfig on `.locks/` does not crash the session, and manual/explicit goal work proceeds. Auto-run is NOT fail-open — if the session cannot prove it holds the lock, the chokepoint still blocks `queueContinuation`.

### Recovering a stuck lock

Locks are reaped lazily by the next acquirer, so a crashed session's lock clears automatically the next time any session tries to focus that goal. To clear manually:

- Delete the sidecar: `rm <cwd>/.pi/goals/.locks/<goalId>.lock`, or
- Wait for lease expiry (~3 minutes from the last heartbeat) — the lock becomes stale and the next focus reaps it.

The `.locks/` directory is a cache; `rm -rf <cwd>/.pi/goals/.locks` is safe.

### Migration note

Default behavior changed: fresh sessions (`reason: "new"`/`"startup"`/`"fork"`/`"reload"`) and `/tree` navigation no longer auto-focus the only open goal. Users who relied on the prior auto-focus-anywhere behavior set `PI_GOAL_AUTO_FOCUS=all`.

## Agent tools

The extension exposes tools only when they make sense for the current lifecycle phase.

| Tool | Visible when | Purpose |
|---|---|---|
| `goal_question` | drafting / tweak drafting | Ask one focused user question |
| `goal_questionnaire` | drafting / tweak drafting | Ask multiple structured questions |
| `get_goal` | always | Read the focused goal state; mentions other open goals when present |
| `propose_goal_draft` | drafting only (goal creation) | Submit a concrete draft for user confirmation |
| `propose_goal_tweak` | tweak drafting only | Submit a revision to an existing goal (shows Confirm / Continue Chatting dialog) |
| `complete_goal` | focused active or paused goal | Mark the focused goal complete — supply a `verificationSummary` covering all contract items. When the auditor is disabled, supply `confirmBypassAuditor: true` after user confirmation to bypass the audit |
| `pause_goal` | focused active goal | Pause the focused goal because of a real blocker |
| `abort_goal` | focused active or paused goal | Abort/archive an obsolete, impossible, unsafe, or user-cancelled focused goal |
| `propose_task_list` | active or paused goal | Propose a structured task list for user confirmation (stops the turn) |
| `complete_task` | active or paused goal | Mark a task complete with optional `verificationSummary`. If the task has a `verificationContract`, the summary is required (does not stop turn) |
| `skip_task` | active or paused goal | Mark a task skipped with a required reason (does not stop turn) |
| `propose_goal_tweak` | tweak drafting only | Submit a revision to the focused goal (shows Confirm / Continue Chatting dialog) |
| `step_complete` | hidden / legacy | Compatibility no-op; Sisyphus no longer requires a step counter |
| `create_goal` | hidden | Direct calls are rejected; normal creation goes through `propose_goal_draft` |

---

## Tools that interrupt

These tools **stop the current turn** and block subsequent work tool calls (except read-only tools like `read`, `bash` with safe commands):

| Tool | Effect | When to use |
|------|--------|-------------|
| `pause_goal` | Pauses goal, stops turn, blocks subsequent work tools | Agent encounters a real blocker (missing info, dependency failure, unclear requirement) |
| `abort_goal` | Archives goal, stops turn | Goal is obsolete, impossible, unsafe, or user cancels |
| `complete_goal` | Marks complete, runs auditor, stops turn | All success criteria met, ready for independent verification |
| `propose_goal_tweak` | Starts tweak drafting, stops turn | User wants to revise the objective or task list |
| `propose_goal_draft` | Confirmation dialog, stops turn | Agent has clarified intent, ready to create goal |
| `propose_task_list` | Task confirmation dialog, stops turn | Agent wants to break goal into trackable tasks |

**Turn-stopping mechanism:**

When these tools execute, they call `setTurnStopped()` which:
1. Sets a turn-scoped marker (`turnStoppedFor` with `turnSeq`)
2. Blocks all subsequent tool calls in the same turn (except `POST_STOP_ALLOWED_TOOLS`)
3. Forces the agent to yield the turn instead of continuing work

**Allowed tools after stop:**
- Read-only tools: `read`, `bash` (with safe commands like `ls`, `grep`, `find`)
- Inspection tools: `get_goal`, `goal_status`
- No write/edit/bash with side effects

**Stale checkpoint guard:**

If a continuation is queued for a goal that becomes inactive (paused, cleared, replaced) before the turn starts, the stale checkpoint guard blocks work tools with:
```
Cannot call <tool>: the goal checkpoint that triggered this turn is no longer active.
Goal <id> has been paused, cleared, or replaced.
```

---

## Auditor subscriptions

**Auditor subscriptions** allow you to forward lifecycle events asynchronously to the auditor channel. These are **non-blocking notifications** — they log events and show UI notifications, but do NOT intercept or block tool execution.

### Configuration

In `.pi/pi-goal-xx-settings.json`:

```json
{
  "auditorSubscriptions": [
    {"event": "pause", "mode": "async"},
    {"event": "abort", "mode": "async"},
    {"event": "audit_started", "mode": "async"},
    {"event": "task_skip", "mode": "async"},
    {"event": "contract_violation", "mode": "async"}
  ]
}
```

### Available events

| Event | When emitted | Payload |
|-------|-------------|----------|
| `pause` | After `pause_goal` succeeds | `{goalId, details: {reason, suggestedAction}}` |
| `abort` | After `abort_goal` succeeds | `{goalId, details: {reason, archivePath}}` |
| `audit_started` | When completion auditor begins | `{goalId, details: {provider, model}}` |
| `task_skip` | After `skip_task` succeeds | `{goalId, taskId, details: {reason}}` |
| `contract_violation` | When `complete_task` lacks required evidence | `{goalId, taskId, details: {contract, message}}` |

### Behavior

- **Non-blocking**: Events are forwarded on the microtask queue; failures are swallowed and logged
- **UI notifications**: Each event shows a UI notification (e.g., "Auditor subscription: pause (goal=abc123)")
- **Ledger entries**: Each event appends an `audit_subscription_emitted` entry to the goal ledger
- **Unknown events**: Silently skipped (no error, no notification)
- **Mode restriction**: Only `"async"` is supported; other modes are silently dropped

### Example: Track all pauses and aborts

```json
{
  "auditorSubscriptions": [
    {"event": "pause", "mode": "async"},
    {"event": "abort", "mode": "async"}
  ]
}
```

When the agent pauses or aborts a goal, you'll see:
```
Auditor subscription: pause (goal=abc123)
Auditor subscription: abort (goal=abc123)
```

### Future: Question gating

**Not yet implemented.** To intercept `goal_question` → forward to auditor first → auditor decides if question should go to user, you would need:

1. New config: `gateQuestions: true`
2. `goal_question` tool intercepts → calls auditor agent → auditor approves/rejects/rewrites question → then shows to user

This feature is planned but not in the current release. Current `goal_question` goes directly to user.

---

## Drafting behavior

`/goals` and `/sisyphus` start a lightweight intent discussion, not a heavy runtime sub-state. The agent clarifies, researches, and grills only when needed, may proceed directly for fully specified requests, and then calls `propose_goal_draft` to show the user a Confirm / Continue Chatting dialog. `goal_question` and `goal_questionnaire` are available when structured input helps, but plain conversation is acceptable.

`/goals-set` and `/sisyphus-set` skip the discussion and confirmation dialog. They directly create and focus an active goal from the supplied objective so execution can begin immediately.

The agent may do minimal read-only reconnaissance when it directly improves the goal contract, but should not begin substantive implementation before confirmation. The strict runtime starts after the user confirms the draft and an active goal is created.

When a draft is proposed, the confirmation UI shows a full plain-text report with draft details, the original topic, and the proposed goal. If the confirmation UI throws in interactive mode, creation fails closed and confirmation remains active; it never auto-creates a goal. When a draft is confirmed, the tool result includes the full final objective, not a one-line summary, and normal work tools (`write`, `read`, `bash`, `edit`) are available for execution. This makes the confirmed contract visible in the conversation as well as on disk.

While goal confirmation or tweak drafting is active, old goal execution is suspended: active-goal prompts, accounting, and auto-continue checkpoints do not run for the previously focused goal.

## Completion behavior

Completion is also explicit and is checked by an independent pi auditor agent. The executor calls `complete_goal` with its completion claim:

```json
{
  "status": "complete",
  "completionSummary": "What was completed and what evidence proves it."
}
```

Before archiving the goal, `complete_goal` starts a separate pi agent in an isolated in-memory session. The auditor receives the objective, the executor's completion claim, and current goal metadata, then can inspect the workspace with read-only-oriented tools (`read`, `grep`, `find`, `ls`, and `bash`). It must end its report with exactly one marker:

- `<approved/>` archives the goal as complete.
- `<disapproved/>`, no marker, an error, or an abort rejects completion and leaves the goal open.

The auditor is semantic, not a paperwork checklist: it should reject scaffold-only, alpha, generated-template, proxy-metric, build-only, or weakly verified completions when the real user outcome is not satisfied.

By default the auditor uses the current/default pi model. Configure it via `.pi/pi-goal-xx-settings.json`, or interactively with `/goal-settings` (see [Configuration](#configuration)).

The completion result prints a full report into the conversation:

- `Goal complete.`
- optional completion summary / evidence supplied by the executor
- the auditor's approval report
- full current goal details, including objective, status, usage, mode, and file path

Sisyphus goals use the same completion tool as regular goals. The stricter part is the prompt/criteria standard: the agent should only call completion after the whole ordered objective is actually satisfied and likely to survive independent auditing. A paused goal can also be completed directly when the agent already has enough evidence that every requirement is satisfied; it does not need a resume just to call `complete_goal`.

## Schema gates

The shipped gates are intentionally small and mechanical.

| Gate | Prevents |
|---|---|
| Focus consistency | `/goals` accidentally becoming Sisyphus, or `/sisyphus` becoming regular mode |
| Confirm-before-commit | The agent silently creating or replacing a discussion-based goal |
| Direct set intent | `/goals-set` and `/sisyphus-set` are explicit user shortcuts that bypass draft confirmation |
| Completion auditor gate | Archiving completion unless an independent pi auditor agent returns `<approved/>` |
| Abort gate | Aborting missing, stale, completed, or reasonless goals |
| Direct-create rejection | Hidden `create_goal` calls creating goals without the confirmation flow |
| Post-stop block | Continuing to call tools after `pause_goal`, `abort_goal`, `complete_goal`, or `propose_goal_tweak` stops the turn |
| Empty-turn guard | Pure chat loops that would keep auto-continuing without meaningful goal work |
| Abort pause | Active goals staying active after user abort / Ctrl-C |
| Disk reconciliation | External pause/archive/delete/status changes being ignored or overwritten by stale memory |
| Post-compaction reminder | Losing the active objective after session compaction |

## Files

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Multiple `active_goal_*.md` files may exist simultaneously. This is the project-level open goal pool. The selected/focused goal is intentionally not stored in these files; focus lives in session custom state.

Each file contains:

1. extension-owned JSON metadata;
2. a user-editable `# Goal Prompt` section;
3. progress/status information.

Before commands, tools, and lifecycle hooks act on a focused goal, the runtime reconciles the focused record against the active goal file on disk. External archive/delete/status changes therefore win over stale in-memory state and cannot resurrect deleted active files. Prompt-body edits are still picked up from the `# Goal Prompt` section; focus is never stored in goal markdown.

Goal paths are constrained to `.pi/goals/` and `.pi/goals/archived/`; absolute paths, traversal, NUL bytes, symlinks, and unsafe metadata paths are rejected.

## Configuration

All settings live in a single file: **`.pi/pi-goal-xx-settings.json`**

Configured interactively via `/goal-settings`, or edited directly:

```json
{
  "disableTasks": false,
  "disableContracts": false,
  "subtaskDepth": 1,
  "provider": "fireworks",
  "model": "accounts/fireworks/models/deepseek-v4-flash",
  "thinkingLevel": "high",
  "disabled": false,
  "disabledTools": ["goal_question"],
  "auditorSubscriptions": [{"event": "pause", "mode": "async"}]
}
```

| Field | Default | Purpose |
|---|---:|---|
| `disableTasks` | `false` | Suppress task list features entirely when `true` |
| `disableContracts` | `false` | Suppress verification contract enforcement when `true` |
| `subtaskDepth` | `1` | Maximum nesting depth for subtasks |
| `provider` | system default | Provider name for the auditor agent |
| `model` | system default | Model name for the auditor agent |
| `thinkingLevel` | system default | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `disabled` | `false` | When `true`, skip the completion audit entirely |
| `disabledTools` | `[]` | Tool names to hide entirely (never registered, agent never sees them). All tool names are eligible including lifecycle tools (`complete_goal`/`pause_goal`/`abort_goal`); you accept breakage if you disable a lifecycle tool. Unknown tool names are silently skipped. |
| `auditorSubscriptions` | `[]` | Events to forward asynchronously to the auditor channel (non-blocking). Each entry: `{event: string, mode: "async"}`. Arbitrary event strings allowed (lifecycle: `pause`, `abort`, `complete`, `audit_started`; task: `task_skip`, `contract_violation`; any custom string). Unmatched event names are silently skipped. |
| `auditorMode` | `"inherit"` | Auditor resource mode: `"inherit"` (start with all main-session resources, opt out via `auditorExclude`) or `"minimal"` (start with baseline read-only tools, opt in via `auditorInclude`). |
| `auditorExclude` | `{}` | Resources to exclude in `inherit` mode. Object with `tools`, `mcp`, `skills`, `extensions` arrays; glob patterns allowed (`*`, `?`). |
| `auditorInclude` | `{}` | Resources to add in `minimal` mode. Same shape as `auditorExclude`; matched against the main session's resources. |
| `auditorPromptMode` | `"global-local"` | Prompt resolution: `"global-local"` (local overrides global), `"local"` (local only, global ignored), `"global-local-merge"` (global + `\n\n` + local). |
| `auditorPrompt` | unset | Inline auditor prompt string; takes precedence over all file-based prompts and modes. |
| `goalPromptMode` | `"global-local"` | Goal custom-prompt resolution (injected into runtime goal/continuation prompts): `"global-local"` (local overrides global), `"local"` (local only, global ignored), `"global-local-merge"` (global + `\n\n` + local). Mirrors `auditorPromptMode`. |
| `goalPrompt` | unset | Inline goal custom-prompt string; takes precedence over all file-based prompts and modes. |
| `leaseMs` | `180000` | Lease window (ms) for the multi-session focus lock. A lock is stale once `now > expiresAt`. See [Multi-session goal focus](#multi-session-goal-focus). |
| `heartbeatMs` | `60000` | Interval (ms) for the timer that refreshes the focused goal's lease while active. |

**Env var overrides:**
- `PI_GOAL_DISABLE_TASKS=1` — disable task features (takes precedence over file)
- `PI_GOAL_DISABLE_CONTRACTS=1` — disable contract enforcement (takes precedence over file)
- `PI_GOAL_DISABLED_TOOLS=tool_a,tool_b` — comma/whitespace-separated tool names to hide (takes precedence over file)
- `PI_GOAL_SETTINGS_FILE=custom-path.json` — alternative settings file path (relative to cwd or absolute)

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_GOAL_AUTO_CONFIRM` | unset | When `1`, auto-confirms drafts in headless/test contexts |
| `PI_GOAL_DISABLE_TASKS` | — | When `1`, disable task features (overrides settings file) |
| `PI_GOAL_DISABLE_CONTRACTS` | — | When `1`, disable contract enforcement (overrides settings file) |
| `PI_GOAL_DISABLED_TOOLS` | — | Comma/whitespace-separated tool names to hide (overrides settings file) |
| `PI_GOAL_SETTINGS_FILE` | `.pi/pi-goal-xx-settings.json` | Alternative settings file path (relative to cwd or absolute) |
| `PI_TEAMS_WORKER` | unset | When `1`, worker session mode: skips goal focus inheritance from leader's branch context. Workers start goal-unfocused but can still read goal files from disk. Set automatically by pi-agent-teams when spawning worker sessions. |
| `PI_GOAL_AUTO_FOCUS` | `resume` | Multi-session auto-focus policy. `resume` (default): only a session with `reason: "resume"` auto-focuses the single open goal. `all`: restore legacy behavior — auto-focus on any session reason (including `new`/`startup`/`fork`/`reload` and `/tree` navigation, which is routed as `null`). See [Multi-session goal focus](#multi-session-goal-focus). |

## Configurable auditor

The completion auditor verifies goal completion before archiving. By default it inherits the main session's tool list (filtered through `auditorExclude`) and uses a hardcoded prompt. You can make it stricter, looser, or project-specific.

### Two modes

- **`inherit`** (default): the auditor starts with **all** the main session's tools/MCP/skills/extensions, then removes anything matching `auditorExclude`. Use this when you trust the auditor to verify anything the executor could.
- **`minimal`**: the auditor starts with the baseline read-only toolset (`read`, `grep`, `find`, `ls`, `bash`, `report_auditor_progress`) and adds anything matching `auditorInclude` from the main session. Use this for strict, predictable verification.

### Wildcard patterns

`auditorExclude` / `auditorInclude` accept glob patterns in every array:

- `*` — any run of characters (incl. empty)
- `?` — exactly one character
- no wildcard — exact match (case-sensitive)

### Prompt modes

Auditor prompts resolve in this order (first non-empty wins):

1. Inline `settings.auditorPrompt` (always wins)
2. File-based, combined per `auditorPromptMode`:
   - `global-local` (default): `.pi/auditor-prompt.md` overrides `~/.pi/auditor-prompt.md`
   - `local`: only `.pi/auditor-prompt.md` (global never checked)
   - `global-local-merge`: `~/.pi/auditor-prompt.md` + `\n\n` + `.pi/auditor-prompt.md`
3. Hardcoded default prompt (built into the extension)

Global prompt file: `~/.pi/auditor-prompt.md`  •  Local prompt file: `<cwd>/.pi/auditor-prompt.md`

## Configurable goal prompt

The runtime goal/continuation system prompts that drive the **active goal agent** (not the auditor) can also be customized. This is the channel for project-specific execution rules (delegation policy, TDD discipline, blocker handling, verifier-loop requirement). Resolution mirrors the auditor prompt exactly:

1. Inline `settings.goalPrompt` (always wins)
2. File-based, combined per `goalPromptMode`:
   - `global-local` (default): `.pi/goal-prompt.md` overrides `~/.pi/goal-prompt.md`
   - `local`: only `.pi/goal-prompt.md` (global never checked)
   - `global-local-merge`: `~/.pi/goal-prompt.md` + `\n\n` + `.pi/goal-prompt.md`
3. Nothing injected when unset (fully additive — zero behavior change by default)

Global prompt file: `~/.pi/goal-prompt.md`  •  Local prompt file: `<cwd>/.pi/goal-prompt.md`

The resolved block is appended to both `goalPrompt()` (agent start) and `continuationPrompt()` (checkpoint resume), after the Sisyphus discipline block when present. The `/goal` and `/sisyphus` **drafting** instructions live in pi-core's tool schema and are not reachable from this package.

### Examples

**Read-only auditor with everything else stripped** (default is already broad; tighten it):

```json
{
  "auditorMode": "inherit",
  "auditorExclude": {
    "tools": ["write", "edit", "bash"],
    "extensions": ["cc-safety-net*"]
  }
}
```

**Minimal auditor that can also query GitNexus**:

```json
{
  "auditorMode": "minimal",
  "auditorInclude": {
    "tools": ["gitnexus*"],
    "mcp": ["gitnexus"]
  }
}
```

**Project-specific auditor prompt** (create `<project>/.pi/auditor-prompt.md`):

```markdown
You are auditing a financial trading repo. Verify no magic numbers,
all numeric literals are named constants, and every order path has
an idempotency guard.
```

```json
{ "auditorPromptMode": "local" }
```

**Inline override** (no files needed):

```json
{ "auditorPrompt": "Reject unless all tests are green and the diff is < 500 lines." }
```

## Worker session isolation

When pi-agent-teams spawns a worker session with `contextMode: "branch"`, the worker inherits the leader's session entries including goal focus state. This can cause workers to accidentally work on the leader's goal instead of their assigned task.

Setting `PI_TEAMS_WORKER=1` (done automatically by pi-agent-teams) triggers worker isolation mode:

- **No focus inheritance**: The worker skips reading `pi-goal-focus` and `pi-goal-state` entries from the branch context
- **Starts unfocused**: Worker sessions begin with `focusedGoalId=null` and no active goal
- **Can still read goals**: Workers can read goal files from `.pi/goals/` via disk, but don't auto-focus any goal
- **Leader unchanged**: Leader sessions continue to inherit focus normally (backward compatible)

This prevents the bug where 22 zombie test processes accumulated at 90% CPU for 2+ days due to workers inheriting and executing the leader's goal.

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

The fast unit suite uses Node's built-in test runner and covers core parsing, drafting gates, lifecycle policy, abort policy, questionnaire formatting, centralized tool names, Sisyphus prompt-style behavior, completion reporting, and display helpers.

The experiment harness under `experiments/` runs full pi sessions against real model calls and mechanical rubrics.

```bash
cd experiments
bash harness/run.sh C1-vague-goal-set --count 3 --grade --no-smoke
```

## Package contents

The npm package ships only the runtime extension, docs, and package metadata. The extension is split into small modules:

```text
extensions/goal.ts                 orchestration, commands, tools, events, timers
extensions/goal-record.ts          goal record types, normalization, creation helpers
extensions/goal-pool.ts            open-goal pool, focus resolution, list/selector text helpers
extensions/goal-core.ts            display helpers
extensions/goal-draft.ts           lightweight confirmation prompt, proposal validation, drafting tool gate
extensions/goal-policy.ts          lifecycle, pause/resume/complete, and Sisyphus policy
extensions/goal-auditor.ts         independent pi auditor agent for completion approval, config, and progress tracking
extensions/goal-ledger.ts         event append, read, validation, sanitization, and reconstruction
extensions/goal-questionnaire.ts   built-in question UI and question tool registration
extensions/goal-tool-names.ts      centralized published tool names and allowlists
extensions/prompts/goal-prompts.ts active, continuation, tweak, and stale prompts
extensions/storage/goal-files.ts   goal file paths, serialization, parsing, archive IO
extensions/widgets/goal-widget.ts  above-editor goal beacon component
extensions/widgets/goal-notifications.ts widget-style notification text
```

## Design principles

- **User owns intent**: only the user starts, replaces, resumes, clears, or confirms goals; the agent may only pause, complete, or abort through schema-gated lifecycle tools with evidence/reason.
- **One commit path**: normal goal creation goes through drafting and confirmation.
- **Schema beats prompt walls**: recurring failure modes are handled by validators and tool-call interceptors.
- **Visible contracts**: confirmed goals and completion reports are printed fully into the conversation.
- **Lifecycle-shaped tool surface**: the agent sees only tools appropriate to the current phase.
- **Disk-backed continuity**: goal state survives context churn and can be audited from `.pi/goals/`.
- **Human-owned focus**: the agent may work on the focused goal, but only user commands/UI selection switch focus.

## Upstream

This repository is a downstream fork of [pi-goal-x](https://github.com/tmonk/pi-goal-x) (which forked [@capyup/pi-goal](https://github.com/capyup/pi-goal)). To sync with upstream changes:

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts, test, commit
```

The `upstream` remote should point to `https://github.com/tmonk/pi-goal-x.git`.

## Release policy

This repository can be validated locally with tests and packaging checks. Publishing a new npm version, pushing tags, and running `pi update` are explicit release steps and are not part of ordinary implementation goals unless requested.

## Recent changes

### v0.1.0 (2026-07-03)

- **Worker session isolation** — Workers spawned by pi-agent-teams no longer inherit the leader's goal focus. Prevents workers from accidentally executing the leader's goal instead of their assigned task. Fixes zombie process accumulation (22 processes at 90% CPU for 2+ days).
- **Comprehensive timer cleanup** — All internal timers (`statusRefreshTimer`, `auditAnimationTimer`, `debugMockAuditTimer`, `continuationTimer`) are now cleared in `session_shutdown` handler, preventing test runner hangs and zombie processes.
- **Test reliability** — Re-enabled `afterEach` cleanup in test suite with proper timeout guards. All 654 tests pass and exit cleanly within 1.5s.
- **`disabledTools` config** — Hide specific tools entirely from the agent via settings file or `PI_GOAL_DISABLED_TOOLS` env var.
- **`auditorSubscriptions` config** — Forward events asynchronously to the auditor channel for non-blocking audit tracking.
- **Widget timing fix** — Convert milliseconds to seconds before passing to `formatDuration` for tool timing display.

## License

MIT
