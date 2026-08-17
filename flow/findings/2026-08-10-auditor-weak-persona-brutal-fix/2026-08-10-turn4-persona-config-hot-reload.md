# Explore Turn 4 — persona-config-hot-reload

Date: 2026-08-10
Phase: explore (opsx:explore mode)
Status: answered (config layer exists)

---

> **[user]** (verbatim — trust chain L1)
>
> Do we currently having the layer of persona configuration / hot reload? we want to completely replace / append ;

---

**[assistant]**

*(explore mode — thinking, not implementing)*

Mapped current persona configuration landscape.

## Current Auditor Prompt Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AUDITOR PROMPT ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐                                               │
│  │  HARDCODED      │  ← Weak origin persona from upstream          │
│  │  DEFAULT        │     (Gaoge Zhang, 2026-05-12)                 │
│  │  PERSONA        │                                                │
│  └────────┬────────┘                                                │
│           │                                                         │
│           │ Combined via loadAuditorPrompt()                        │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              RESOLUTION PIPELINE                            │   │
│  │                                                             │   │
│  │  Priority order:                                           │   │
│  │  1. settings.auditorPrompt (inline) ──────────► OVERRIDE  │   │
│  │  2. settings.prompts.auditor.inline ──────────► OVERRIDE  │   │
│  │  3. File-based (per mode):                                │   │
│  │     ~/.pi/pi-goal-xx/prompts/auditor.md (global)          │   │
│  │     <cwd>/.pi/pi-goal-xx/prompts/auditor.md (local)       │   │
│  │  4. Hardcoded default (if nothing above)                  │   │
│  └──────────────────────────────────┬──────────────────────────┘   │
│                                     │                              │
│                                     ▼                              │
│           ┌───────────────────────────────────────┐               │
│           │  FACT LAYER (ALWAYS APPENDED)         │               │
│           │  - Goal objective                     │               │
│           │  - Completion summary                 │               │
│           │  - Verification summary               │               │
│           │  - Contract (if present)              │               │
│           │  - Audit checklist                    │               │
│           └───────────────────────────────────────┘               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Available Modes

```
┌──────────────────────┬────────────────────────────────────────────────┐
│ Mode                 │ Behavior                                       │
├──────────────────────┼────────────────────────────────────────────────┤
│ override             │ REPLACE hardcoded persona entirely             │
│                      │ (local > global, no merge)                     │
├──────────────────────┼────────────────────────────────────────────────┤
│ append               │ PREPEND hardcoded, then ADD file content      │
│                      │ (local > global)                               │
├──────────────────────┼────────────────────────────────────────────────┤
│ global-local         │ DEFAULT: PREPEND hardcoded, ADD file          │
│                      │ (local > global)                               │
├──────────────────────┼────────────────────────────────────────────────┤
│ local                │ PREPEND hardcoded, ADD local file only        │
├──────────────────────┼────────────────────────────────────────────────┤
│ global-local-merge   │ PREPEND hardcoded, ADD global + "\n\n" + local│
├──────────────────────┼────────────────────────────────────────────────┤
│ off                  │ Hardcoded only (files ignored)                │
└──────────────────────┴────────────────────────────────────────────────┘

INVARIANT: Fact layer (objective, summaries, contract) ALWAYS appended
           regardless of mode. The auditor must see the goal.
```

## Hot Reload Support

**YES** — via mtime-based file cache:

```typescript
// From prompt-resolver.ts
interface CacheEntry {
	mtimeMs: number;
	body: string | undefined;
}

const fileCache = new Map<string, CacheEntry>();

function readFileCached(absPath: string): string | undefined {
	// ... checks mtime, invalidates cache if file changed
}
```

When you edit a persona file, the next audit picks it up automatically. No restart needed.

## What You Can Do RIGHT NOW

### Option 1: Complete Override (Kill the Weak Persona)

```json
// <cwd>/.pi/pi-goal-xx-settings.json
{
  "prompts": {
    "auditor": {
      "mode": "override",
      "inline": "You are a forensic completion auditor.\\n\\nThe executor claims done. Your job: verify EVERY deliverable the objective names exists in inspectable form.\\n\\nMandatory gates:\\n1. COUNT deliverables when objective names a quantity\\n2. REJECT on fabricated evidence (missing hashes, phantom files)\\n3. REJECT on deflection (capability ≠ execution)\\n4. REJECT on proxy milestones (green CI ≠ user value)\\n5. If objective says 'MUST reject deflection', treat that as a gate invariant\\n\\n<approved/> only when ALL gates pass.\\n<disapproved/> on ANY gate violation."
    }
  }
}
```

**Effect:** Your inline text REPLACES the weak origin persona entirely. Fact layer still appended.

### Option 2: File-Based Override (for longer personas)

```bash
# Create the file
mkdir -p .pi/pi-goal-xx/prompts
cat > .pi/pi-goal-xx/prompts/auditor.md << 'EOF'
You are a forensic completion auditor.
...
EOF
```

```json
{
  "prompts": {
    "auditor": {
      "mode": "override"
    }
  }
}
```

**Effect:** File content REPLACES weak persona. Hot-reloads on edit (mtime cache).

### Option 3: Append to Weak Persona (Surgical Addition)

```json
{
  "prompts": {
    "auditor": {
      "mode": "append",
      "inline": "\\n\\n## ADDITIONAL MANDATORY GATES..."
    }
  }
}
```

**Effect:** Origin persona preserved, your rules appended after it.

## The Answer to Your Question

**Q: Do we have persona configuration / hot reload?**

**A: YES, FULLY WORKING.**

- **Complete replacement**: `mode: "override"` + inline or file
- **Surgical append**: `mode: "append"`
- **Hot reload**: Built-in via mtime cache, works on every audit
- **No code changes needed**: Pure config

The weak persona is fixable **right now** via settings file or prompt file. The infrastructure is already there.

---

## What's Missing (If You Want It)

The system does NOT have:

1. **Per-goal persona override** — settings are session/cwd-wide, not per-goal-id
2. **Runtime persona injection** — can't change persona mid-goal via tool call
3. **Persona versioning** — no built-in "use persona v2 for this audit"

But for your immediate need (fix the weak auditor), **override mode solves it today**.

Want me to draft a strong replacement persona, or do you want to explore other aspects?

---

Status at end of turn 4: Config layer confirmed (6 modes, hot-reload, inline/file sources). Ready to draft replacement persona or implement. → Turn 5.
