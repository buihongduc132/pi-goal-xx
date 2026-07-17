# Intention — Granular Prompt Building for Disabled Tools

- date: 2026-07-18
- goal_id: mrpcpltd-4d14wr
- status: active

## Verbatim User Request

> make the prompt building more granular.
> Ex: if pause / block / ask user is disable:
> - default: not generated
> - <modeAName>: user provided the replacement for each of these (in the global / local)
>
> Ex:
> - modeAName: if ask_question is disable , then field ask_question_config: { mode: <aName> , prompt: <file / path> }
> Then instead of generate the default tools instruction , it will generate that replacement

## Interpretation

Today the prompt builders (`extensions/prompts/goal-prompts.ts`) hardcode instructions about lifecycle tools:
- `pause_goal` (blocker channel)
- `goal_question` / `goal_questionnaire` (ask user)
- `abort_goal` (abandon)
- `complete_goal` (complete)

`settings.disabledTools` only hides the tool from the agent (`active.delete` in `goal.ts:723`). It does NOT touch the prompt. So disabling `pause_goal` produces prompt-tool drift: the prompt still says "call pause_goal when blocked" but the tool does not exist → agent either errors or fabricates a workaround.

The goal makes prompt building granular per-tool-instruction:
1. **default behavior**: if a tool is disabled, the corresponding default prompt instruction block is NOT generated
2. **replacement behavior**: user can provide a per-tool replacement config (e.g. `ask_question_config: { mode: <name>, prompt: <file/path> }`) — when set, that replacement text is injected instead of the default instruction

## Scope Boundaries

In scope:
- New settings schema for per-tool-instruction replacement configs (pause_goal, goal_question, abort_goal, complete_goal)
- Prompt builders skip default tool-instruction lines when the tool is disabled
- Prompt builders inject user-provided replacement when configured
- Global + local config support (existing `settings.prompts` pattern with `resolvePrompt`)

Out of scope:
- Replacing the entire prompt body (already exists via `prompts[key].mode: override`)
- New lifecycle tools
- UI / TUI changes for the new config

## Verification Signals (planned)

- Unit tests: each prompt builder returns the right block when tool enabled / disabled / replaced
- TDD: RED tests first for each combination
- Verifier loop approves the plan
- Existing prompt-builder tests still pass (no regression on the override mode path)

## Execution Phases (from user)

### Planning phase
- a. add flow/intentions/ (this doc)
- b. delegate sub agents to make plan + openspec change
- c. delegate sub agents to find gotcha via verifier loop until plan approved
- d. commit changes

### Implementing phase
- a. worktree wt/prompt-custom-parts, invoke worktree skill
- b. team workflow + delegation, TDD (RED separate from GREEN/refactor)
- c. no block/pause/ask tools — delegate sub agents to find solutions
- d. pass verifier loop → PR creation → all green → merge to main
- e. intercom pi-plugins to deploy; REMIND pause/block/ask_user must be disabled
