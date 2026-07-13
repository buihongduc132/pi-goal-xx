# start_goal Tool

The agent-facing equivalent of `/goals-set`. Creates a new active pi goal, focuses
it, and immediately starts the auto-run enforcement loop (`queueContinuation`).

Unlike `create_goal` (which is registered but hard-locked to **always reject**),
`start_goal` actually creates **and** starts the goal.

## Signature

```typescript
start_goal(
  objective: string,
  autoContinue?: boolean,  // default: true
  sisyphus?: boolean,      // default: false
) → AgentToolResult<{ goal: GoalRecord | null }>
```

### Parameters

| Parameter       | Type      | Required | Default | Description |
|-----------------|-----------|----------|---------|-------------|
| `objective`     | `string`  | yes      | —       | Concrete objective to pursue. Max 50,000 chars (50KB). For Sisyphus goals this MUST be the full plan including numbered steps and per-step done criteria. May include a `Verification contract:` section. |
| `autoContinue`  | `boolean` | no       | `true`  | Whether pi should keep sending continuation prompts until the goal is complete. When `true`, the agent enters the auto-run loop. |
| `sisyphus`      | `boolean` | no       | `false` | When `true`, marks this as a Sisyphus goal: the agent must execute strictly step-by-step, no skipping, no rushing, no improvising. |

### Returns

`AgentToolResult` with:
- `content[0].text`: A `buildGoalCreatedReport` summary confirming the goal was created.
- `details`: The standard goal details object (`goalDetails(state.goal)`).

On rejection (empty objective, >50KB): returns a `start_goal REJECTED: ...` message
with the current goal details (no goal is created).

## Subagent Visibility Contract

**HIDDEN by default.** `start_goal` is:

1. **Registered** as a pi tool via `pi.registerTool(regTool(defineTool({ name: START_GOAL_TOOL_NAME, ... })))` in `extensions/goal.ts`.
2. **Never added to the active tool set.** In `syncGoalTools()`, the line `active.delete(START_GOAL_TOOL_NAME)` ensures it is always removed. Because tool visibility = membership in the active set passed to `pi.setActiveTools()`, this means:
   - The LLM never sees `start_goal` in its available tools list.
   - It does not appear in the system prompt's "Available tools:" section.
   - It has **no `promptSnippet`** — intentionally not advertised.
3. **Does not leak to subagents.** The only subagent in this codebase is the goal-auditor, which inherits tools via `pi.getActiveTools()`. Since `start_goal` is absent from the active set, it never reaches the auditor or any delegated agent.

The knowledge of **how and when** to call `start_goal` will be provided to agents
via prompt/skill context in a future change (TBD — not implemented here).

## Lifecycle

```
start_goal.execute(params, ctx)
  │
  ├─ 1. Validate objective (non-empty, ≤50KB)
  ├─ 2. extractVerificationContract(raw, ctx.cwd, settings)
  ├─ 3. clearContinuationState(); clearActiveAccounting()
  ├─ 4. confirmationIntent = null; syncGoalTools()
  └─ 5. replaceGoal({ objective, autoContinue, sisyphus }, ctx, startNow=true, verificationContract)
       │
       ├─ createGoal(config)         → new GoalRecord (status: "active")
       ├─ setGoal(goal, ctx)         → focus the goal, persist to disk
       ├─ beginAccounting()          → start token/time tracking
       ├─ acquireFocusedLock(cwd, id)→ take the focus lock (D6 chokepoint)
       └─ queueContinuation(ctx)     → start the auto-run enforcement loop
            │
            └─ sendQueuedContinuation(ctx, goalId)
                 ├─ checks: status=active, autoContinue=true, no drafting, lock held, idle
                 └─ sends hidden GOAL_EVENT_ENTRY checkpoint message (triggerTurn: true)
                      │
                      └─ agent processes the checkpoint → does work → turn ends
                           │
                           └─ turn_end handler → if goalWorkToolCalledThisTurn → queueContinuation again
                                │
                                └─ (loop repeats until goal is complete'd or pause'd)
```

## Relationship to Other Goal-Creation Paths

| Entry point | Creates goal? | Starts auto-run? | User confirmation? |
|---|---|---|---|
| `/goals` `/sisyphus` → `propose_goal_draft` | Yes (`startNow=false`) | No (deferred) | Yes (Confirm/Continue dialog) |
| `/goals-set` `/sisyphus-set` | Yes (`startNow=true`) | Yes | No (direct command) |
| `create_goal` tool | **No (always rejected)** | No | N/A |
| **`start_goal` tool** (this) | **Yes (`startNow=true`)** | **Yes** | **No (agent-initiated)** |

## Implementation Reference

- **Constant**: `START_GOAL_TOOL_NAME = "start_goal"` in `extensions/goal-tool-names.ts`
- **Registration**: `extensions/goal.ts`, right after the `create_goal` tool registration.
- **Hide point**: `syncGoalTools()` in `extensions/goal.ts` — `active.delete(START_GOAL_TOOL_NAME)`.
- **Tests**: `tests/goal-start-goal.test.ts` (dedicated), `tests/goal-tool-names.test.ts`, `tests/goal-extension.test.ts`.
- **Documentation**: this file (`docs/start-goal-tool.md`).
