# 7 — Reasoning-Budget Exhaustion Looks Like "Auditor Disabled"

## Context
2026-09-02: user reported goal-xx auditor "DISABLED by ANOTHER one". No
disabled:true anywhere. Real mechanism: auditor model role-smart (glm-5.3 via
LiteLLM router) spent 100% of completion tokens on reasoning_content → 0-byte
text verdict → fail-closed parseAuditorDecision("") → silent
{approved:false} with no error → indistinguishable from real rejection →
perceived "disabled". Stage-copy settings drift amplified it (see pi-plugins
LSL 2026-09-02).

## Symptom signature
- auditor-trace "end" entries: outputBytes=0, error="Auditor timeout…"
- model returns finish_reason=length, reasoning_content populated, content empty

## Solutions
1. G5 fix (commit be5296f): track thinking_delta chars/blocks; empty text +
   reasoning evidence → classified error "Auditor reasoning budget exhausted",
   {approved:false, disapproved:false}. Never marker-parse empty output.
2. Pin non-reasoning or adequately-budgeted auditor model
   (agy/gemini-3.7-flash-high works, e2e-proven 2026-09-02T14:01Z).
3. Deploy gates for plugin config files resolved outside agent dir.

## Ref
flow/findings/2026-09-02-auditor-reasoning-exhaustion-precedent.md
pi-plugins: flow/lesson_learn/2026-09-02_goal-xx-auditor-perceived-disabled.md
