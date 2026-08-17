# Explore Turn 12 — Esc Routing Bug Discovery + Fix

> Date: 2026-08-10
> Phase: bug fix (Esc swallow regression)
> Status: complete — commit `d7fd46a`, deployed

## [user]

DID you remove the esc to interupt the session as well ?

It should not pause the goal but it is still have to be able to stop the session in pi natively;

(verbatim — trust chain L1)

## [assistant]

**BUG found.** With `escape=false`:

1. `pauseActiveGoal(ctx, "escape")` returns early (no pause) ✅
2. But handler STILL returns `{ consume: true }` ❌ → swallows Esc → pi never stops the session

**Fix:** When escape disabled, return `undefined` (let pi handle Esc natively):

```typescript
if (matchesKey(data, "escape") && state.goal?.status === "active" && state.goal.autoContinue) {
    const pauseConfig = loadGoalSettings(cachedCwd).pauseConfig ?? { escape: true, command: true, abort: false };
    if (pauseConfig.escape === false) {
        // Esc pause disabled — let pi handle Esc natively (stops session/turn)
        return undefined;
    }
    pauseActiveGoal(ctx, "escape");
    return { consume: true };
}
```

**Committed:** `d7fd46a` "fix: let pi handle Esc natively when escape pause disabled"

**Deployed:** All 3 stages (dev/staging/prod).

**Behavior now:**

| `pauseConfig.escape` | Esc behavior |
|---|---|
| `true` (default) | Goal pauses + Esc consumed (pi stops session) |
| `false` (your global config) | Goal stays active + pi handles Esc natively (stops session/turn as normal) |

Esc always stops the running session — only the goal-pause is gated by config.

---

Status at end of turn 12: Esc swallow bug fixed. Commit `d7fd46a` deployed. Next: `2026-08-10-turn13-esc-disable-clarification.md`.
