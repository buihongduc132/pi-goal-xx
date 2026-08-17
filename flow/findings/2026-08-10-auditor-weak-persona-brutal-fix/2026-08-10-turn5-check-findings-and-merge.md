# Explore Turn 5 — check-findings-and-merge

Date: 2026-08-10
Phase: explore
Status: findings merged

---

> **[user]** (verbatim — trust chain L1)
>
> Check @./flow/findings for me for the related findings , then review it and update if there is any gotcha;

---

**[assistant]**

Checked `flow/findings/` for related findings. Found:
- `2026-08-09-goal-prompt-override-append-mode/` — auditor context + dead prompt + override/append design
- `2026-07-31-auditor-capabilities-gaps/` — auditor capabilities + pre-audit hooks
- `auditor-config-design/` — auditor config exploration

Read key files:
- `2026-08-09-goal-prompt-override-append-mode/README.md`
- `2026-08-09-goal-prompt-override-append-mode/2026-08-09-locked-decisions.yaml`
- `2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn14-design-override-append.md`
- `2026-07-31-auditor-capabilities-gaps/README.md`
- `2026-07-31-auditor-capabilities-gaps/2026-07-31-turn2-decisions-locked.md`
- `flow/lesson_learn/2026-08-auditor-custom-prompt-dead-path.md`

Compiled comprehensive gotcha inventory (5 critical + 3 non-blocking):

## Critical Gotchas (G1-G5)

**G1 — DEAD PROMPT PATH (FIXED)**
- Symptom: Custom auditor persona in repo never loaded
- Root cause: Repo path `~/.pi/agent/git/.../prompts/auditor.md` ≠ resolver path `~/.pi/pi-goal-xx/prompts/auditor.md`
- Fix: Copy to correct path OR use settings.auditorPrompt inline
- Documented in LSL `2026-08-auditor-custom-prompt-dead-path.md`

**G2 — LEGACY PATH STILL WORKS (backward compat trap)**
- Legacy path `~/.pi/auditor-prompt.md` still consulted as fallback
- If both legacy + unified exist, unified wins but legacy silently ignored
- Stale legacy files confuse debugging

**G3 — OVERRIDE MODE ALWAYS APPENDS FACT LAYER**
- Cannot suppress objective/summaries/contract/checklist injection even in override mode
- Token budget impact: 50k cap - fact_layer_size
- 14KB objective → ~36KB persona budget

**G4 — INLINE ALWAYS WINS (even under mode: "off")**
- `settings.auditorPrompt` takes precedence over `mode`
- Can't disable via mode when inline set
- Must clear inline to fall through to files

**G5 — PRE-AUDIT HOOKS INJECT UNTRUSTED OUTPUT**
- Pre-audit hook output (max 5k chars) injected with `UNTRUSTED` marker
- Persona must ENFORCE verification (use read/bash/grep to cross-check)
- Default persona lacks this rule (W5 — no deflection-hunting)

## Non-Blocking Context Gotchas (G6-G8)

**G6 — HOT RELOAD IS MTIME-BASED (edge case: sub-second edits)**
- Two edits within same millisecond see stale cache
- Real-world impact: near-zero

**G7 — NO PER-GOAL PERSONA OVERRIDE**
- Settings are session/cwd-scoped, not per-goal-id
- Workaround: run goals in different cwd with different local settings

**G8 — GOAL PROMPT vs AUDITOR PROMPT (different keys)**
- `settings.goalPrompt` ≠ `settings.auditorPrompt`
- Fixing auditor persona does NOT fix goal runtime prompt

## Weak Origin Persona Gaps (W1-W5)

From upstream commit `1630a88` (Gaoge Zhang, 2026-05-12):

**W1** — Vague "semantic"
**W2** — No deliverable-count mandate
**W3** — Proxy-milestone loophole
**W4** — Fabricated evidence allowed by omission
**W5** — No deflection-hunting rule

---

Status at end of turn 5: Gotcha inventory compiled (G1-G8, W1-W5). Ready to merge into findings. → Turn 6.
