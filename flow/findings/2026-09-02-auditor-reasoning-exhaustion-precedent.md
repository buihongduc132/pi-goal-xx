# 2026-09-02 — Auditor Reasoning-Budget Exhaustion (G5): Research + Precedent

Status: implemented (RED d1d542b → GREEN be5296f on wt-auditor-exhaustion).

## Taxonomy (industry-aligned)

Reasoning-model failure classes in agent-verification loops:

| Class | Signature | Correct handling |
|---|---|---|
| Truncation | partial text + finish_reason=length | continuation/retry with more budget |
| Exhaustion | EMPTY text + non-empty structured reasoning + no tool calls | classified error; raise max_tokens or swap model; NEVER parse as verdict |
| Genuine disapprove | text ending `<disapproved/>` | reject |

## External precedent (all verified real via GitHub API, 2026-09-02)

- NousResearch/hermes-agent PR #96973 (open) + issue #83915 — "detect structured
  reasoning budget exhaustion": finish_reason=length + empty content +
  non-empty reasoning_content + no tool_calls → exhaustion class, not generic
  retry. Detector previously only recognized inline `<think>` tags → missed
  structured reasoning fields (exactly goal-xx's gap).
- MoonshotAI/kimi-code #520, #3429 (open) — OpenAI-compatible thinking models
  return reasoning-only completions post-tool-call → APIEmptyResponseError.
- trpc-group/trpc-agent-go — "do not promote truncated GLM reasoning_content
  to final content" (reject, don't alias).
- pi-ai streams `thinking_delta` events (types.d.ts:271/279) — the evidence
  channel goal-xx now consumes.

## Local incident linkage

role-smart (bhd-litellm → glm-5.3) burned entire budget on reasoning_content:
0-byte text → G4 follow-up → still 0-byte → silent {approved:false} = user
perceived "auditor disabled". Full chain: pi-plugins LSL
`flow/lesson_learn/2026-09-02_goal-xx-auditor-perceived-disabled.md`.

## Test-count honesty note (audit CA1)

Suite counts on dbf7e34-lineage are env-nondeterministic (±7): investigator
observed 1617 tests/1531 pass/86 fail; independent audit repro 1624/1545/79;
hindsight 2026-08-14 recorded "83 pre-existing", 2026-08-15 "78→82".
TRUST direction (fail-sets identical, zero new failures), not exact counts.

## RED-commit detour note (audit CA3)

First RED run failed on fixture noise (`Configured auditor model not found:
omni-local/...` — global ~/.pi settings leak into test env) before
isolatedSettingsEnv() isolation was added to the test. Committed RED artifact
verified pure-contract RED post-hoc by independent audit.
