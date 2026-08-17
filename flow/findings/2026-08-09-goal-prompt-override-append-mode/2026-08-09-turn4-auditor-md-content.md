# Explore Turn 4 — auditor-md-content

Date: 2026-08-09
Phase: explore
Status: complete

---

> **[user]** (verbatim — trust chain L1)
>
> SUMMARY me the current auditor.md ;

---

**[assistant]**

Two sections:

**1. Fail-fast / early_disapprove**
- On first violation/incomplete/false/buggy finding → call `early_disapprove(reason)` immediately
- No further checking after 1 confirmed problem

**2. Custom-prompt fallback clause**
- Defines a valid approval path when all 4 hold:
  - 2 subagent attempts failed on infra (not complexity)
  - stub/mock created proving wiring/behavior
  - gap documented in plan/bug files
  - verifier-loop ≥2 verifiers unanimous APPROVE
- When met → live operational test NOT required; must approve

---

Status at end of turn 4: Content of auditor.md summarized. User then questions why paths differ. → Turn 5.
