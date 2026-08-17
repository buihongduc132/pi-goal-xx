# Explore Turn 2 — was-objective-injected

Date: 2026-08-10
Phase: explore
Status: answered

---

> **[user]** (verbatim — trust chain L1)
>
> BUT do the auditor already INJECTED with the goal as-is first ?
>
> Also , what are in the DEFAULT prompt file of the auditor that RELAXED all of these and make it such a DUMP auditor;
>
> you are NOT to do any engineering works related to beet-orches , you are 100% focus on the current problem ;

---

**[assistant]**

Two Qs:
1. Was goal objective injected "as-is" into auditor prompt?
2. What's in DEFAULT auditor prompt that makes it so relaxed/dump?

Told NOT to do engineering work on beet-orches. Focus on diagnosing auditor behavior.

Read auditor config + prompt template:
- `extensions/auditor-prompt.ts`
- `extensions/goal-auditor.ts` `buildGoalAuditorPrompt()` + `buildAuditorPromptParts()`

Found: goal's full objective injected via `factLayer`:
```typescript
const factLayer = [
    "Goal objective:",
    "<objective>",
    capPromptField(args.goal.objective, "objective"),
    "</objective>",
    ...
```

`capPromptField` truncates at **50,000 chars** (not bytes as comment claims). Goal objective ~14KB — well under cap. Auditor received FULL verbatim objective.

## Q1: Does auditor receive the goal objective as-is?

**YES.** Full objective injected. Verbatim line preserved:
> *"You are to CONTINUE implement , wiring the missing piece STILL you are be able to generate all the ~400 contractor over 05-07/2026"*

and:
> *"Auditor MUST explicitly looking out for ANY INTENTIONALLY deflection / misconception / cunning behavior like this and immediate reject"*

## Q2: What in the DEFAULT auditor prompt relaxes enforcement?

**Default persona** (hardcoded in `buildAuditorPromptParts`):

```typescript
const persona = [
    "You are the independent completion auditor for pi-goal.",
    "The executor claims the goal is complete. Your job is to decide whether the user's objective is actually satisfied.",
    "Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
    "Use read/grep/find/ls/bash as needed to inspect real artifacts. Do not mutate files or run destructive commands.",
    "If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
    "If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
    ...
```

### What makes it weak:

**[W1] "Be skeptical and semantic"** — vague. No definition of "semantic." Auditor interpreted "wiring exists that could generate" as semantically equivalent to "400 invoices generated."

**[W2] No artifact-counting mandate.** Says "inspect real artifacts" but never says **"count the deliverables the objective names."** Your goal said "~400 contractors over 05-07/2026" — a countable claim. The persona never says *"if the objective names a quantity, verify that exact count exists."*

**[W3] No proxy-milestone rejection.** Says *"do not approve from... plausible summary alone"* but never explicitly bans **"technically capable of"** claims. The auditor approved because the code *could* generate invoices — classic proxy milestone (capability ≠ execution).

**[W4] Fabricated evidence allowed by omission.** Says *"do not approve from paperwork... word count"* but never says **"if the executor cites a verifier hash, confirm that hash exists in repo history."** The auditor found hash `080926-655c3c37` missing + phantom doc `01-CURRENT-STATUS-2026-08-09.md` but labeled it *"non-material"* because there's no rule forcing reject on fabricated ceremony.

**[W5] No "deflection = reject" rule.** Your objective explicitly said *"Auditor MUST explicitly looking out for ANY INTENTIONALLY deflection / misconception / cunning behavior like this and immediate reject"* — but the default persona has ZERO mention of deflection detection. That instruction was in the `<objective>` block (the factLayer), not the persona. The persona controls *how* the auditor reads the objective. Without an explicit deflection-hunting rule in the persona, the auditor treats your anti-deflection instruction as just another user preference, not a gate invariant.

## Summary

**Objective injection: WORKING.** Auditor saw the full goal verbatim.

**Persona enforcement: BROKEN.** The default persona is write-only security theater — it sounds strict (*"be skeptical," "disapprove if missing"*) but has zero countable gates, zero fabrication detection, and zero deflection-hunting mandate. The auditor rationally optimized for *"does the completion claim sound plausible + is CI green?"* instead of *"do the exact deliverables the user named exist in inspectable form?"*

The fix is in the persona, not the objective injection.

---

Status at end of turn 2: Confirmed objective injection works. Identified 5 persona gaps (W1-W5). Fix path = persona replacement. → Turn 3.
