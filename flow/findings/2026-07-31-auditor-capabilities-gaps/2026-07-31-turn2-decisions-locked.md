# Explore Turn 2 — Decision Lock + Architecture Clarification

> Date: 2026-07-31
> Phase: Explore mode → decisions locked
> Status: OT1 + OT4 locked (not defer). OT2 deferred. OT3 ok.

---

## [user] Turn 2

> **(verbatim — trust chain L1)**
>
> OT1: NOT DEFER; 
> OT2: defer; 
> OT3: ok; 
> OT4: not defer; 
>
> --- 
>
> What I mean as-is is only applied to the LAST layer; when the auditor actual run and outputting the <verdict> ; it can still early disapprove , it can have pre-audito hooks ; this hook is implemented SEPARATELY than the auditor itself , it is a completely standalone hooks that user choose to install or not into their pi system ; 
>
> HOOKS also must: 
> - be able to config global / local script to run ; 
> script will be fail / pass by: status code / regex match ; 
> pass could be config to: status AND OR regex match (or negate as well); 
>
> auditor can have option to inject that script output (default: max 5k chars) into their context ;

---

## [assistant] Turn 2

### Decisions locked

| ID | Thread | Decision | User words |
|----|--------|----------|------------|
| LD1 | OT1 (early disapproval) | NOT DEFER — must implement | "OT1: NOT DEFER" |
| LD2 | OT4 (pre-audit hooks) | NOT DEFER — must implement | "OT4: not defer" |
| LD3 | OT2 (context persistence) | Defer | "OT2: defer" |
| LD4 | OT3 (structured output) | OK — implement when convenient | "OT3: ok" |

### Architecture clarification from user

Key correction: "as-is" from turn 1 applies only to the LAST layer. The auditor itself, when running and outputting the `<verdict>`, can still:
- Early disapprove (OT1)
- Have pre-audit hooks (OT4)

Pre-audit hooks are **SEPARATE** from the auditor itself — a completely standalone hook system that the user chooses to install or not into their pi system.

### Hook system requirements (from user)

```
Pre-audit hook config:
├── Global script path (optional)
├── Local script path (optional)
├── Pass/fail criteria:
│   ├── Status code (exit 0 = pass, non-zero = fail)
│   ├── Regex match (stdout/stderr matches pattern)
│   ├── Combinator: AND / OR
│   └── Negate: true/false (invert the result)
└── Output injection:
    ├── Enable/disable (auditor sees script output)
    └── Max chars (default: 5000)
```

### Revised architecture (incorporating user clarification)

```
complete_goal
  │
  ├─ [OT4] preAuditGate (STANDALONE HOOK — user installs or not)
  │   ├─ global/local scripts configured
  │   ├─ pass/fail: status code / regex / AND/OR/negate
  │   ├─ FALSE → immediate disapprove, skip auditor
  │   └─ TRUE → proceed to auditor
  │       └─ optionally inject script output (max 5k chars default)
  │
  ├─ [OT2] DEFERRED — no cross-audit context injection
  │
  ├─ runGoalCompletionAuditor()
  │   ├─ [OT1] streaming verdict detection — early disapprove mid-stream
  │   │   └─ watch text_delta for <disapproved/> → abort session early
  │   └─ [OT3] structured output — ok (deferred or implemented)
  │
  └─ return GoalAuditorResult
```

### Implementation notes

**OT4 (pre-audit hooks)** — standalone system, separate from auditor:
- New settings keys: `preAuditHooks.enabled`, `preAuditHooks.globalScript`, `preAuditHooks.localScript`, `preAuditHooks.passCriteria` (status/regex/AND/OR/negate), `preAuditHooks.injectOutput` (bool), `preAuditHooks.maxOutputChars` (default 5000)
- Integration point: `goal.ts` `complete_goal` handler, before `runGoalCompletionAuditor()`
- Hook execution: spawn script → check exit code + regex → combine per criteria → pass/fail
- On fail: return `{ approved: false, disapproved: true, error: "pre-audit hook failed: <reason>" }` without calling auditor
- On pass: optionally append script output to auditor prompt (capped at maxOutputChars)

**OT1 (early disapproval)** — streaming detection:
- In `goal-auditor.ts` `session.subscribe()` callback, watch `text_delta` events
- When `text_delta` content contains `<disapproved/>` → call `safeAbort()` immediately
- Captures whatever output was produced before abort
- Returns `{ approved: false, disapproved: true, output: <partial> }`
- Benefit: saves time when auditor finds disqualifying issue early

### Status at end of turn 2

4 decisions locked (LD1-LD4). Architecture clarified. OT1 + OT4 are implementation blockers (must-do). OT2 deferred. OT3 optional.

→ Next: implementation phase can proceed. OT1 and OT4 are the must-ship features.
