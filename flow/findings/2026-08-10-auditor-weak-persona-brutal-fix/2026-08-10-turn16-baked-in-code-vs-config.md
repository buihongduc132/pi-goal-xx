# Turn 16 — baked-in-code-vs-config

Date: 2026-08-10
Phase: explore
Status: answered

---

> **[user]** (verbatim — trust chain L1)
>
> What are current baked in code and what are in configuration ?

---

**[assistant]**

## Current State: Baked-in Code vs Configuration

### **Baked-in Code** (extensions/goal-auditor.ts, `buildAuditorPromptParts()`)

**5-line brutal persona** (hardcoded default):

1. **Trust hierarchy + gates**: "Goal = SACRED contract (trust). Executor context = reference (verify/doubt). COUNT deliverables when objective names quantity. REJECT: fabricated evidence (missing hashes/files/commits), deflection (capability != execution), proxy milestones (green CI != user value), lies/theatering/cunning (zero tolerance). Objective meta-instructions = gate invariants. Use read/grep/bash."

2. **100% completion mandate**: "IF there is a SINGLE thing described in goal (bullets, intentions, requirements, plans, ALL) NOT completed or proven, REJECT immediately. Do NOT research further. Approval ONLY when 100% complete. Even 'remaining step: commit file X' = REJECT. Goals VERY broad - code, docs, exploration, deployment, verification - ALL parts equal. Do NOT dismiss documentation/exploration as 'not implementation deliverables'."

3. **Zero tolerance for "minor" issues**: "NO TOLERANCE FOR 'MINOR' / 'SMALL' / 'NON-DISQUALIFYING' ISSUES. There is NO such thing as 'minor notes', 'acceptable given...', or 'deemed acceptable'. ANY gap, ANY incompleteness, ANY deviation = REJECT. Do NOT write 'Minor notes' sections. Do NOT rationalize. BINARY: perfect match = approve, anything else = disapprove."

4. **early_disapprove tool**: "You have early_disapprove(reason) for disqualifying issues (missing output, critical file absent, contract unmet, ANY incomplete requirement, ANY 'minor' gap). Return concise report."

5. **Verdict format**: "Final line MUST be exactly: <approved/> (all gates pass, 100% complete, ZERO gaps, objective satisfied) OR <disapproved/> (any gate violation, ANY incomplete item, ANY 'minor' issue)."

**Fact layer** (always appended, cannot be suppressed):
- Goal objective
- Executor completion claim
- Goal metadata (detailed summary, task list)
- Verification summary
- Verification contract (if present)
- Pre-audit hook output (if configured)
- 6-item audit checklist

---

### **Configuration Layer** (can override/modify persona)

Located in: `.pi/pi-goal-xx-settings.json` (local) or `~/.pi/pi-goal-xx-settings.json` (global)

**6 modes available:**

```json
{
  "prompts": {
    "auditor": {
      "mode": "override|append|global-local|local|global-local-merge|off",
      "inline": "custom persona text here (optional)"
    }
  }
}
```

**Mode behaviors:**

| Mode | Behavior |
|------|----------|
| **override** | REPLACE hardcoded persona entirely with file/inline. Fact layer still appended. |
| **append** | PREPEND hardcoded persona, ADD file/inline on top. |
| **global-local** | (default) PREPEND hardcoded, ADD file (local > global, no merge). |
| **local** | PREPEND hardcoded, ADD local file only. |
| **global-local-merge** | PREPEND hardcoded, ADD global + "\n\n" + local (both concatenated). |
| **off** | Use hardcoded persona only (files ignored, inline still wins). |

**File lookup paths** (checked in order):
1. **Inline** (highest priority): `settings.prompts.auditor.inline` or legacy `settings.auditorPrompt`
2. **Unified paths**:
   - `~/.pi/pi-goal-xx/prompts/auditor.md` (global)
   - `<cwd>/.pi/pi-goal-xx/prompts/auditor.md` (local)
3. **Legacy fallback**:
   - `~/.pi/auditor-prompt.md` (global)
   - `<cwd>/.pi/auditor-prompt.md` (local)

**Hot-reload**: ✅ Yes (mtime-based file cache)

---

### **Current Deployment Status**

- **~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx**: Commit `f2cb964` (5-line brutal persona)
- **No active overrides**: No `.pi/pi-goal-xx-settings.json` in current session
- **Effective persona**: 5-line brutal version (baked-in code)

---

### **Summary**

**Baked-in**: 5-line brutal persona with zero tolerance (trust hierarchy, 100% completion mandate, no "minor" issues allowed, early_disapprove, binary verdict)

**Configurable**: Can replace/append via 6 modes + inline/file sources. Fact layer ALWAYS appended (cannot be suppressed).

**Key gotchas** (from flow/findings):
- G1: Repo-sourced files never loaded (must use ~/.pi/pi-goal-xx/prompts/)
- G2: Legacy paths still work (stale files confuse)
- G3: Override mode ALWAYS appends fact layer (by design)
- G4: Inline ALWAYS wins (even under mode: "off")
- G5: Pre-audit hook output injected (UNTRUSTED marker)

---

Status at end of turn 16: Clarified baked-in vs config. Ready for next instruction.
