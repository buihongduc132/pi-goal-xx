# Explore Turn 6 — merge-gotchas-into-findings

Date: 2026-08-10
Phase: explore
Status: merged

---

> **[user]** (verbatim — trust chain L1)
>
> Merge it in for me ;

---

**[assistant]**

Merged gotcha inventory into `flow/findings/2026-08-09-goal-prompt-override-append-mode/`.

Updated files:
1. `2026-08-09-goal-prompt-override-append-mode/README.md` — added auditor gotchas section
2. Created `2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn15-auditor-gotchas.md` — comprehensive reference with 3 fix options

README update (new section added):

```markdown
### 2026-08-09 — Auditor persona configuration gotchas (merged 2026-08-09T18:50)

**CRITICAL**: Weak origin persona from upstream (Gaoge Zhang, 2026-05-12 commit `1630a88`) has 5 structural weaknesses allowing deflection/fabrication bypass. Infrastructure for override exists (inline + file-based + hot-reload) but 5 critical gotchas identified:

- **G1 (DEAD PATH)**: Repo-sourced `auditor.md` at `~/.pi/agent/git/.../prompts/` never loaded...
- **G2 (LEGACY TRAP)**: Legacy path `~/.pi/auditor-prompt.md` still consulted as fallback...
- **G3 (FACT LAYER APPEND)**: Override mode replaces persona but ALWAYS appends fact layer...
- **G4 (INLINE ALWAYS WINS)**: `settings.auditorPrompt` takes precedence over `mode`...
- **G5 (HOOK OUTPUT INJECTION)**: Pre-audit hook output (max 5k chars) injected with `UNTRUSTED` marker...

**Non-blocking context gotchas**: G6 (mtime-based hot-reload edge case), G7 (no per-goal persona override), G8 (goal prompt vs auditor prompt are separate keys).

**Weak persona gaps** (from origin, not introduced by fork): W1 (vague "semantic"), W2 (no deliverable-count mandate), W3 (proxy-milestone loophole), W4 (fabricated evidence allowed), W5 (no deflection-hunting rule).

**Fix paths available NOW**: (1) Complete override via `settings.prompts.auditor.mode: "override"` + inline/file, (2) Surgical append via `mode: "append"`, (3) Hot-reload via mtime cache.
```

Gotcha reference doc created with:
- All G1-G8 gotchas (detailed)
- W1-W5 persona gaps (detailed)
- 3 fix options (override inline, override file, append)
- Cross-references to LSL, pre-audit hooks findings, source files

## Summary

Merged into README and created detailed reference file.

What I found:

1. **YES, you have persona config + hot reload** — fully working via `settings.prompts.auditor` with 6 modes (override/append/global-local/local/global-local-merge/off)

2. 5 critical gotchas identified:
   - G1 (FIXED): Dead prompt path — repo copy never loaded
   - G2: Legacy path trap — stale files silently ignored
   - G3: Override always appends fact layer (by design)
   - G4: Inline always wins (even under mode: "off")
   - G5: Pre-audit hooks inject untrusted output

3. Weak origin persona from upstream (Gaoge Zhang, 2026-05-12) has 5 structural gaps:
   - W1: Vague "semantic"
   - W2: No deliverable-count mandate
   - W3: Proxy-milestone loophole
   - W4: Fabricated evidence allowed by omission
   - W5: No deflection-hunting rule

Files updated:
- `flow/findings/2026-08-09-goal-prompt-override-append-mode/README.md` — added auditor gotchas section
- `flow/findings/2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn15-auditor-gotchas.md` — comprehensive reference with 3 fix options ready to use NOW

Fix paths ready:
1. Override mode (inline or file) — replaces weak persona entirely
2. Append mode — adds gates on top of weak persona
3. Hot-reload works via mtime cache — edit file, next audit picks it up

The infrastructure exists. The weak persona is fixable today via config. No code changes needed.

Want me to draft a replacement persona that closes W1-W5 gaps?

---

Status at end of turn 6: Gotchas merged into existing findings. Ready for implementation (user gives next instruction).
