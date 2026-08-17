# Explore Turn 14 — design-override-append

Date: 2026-08-09
Phase: design
Status: open question unresolved — OT1

---

> **[user]** (verbatim — trust chain L1)
>
> make it to be able to configured as override / append mode for me ; still dual configuration location : local > global ;

---

**[assistant]**

*(After reading `prompt-resolver.ts` in full and grepping `goal-prompts.ts` for `customGoalPromptBlock` usages)*

**Current state of `goal-prompt-resolver.ts`**

Uses its OWN legacy resolver — hardcoded `~/.pi/goal-prompt.md` / `<cwd>/.pi/goal-prompt.md`, only 3 modes (`global-local`, `local`, `global-local-merge`). No `override` / `append` / `off`.

The unified `prompt-resolver.ts` already has all 6 modes + mtime cache. The goal prompt resolver is just not migrated to it yet.

**What needs to change**

```
goal-prompt-resolver.ts
  loadGoalPrompt()
  customGoalPromptBlock()
```

Two options:

```
Option A — Migrate to unified resolver
─────────────────────────────────────
loadGoalPrompt() → calls resolvePrompt("goal", cfg, cwd, "", opts)
file paths:
  global: ~/.pi/pi-goal-xx/prompts/goal.md   ← NEW path
  local:  <cwd>/.pi/pi-goal-xx/prompts/goal.md

BUT: existing ~/.pi/goal-prompt.md users break silently
     (legacy path no longer consulted)

Option B — Migrate + legacy fallback
─────────────────────────────────────
resolvePrompt("goal", cfg, cwd, "", ...) first
if nothing → check legacy ~/.pi/goal-prompt.md / <cwd>/.pi/goal-prompt.md
             (exact same fallback pattern as auditor-prompt.ts)

Backward compat preserved. New modes (override/append/off) work.
Current ~/.pi/goal-prompt.md continues to load.
```

**Settings hook**

`goal-prompt-resolver.ts` reads `settings.goalPrompt` (inline) and `settings.goalPromptMode` (mode). The unified `settings.prompts.goal` block doesn't exist yet. Need to add it:

```ts
// settings.ts — already has prompts.auditor shape
prompts?: {
  auditor?: PromptConfig;
  goal?: PromptConfig;       // ← add this
  "goal-running"?: PromptConfig;
  ...
}
```

Or simpler: just wire `goalPromptMode` to accept `override` / `append` / `off` in addition to the current 3 values — no schema addition needed, just expand `AuditorPromptMode` alias used by `GoalPromptMode`.

**Recommendation**: Option B. Minimal surface change, full backward compat, adds override/append/off cleanly.

```
goal-prompt-resolver.ts changes:
1. GoalPromptMode = PromptMode  (not AuditorPromptMode — adds override/append/off)
2. loadGoalPrompt() → resolvePrompt("goal", cfg, cwd, "", {promptsDir, home})
3. if source === "none" → legacy fallback (~/.pi/goal-prompt.md)
4. customGoalPromptBlock() → mode=override: replace hardcoded block
                              mode=append / global-local: append (current behavior)
```

**Open question (OT1):**

> `customGoalPromptBlock` currently always wraps output in `<goal_custom_prompt>` tags and appends. In `override` mode, should it replace the entire surrounding prompt section, or just the custom block tag? The hardcoded lifecycle instructions (`goal-running` prompt body) are separate — do you want override to replace only the injected custom block, or the whole `goalPrompt()` output?

---

Status at end of turn 14: Design proposed. Option B recommended. One open question (OT1) unresolved — session ended before user answered.
