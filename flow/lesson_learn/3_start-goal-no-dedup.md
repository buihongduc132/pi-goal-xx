# 3: start_goal has no deduplication — creates duplicate goal files

## Context
`start_goal` tool blindly creates a new goal file on every invocation. `replaceGoal()` → `createGoal()` → `newGoalId()` always generates a fresh ID and NEVER checks if a goal with the same objective already exists on disk. Old files are left behind.

Real-world symptom: 4 goals with same objective accumulated in `goal-dashboard/.pi/goals/`:
- `aq6k51` (paused, created by dashboard)
- `dgqs1u` (active, start_goal, 61K tokens)
- `hk4m4e` (active, start_goal, 662K tokens)
- `lkmra1` (active, start_goal, CURRENT with lock)

Each `start_goal` call minted a new goal and orphaned the previous one.

## Solutions
Added `findDuplicateActiveGoal(ctx, objective, excludeGoalId?)` in `extensions/storage/goal-files.ts`:
- Reads all active goal files via `readActiveGoalFiles` (already filters completed)
- Normalizes objectives (trim + collapse internal whitespace)
- Returns first match, excluding one by ID for re-creation paths

Wired dedup into all 4 `replaceGoal()` callers in `extensions/goal.ts`:
- `start_goal`: REJECT if dup exists (agent should `/goal-focus` or `/goal-archive`)
- `create_goal`: REJECT (same)
- `propose_goal_draft`: REJECT before showing confirmation dialog
- `/goals-set`: WARN but proceed (user-invoked, don't block)

Both disk + in-memory `state.goal` checks — covers unpersisted state.

## Rule
**Every goal-creation entry point MUST check for existing goals with the same objective before creating a new one.** This applies to: tool handlers (`start_goal`, `create_goal`), confirmation dialogs (`propose_goal_draft`), and slash commands (`/goals-set`, `/sisyphus-set`).

The dedup check belongs in the CALLER, not in `replaceGoal` itself — re-creation paths (e.g. `/goal-tweak`) need to bypass it via `excludeGoalId`.

## Ref
- PR #55: `fix(goal): dedup start_goal/create_goal/propose_goal_draft before creating`
- Verifier APPROVE: `080326-420cbc52` (2/2 consensus, round 1)
- Tests: `tests/goal-dedup.test.ts` (11 tests)
