# goal-prompt-override-append-mode

> Date range: 2026-08-09 → 2026-08-09
> Status: explore-ongoing + auditor-gotchas-merged

## Topics

### 2026-08-09 — Auditor context + dead prompt + override/append design

Investigated what context the auditor receives, discovered the auditor custom prompt at `~/.pi/agent/git/.../auditor.md` was DEAD (never on resolver path). Fixed by copying to `/home/bhd/.pi/pi-goal-xx/prompts/auditor.md`. Confirmed goal creation has NO custom prompt injection (runtime only). Designed Option B migration for `goal-prompt-resolver.ts` to support override/append/off modes via unified resolver with legacy fallback. One open question: override scope (custom block only vs full goalPrompt output).

### 2026-08-09 — Auditor persona configuration gotchas (merged 2026-08-09T18:50)

**CRITICAL**: Weak origin persona from upstream (Gaoge Zhang, 2026-05-12 commit `1630a88`) has 5 structural weaknesses allowing deflection/fabrication bypass. Infrastructure for override exists (inline + file-based + hot-reload) but 5 critical gotchas identified:

- **G1 (DEAD PATH)**: Repo-sourced `auditor.md` at `~/.pi/agent/git/.../prompts/` never loaded. Correct paths: `~/.pi/pi-goal-xx/prompts/auditor.md` (global) or `<cwd>/.pi/pi-goal-xx/prompts/auditor.md` (local). Fixed via LSL `2026-08-auditor-custom-prompt-dead-path.md`.
- **G2 (LEGACY TRAP)**: Legacy path `~/.pi/auditor-prompt.md` still consulted as fallback. If both legacy + unified exist, unified wins but legacy silently ignored (no warning). Stale legacy files confuse debugging.
- **G3 (FACT LAYER APPEND)**: Override mode replaces persona but ALWAYS appends fact layer (objective, summaries, contract, checklist). Cannot suppress. Token budget = (50k cap - fact_layer_size). 14KB objective → ~36KB persona budget.
- **G4 (INLINE ALWAYS WINS)**: `settings.auditorPrompt` takes precedence over `mode` (even `mode: "off"`). Can't disable via mode when inline set. Must clear inline to fall through to files.
- **G5 (HOOK OUTPUT INJECTION)**: Pre-audit hook output (max 5k chars) injected with `UNTRUSTED` marker but persona must enforce verification. Risk: malicious hooks inject misleading claims. (Cross-ref: `2026-07-31-auditor-capabilities-gaps` turn2a gotcha).

**Non-blocking context gotchas**: G6 (mtime-based hot-reload edge case: sub-ms edits see stale cache), G7 (no per-goal persona override — session/cwd-scoped only), G8 (goal prompt vs auditor prompt are separate keys: `goalPrompt` ≠ `auditorPrompt`).

**Weak persona gaps** (from origin, not introduced by fork): W1 (vague "semantic"), W2 (no deliverable-count mandate), W3 (proxy-milestone loophole: "technically capable" accepted), W4 (fabricated evidence allowed by omission), W5 (no deflection-hunting rule despite objective meta-instruction).

**Fix paths available NOW**: (1) Complete override via `settings.prompts.auditor.mode: "override"` + inline/file, (2) Surgical append via `mode: "append"`, (3) Hot-reload via mtime cache (works on every audit, no restart).

## Pick up next time

1. `2026-08-09-turn14-design-override-append.md` — design proposal + open question OT1
2. `2026-08-09-open-threads.yaml` — OT1 must be answered before implementation
3. `extensions/goal-prompt-resolver.ts` — file to migrate
4. `extensions/prompt-resolver.ts` — unified resolver to delegate to
5. Decide: should `override` replace only `<goal_custom_prompt>` block or entire `goalPrompt()` output?
6. **NEW**: Draft replacement auditor persona that closes W1-W5 gaps (deliverable counting, fabrication detection, deflection rejection, proxy-milestone gate, objective meta-instruction enforcement)
7. **NEW**: Consider separate finding for pre-audit hooks architecture (currently documented in `2026-07-31-auditor-capabilities-gaps` but hooks are STANDALONE system, not auditor-internal)
