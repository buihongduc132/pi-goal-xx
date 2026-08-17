# Explore Turn 2 — auditor-context-answers

Date: 2026-08-09
Phase: explore
Status: complete

---

> **[user]** (verbatim — trust chain L1)
>
> 1. What are all the context that inputting into the auditor now?
> 2. do we have any custom prompt for it ?
> 3. do it receive the init goal file as-is? Also , what are all the context that passed to the auditor as well , also give me the completion_goal function signature ;

---

**[assistant]**

**1. Context passed to auditor**

`runGoalCompletionAuditor` receives:
- `goal.objective` — raw goal text
- `completionSummary` — executor's claim (from `complete_goal` params)
- `detailedSummary` — current goal metadata block
- `verificationSummary` — executor's verification evidence
- `goal.verificationContract` — if set on goal
- `goal.taskList` — rendered task tree with completion counts
- System prompt (hardcoded read-only auditor persona, via `getSystemPrompt`)
- Tools: resolved from `auditorMode` + include/exclude filters (inherits main session's tools list)
- Extensions/skills: filtered via `resolveAuditorResources` from main session loader

**2. Custom prompt**

Yes — 4 resolution levels (first wins):
1. `settings.auditorPrompt` or `settings.prompts.auditor.inline`
2. Unified file: `<home|cwd>/.pi/pi-goal-xx/prompts/auditor.md` (mode: global-local/override/append/etc.)
3. Legacy: `<home|cwd>/.pi/auditor-prompt.md`
4. Hardcoded fallback (`buildAuditorPromptParts`)

Invariant: **fact layer always appended** regardless of mode (persona replaced, facts guaranteed present).

**3. Goal file / `complete_goal` signature**

Goal is NOT passed as-is. It's reconstructed via `mergeGoalPromptFromDisk(ctx, state.goal)` → aliased as `auditTarget`. Fields extracted individually into the prompt.

`complete_goal` tool parameter signature:
```ts
execute(
  _toolCallId: string,
  params: {
    status?: "complete",
    completionSummary?: string,       // optional — executor's claim
    verificationSummary: string,      // REQUIRED
    confirmBypassAuditor?: boolean,
  },
  signal: AbortSignal,
  _onUpdate: unknown,
  ctx: ExtensionContext
)
```

---

Status at end of turn 2: All 3 questions answered. → Turn 3.
