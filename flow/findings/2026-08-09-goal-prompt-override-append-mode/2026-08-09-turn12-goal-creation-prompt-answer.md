# Explore Turn 12 — goal-creation-prompt-answer

Date: 2026-08-09
Phase: explore
Status: complete — locked decision LD3

---

> **[user]** (verbatim — trust chain L1)
>
> Now where is the prompt when creating the goal?

---

**[assistant]**

*(After reading `goal-prompt-resolver.ts` and grepping `goal-prompts.ts`)*

Goal custom prompt paths:
- global: `~/.pi/goal-prompt.md`
- local: `<cwd>/.pi/goal-prompt.md`

Global exists at `~/.pi/goal-prompt.md`. Content:

```
if it implementation tasks:
- must delegate team to implementation;
must implementation in tdd approach. RED sub agents must always separate than the GREEN / refactor;

DO NOT calls pause / block / ask question during the goal.
Must delegate sub agents to find the solutions for the problem.
if truely block after 2 sub agents to figure it, then skip that part and make the stub / mock implementation , THEN immediately update into the plan / document files related about the plans you are implementation so that others will know about that gap and fix it later ;

MUST always use verifier loop before calling completion;
COMPLETION without verifier loop proof is invalid and will be REJECT anyway.
```

`customGoalPromptBlock` injected into 3 places in `goal-prompts.ts`:
- L191 — `goalPrompt()` (runtime goal system prompt, active goal turn)
- L228 — goal-running continuation prompt
- L251, L299 — two other prompt builders (likely pause/resume/tweak)

**Answer**: there is NO custom prompt injection at goal *creation* time (`propose_goal_draft` / `/goal` command). The `customGoalPromptBlock` only fires in the **runtime prompts** (when a goal is already active and the agent is working on it). The drafting flow is handled by pi-core tool schema — outside this package's reach.

---

Status at end of turn 12: Confirmed — no custom prompt at goal creation. Only runtime (active goal) prompts inject it. → Turn 13.
