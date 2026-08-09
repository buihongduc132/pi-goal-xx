# Disable Blocking Tools by Default

**Date**: 2026-07-31  
**Status**: Implemented  
**Branch**: main

## Intent

Goals should run e2e uninterrupted once started. Blocking tools (pause, abort, question, tweak) should be hidden by default to prevent the agent from interrupting the goal flow.

## Background

User observed two UX friction points in the tweak flow:
1. Dialog title shows "Confirm Goal Draft" instead of "Confirm Goal Tweak"
2. After tweak confirmation, agent loses thread and asks to create new goal

Root cause: `propose_goal_tweak` is a pi-goal-xx addition (upstream has mutable objective, no tweak). The fork added immutability + confirmation dialog, but UX is incomplete.

User decision: **disable tweak by default**. If tweak is disabled, the agent cannot interrupt the goal flow with confirmation dialogs.

## Design

### New Configuration Flag

```json
{
  "disableBlockingTools": true
}
```

**Environment variable**: `PI_GOAL_DISABLE_BLOCKING_TOOLS=1`

**Default**: `true` (blocking tools hidden by default)

### Scope

When `disableBlockingTools: true`, hide this tool from the agent:
- `propose_goal_tweak` — revises the objective (stops turn)

**NOT hidden**:
- `complete_goal` — required to finish the goal

**Note**: The block/question/pause agent tools (`pause_goal`, `abort_goal`, `goal_question`, `goal_questionnaire`) were removed from this fork. `propose_goal_tweak` is the only remaining tool that can interrupt the goal flow.

### Rationale

| Tool | Blocks? | Hide by default? |
|------|---------|------------------|
| `propose_goal_tweak` | Yes (stops turn) | ✅ |
| `complete_goal` | Yes (stops turn) | ❌ (required) |
| `pause_goal` | — | Removed from fork |
| `abort_goal` | — | Removed from fork |
| `goal_question` | — | Removed from fork |
| `goal_questionnaire` | — | Removed from fork |

### Opt-Out

Users who want blocking tools can opt-out:

```json
{
  "disableBlockingTools": false
}
```

Or via environment:

```bash
PI_GOAL_DISABLE_BLOCKING_TOOLS=0 pi
```

## Implementation

### Files Modified

1. **extensions/goal-settings.ts**
   - Add `disableBlockingTools?: boolean` to `GoalSettings` interface
   - Add to `ALLOWED_SETTINGS_KEYS`
   - Parse from settings.json
   - Add env var override: `PI_GOAL_DISABLE_BLOCKING_TOOLS`
   - Default: `true`

2. **extensions/goal.ts**
   - In `syncGoalTools()`, check `settings.disableBlockingTools`
   - If true, delete `propose_goal_tweak` from active set
   - Note: `pause_goal`, `abort_goal`, `goal_question`, `goal_questionnaire` were removed from this fork

3. **README.md**
   - Document `disableBlockingTools` flag
   - Document env var `PI_GOAL_DISABLE_BLOCKING_TOOLS`
   - Explain default behavior (propose_goal_tweak hidden)
   - Explain opt-out (set to false)

## Testing

### Manual Test

1. Create a goal with `disableBlockingTools: true` (default)
2. Verify agent cannot call `propose_goal_tweak`
3. Verify agent can still call `complete_goal`
4. Set `disableBlockingTools: false`, reload, verify `propose_goal_tweak` available

### Automated Test

Add test in `tests/goal-settings.test.ts`:
- Parse `disableBlockingTools: true` → returns true
- Parse `disableBlockingTools: false` → returns false
- Parse missing → returns true (default)
- Env var `PI_GOAL_DISABLE_BLOCKING_TOOLS=0` → returns false

## Migration

No migration needed. Existing projects without the flag will use the default (`true`), which hides `propose_goal_tweak`. This is the desired behavior.

Projects that want `propose_goal_tweak` must explicitly set `disableBlockingTools: false`.

## Related

- `PI_GOAL_ENABLE_START_GOAL` — opt-in flag for `start_goal` tool
- `PI_GOAL_ENABLE_CREATE_GOAL` — opt-in flag for `create_goal` tool
- `disabledTools` — per-project tool disable list (manual)

## Future Work

- Consider adding `disableBlockingTools` to the goal creation dialog (like `autoContinue`)
- Consider adding a slash command to toggle blocking tools mid-goal (e.g., `/goal-enable-blocking`)
