# Explore Turn 14 — Git Archaeology: Why {consume:true}?

> Date: 2026-08-10
> Phase: investigate (root cause of divergence)
> Status: complete — found initial fork inherited {consume:true} from upstream v0.19.0

## [user]

Check the commit that we changed it ; what is the reason for it ?

(verbatim — trust chain L1)

## [assistant]

```
$ git log --all --oneline -- extensions/goal.ts | head -20
$ git log -p --all -S "consume: true" -- extensions/goal.ts | grep -B5 -A5 "consume.*true.*escape\|escape.*consume.*true" | head -40
$ git log -p --all -S "consume: true" -- extensions/goal.ts 2>&1 | grep -E "^commit|^Date|^    " | head -30
$ git show 967bc7d -- extensions/goal.ts 2>&1 | grep -B3 -A8 "consume.*true\|matchesKey.*escape" | head -40
$ git show 967bc7d -- extensions/goal.ts 2>&1 | grep -A2 "matchesKey.*escape.*state.goal" | head -10
$ git log --all --oneline --follow -p -- extensions/goal.ts 2>&1 | grep -B10 "return undefined.*escape\|escape.*return undefined" | grep -E "^commit|return undefined" | head -10
$ git log --all --oneline -S "pauseActiveGoal(ctx)" -- extensions/goal.ts | head -10
$ git show 2cacfd5 --stat | head -20
$ git show 2cacfd5 | grep -B5 -A10 "consume.*true\|return undefined" | head -50
$ git show 2cacfd5 -- extensions/goal.ts 2>&1 | head -80
$ git show 210d2cb -- extensions/goal.ts 2>&1 | grep -B3 -A8 "matchesKey.*escape\|consume.*true" | head -40
```

**Found it.** The `{ consume: true }` was in the **initial fork commit** (`210d2cb`), inherited from upstream `tmonk/pi-goal-x` v0.19.0.

**Reason (from the comment):**

```
// Must return { consume: true } so the TUI doesn't also process the key
// and abort the running tool execution, which would cascade into pausing
// the entire goal (agent_end sees ctx.signal?.aborted and calls pauseActiveGoal).
```

**It was a workaround for the abort-pause cascade:**

```
Esc pressed
  → pi-goal-xx pauses goal (status → paused)
  → pi also sees Esc → aborts turn → sets ctx.signal.aborted
  → agent_end sees signal.aborted → pauseActiveGoal() AGAIN (double-fire)
```

`{ consume: true }` swallowed Esc so pi never saw it → no double-pause.

**Timeline:**

| When | What | Esc behavior |
|---|---|---|
| Fork (v0.19.0) | Inherited `{ consume: true }` workaround | swallow Esc |
| Upstream later | Fixed differently — `return undefined` (let pi handle Esc, no abort-pause cascade) | pass Esc to pi |
| Our fork `d9c915a` | Removed abort-pause path (the cascade source) | `{ consume: true }` now obsolete |
| Today `d7fd46a` | Fixed `escape=false` path to `return undefined` | pass Esc to pi when disabled |

**[CA1]** The `{ consume: true }` is now obsolete for BOTH paths (escape=true and escape=false), since the abort-pause cascade was removed in `d9c915a`. The `escape=true` path could also safely return `undefined` now — matching upstream. But that's a behavior change for existing users (Esc would stop the session/turn in addition to pausing the goal).

---

Status at end of turn 14: Root cause of `{consume:true}` divergence found — abort-pause cascade workaround inherited from upstream v0.19.0. Workaround now obsolete after `d9c915a`. Next: `2026-08-10-turn15-pi-tui-source-investigation.md`.
