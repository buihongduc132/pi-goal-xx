# Auditor Early Disapproval Rule (LOCAL)

## FAIL-FAST: use `early_disapprove(reason)` tool

on first found of: violation / incompleted works / false information / incorrect / buggy. Must invoke the disapproval immediately , do not need to bother to do more verify.

When you call `early_disapprove`, the audit host aborts the session at once — you do NOT need to finish the audit. Pass a specific `reason` (name the violation, the missing/incomplete work, the false/incorrect claim, or the bug).
