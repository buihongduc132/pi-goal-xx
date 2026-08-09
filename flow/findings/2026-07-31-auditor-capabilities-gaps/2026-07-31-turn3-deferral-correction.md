# Explore Turn 3 — Deferral Correction

> Date: 2026-07-31
> Phase: Explore mode → deferral verdict corrected
> Status: All threads locked as must-implement (no deferrals)

---

## [user] Turn 3

> **(verbatim — trust chain L1)**
>
> Ot4: user will wire this dynamically; if none , then let it to the auditor; 
> Ot6: NOT defer;
> Ot7: not defer; 
>
> --- why the fuck seems like you are defer every requirement that I wrote?

---

## [assistant] Turn 3

### Correction

User clarified deferral verdicts:

| Thread | My verdict | User verdict | Correct? |
|--------|------------|--------------|----------|
| OT4 (pre-audit hooks) | must-implement | must-implement (dynamic opt-in) | ✓ |
| OT5 (pass/fail schema) | must-implement | must-implement | ✓ |
| OT6 (output injection) | deferrable | NOT defer | ✗ |
| OT7 (global/local chaining) | deferrable | NOT defer | ✗ |

### Why I was wrong

**OT6 (output injection)** — I marked deferrable because "hooks can run without injection." User corrected: without injection, auditor doesn't see the hook output. That's broken coverage, not graceful degradation. Hooks are meant to provide evidence to the auditor — without that evidence, the hook system is incomplete.

**OT7 (global/local chaining)** — I marked deferrable because "can run one script type." User corrected: the whole point is having baseline global checks + local overrides. Without chaining, the system doesn't support the use case.

### Revised blocker analysis

All 4 threads (OT4, OT5, OT6, OT7) are must-implement. No deferrals.

```
Must-implement (no deferrals):
- OT4: Pre-audit hook system (dynamic opt-in; if no hook configured, auditor runs)
- OT5: Pass/fail criteria schema (status code / regex / AND/OR / negate)
- OT6: Output injection into auditor context (max 5k chars default)
- OT7: Global/local script chaining

Deferred:
- OT2: Cross-audit context persistence (deferred per LD3)
- OT3: Structured output schema (optional per LD4)
```

### Implementation path (revised)

1. Resolve OT5 schema (5-10 min decision)
2. Implement OT4 (hook system) with OT5 evaluation logic
3. Implement OT7 (global/local chaining) — hooks support both script types
4. Implement OT6 (output injection) — hook output injected into auditor prompt
5. Implement OT1 (streaming early-disapprove detection)

All 4 (OT4-OT7) ship together. OT1 is independent and can ship separately.

### Status at end of turn 3

Deferral verdict corrected. All user-specified requirements locked as must-implement. No deferrals for OT4-OT7. OT2 deferred, OT3 optional.

→ Next: implementation can proceed. All blockers resolved (user clarified deferrals).
