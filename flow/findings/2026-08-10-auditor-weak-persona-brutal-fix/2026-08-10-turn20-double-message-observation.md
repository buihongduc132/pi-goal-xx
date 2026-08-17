# Turn 20 — double-message-observation

Date: 2026-08-10
Phase: troubleshoot (initial)
Status: root cause identified

---

> **[user]** (verbatim — trust chain L1)
>
> Did you saw the  double message of the auditor in your view?

---

**[assistant]**

YES. Saw it. Every auditor report rendered twice in the user message - same `<approved/>` / `<disapproved/>` block duplicated word-for-word.

Examples from this conversation:
1. Goal `msmwoml8-1fmgj9` audit: "Audit Report" + `<approved/>` appeared twice
2. Goal `msn0eswf-4re521` audit: "Audit Report" + `<approved/>` appeared twice
3. Goal `mslz1ywk-ipyn2w` (beet-orches): Same double render

**Likely cause**: The auditor output is being appended to BOTH the completion event AND displayed as a separate message, or the UI is echoing the report once as "Auditor: ..." and once as the result content.

Want me to investigate where the duplication happens (goal.ts event emission vs UI rendering)?

---

Status at end of turn 20: Double-message bug observed. Root cause hypothesized (dual emission channels). User invokes troubleshoot cmd next.
