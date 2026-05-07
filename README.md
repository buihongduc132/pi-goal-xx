# pi-goal

A pi extension that adds Codex-style long-running goals to pi.

## What It Adds

- `/goal` command for setting, viewing, tweaking through the agent, pausing, resuming, replacing, and clearing a session goal.
- `get_goal`, `create_goal`, and `update_goal` tools for the agent.
- Persistent goal state stored in the pi session via `pi.appendEntry()`.
- Local markdown goal files under `.pi/goals/`, with completed/cleared/replaced goals archived under `.pi/goals/archived/`.
- Status/footer and widget updates while a goal is active.
- Autonomous follow-up prompts while the goal is active, until the agent marks it complete or a budget is reached.

## Install Locally

From this checkout:

```bash
pi install .
```

Or test once without installing:

```bash
pi -e .
```

## Usage

```text
/goal improve benchmark coverage
/goal --tokens 50k --max-turns 20 improve benchmark coverage
/goal status
/goal tweak focus on benchmark coverage for the parser first
/goal pause
/goal resume
/goal replace --tokens 100k migrate the auth module
/goal clear
```

Flags accepted before the objective:

- `--tokens <n|k|m>` or `--token-budget <n|k|m>`: stop when estimated model tokens reach the budget.
- `--max-turns <n>`: stop after this many autonomous goal turns. `0` disables the turn limit.
- `--no-auto` or `--no-start`: keep the goal as context but do not auto-continue.

## Tweak Flow

`/goal tweak <instructions>` does not mutate extension state directly. It sends a user message to the agent with the active goal file path, current prompt, and requested tweak.

The agent is instructed to:

1. Read the active goal file.
2. Edit only the `# Goal Prompt` section.
3. Avoid marking the goal complete just because the prompt changed.
4. Continue under the revised goal prompt.

This keeps the loop consistent: the agent sees the tweak, performs the file edit, and the extension rereads the active file before subsequent turns.

## Local Files

Active goals are written as editable markdown files like:

```text
.pi/goals/active_goal_2026050711200332_<goal-id>.md
```

Archived goals are written like:

```text
.pi/goals/archived/goal_2026050710232343_<goal-id>.md
```

The file starts with JSON metadata, then an editable `# Goal Prompt` section. The extension treats lifecycle metadata as extension-owned and rereads only the prompt section from disk before writing progress. `/goal tweak` is the preferred way to change the prompt because the agent must participate in the update.

## Agent Tools

- `get_goal`: read current goal state and file paths.
- `create_goal`: create a goal only when explicitly requested.
- `update_goal`: mark the goal `complete`; this is intentionally the only model-controlled status transition.

## Notes

This mirrors the main Codex design split where the user controls goal creation/pause/resume/clear and the model can only mark a goal complete. In pi there is no app-server thread goal API, so state is session-local and branch-aware through custom session entries, with local markdown files as an editable mirror.
