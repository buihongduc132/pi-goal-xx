# Explore Turn 13 — Esc Disable Clarification

> Date: 2026-08-10
> Phase: clarify (behavior explanation)
> Status: complete

## [user]

So previously you completely disable the Esc thing ?

(verbatim — trust chain L1)

## [assistant]

**Yes — that was the bug.**

Timeline of Esc behavior with `escape=false`:

| Commit | Esc → goal | Esc → session | Bug? |
|---|---|---|---|
| Original (upstream divergence [F2]) | paused | swallowed (`{consume:true}`) | upstream returns `undefined`, ours swallowed |
| `8c2de8c` (pause config) | NOT paused (config) | **still swallowed** | ❌ **BUG** — Esc did nothing |
| `d7fd46a` (today's fix) | NOT paused (config) | pi handles natively | ✅ fixed |

**What happened with `8c2de8c`:**
- `pauseActiveGoal(ctx, "escape")` returned early (no pause) ✅
- But the handler STILL returned `{ consume: true }` ❌ → Esc key swallowed → pi never got it → session kept running

So between commits `8c2de8c` and `d7fd46a`, Esc was completely dead when `escape=false`. You'd press Esc and nothing happened — neither goal pause nor session stop.

**Now (`d7fd46a`):**
- When `escape=false`: return `undefined` → pi handles Esc → stops session/turn natively ✅
- When `escape=true` (default): pauses goal + `{consume:true}` (matches original behavior)

**[CA1]** Upstream `tmonk/pi-goal-x` always returned `undefined` on Esc (passing it to pi). Our fork diverged to `{consume:true}` at some point. Today's fix aligns the `escape=false` path with upstream semantics. The `escape=true` path still has the divergence but that's the original fork behavior (preserve backward compat).

---

Status at end of turn 13: Clarified the Esc behavior timeline. Next: `2026-08-10-turn14-git-archaeology.md`.
