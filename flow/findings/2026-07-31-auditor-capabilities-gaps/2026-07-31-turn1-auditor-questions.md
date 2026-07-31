# Explore Turn 1 — Auditor Capabilities Gap Analysis

> Date: 2026-07-31
> Phase: Explore mode (thinking, not implementing)
> Status: Analysis complete, no decisions locked

---

## [user] Turn 1

> **(verbatim — trust chain L1)**
>
> 1. do the auditor be able to disaprove early without having to go through all of the step? 2. does each launch of it having the context of the previous audit? 3. can we update it output to have fixed output condition base on approve / disapprove? 4. can we have the hooks BEFORE it is running to run some specific cli script or code , if it return FALSE then it is disapproved immediately without even need to hit the auditor itself ;

---

## [assistant] Turn 1

### Files Read (source investigation)

The following files were read to ground the analysis:

| File | Purpose |
|------|---------|
| `extensions/goal-auditor.ts` (1479 lines) | Main auditor implementation — `runGoalCompletionAuditor()` |
| `extensions/auditor-modes.ts` | Auditor resource resolution (inherit/minimal modes) |
| `extensions/auditor-prompt.ts` | Auditor prompt resolution (persona + fact layer) |
| `extensions/auditor-log.ts` | Trace logging (`auditor-trace.jsonl`) |
| `extensions/goal-auditor-subscriptions.ts` | Async event forwarding (informational only) |
| `extensions/goal-settings.ts` | Settings schema (grep for auditor config keys) |
| `extensions/command-hook-loader.ts` | Per-command hook system (pre/post/override) |
| `extensions/goal.ts` (grep) | `complete_goal` handler — calls `runGoalCompletionAuditor()` |

---

### Q1: Can the auditor disapprove early?

**No — not currently.** The auditor is a single LLM session (`session.prompt()`) that runs to completion. The LLM *can* decide to disapprove at any point during its reasoning, but there's no mechanism to short-circuit the session loop. It always runs through all tool calls + final text before returning.

What exists:
- Timeout ceiling (15min default) — kills it if it runs too long
- Abort signal (Esc) — user can manually kill it
- Verdict follow-up — if LLM produces no text, a nudge is sent

What's missing: a "fast-fail" where the auditor says "I see X is broken, stopping here" and returns immediately without finishing its checklist.

**Feasible?** Yes — could be done via:
- A tool the auditor can call to short-circuit (e.g. `early_disapprove(reason)`)
- Or streaming detection: watch `text_delta` for `<disapproved/>` appearing mid-stream → abort session immediately

---

### Q2: Does each launch have context of previous audits?

**No.** Each call creates a fresh in-memory session (`SessionManager.inMemory()`). Zero history carried over.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Audit #1    │     │  Audit #2    │     │  Audit #3    │
│  (fresh ctx) │     │  (fresh ctx) │     │  (fresh ctx) │
│              │     │              │     │              │
│  no memory   │     │  no memory   │     │  no memory   │
│  of #0       │     │  of #1,#0    │     │  of #2,#1,#0 │
└──────────────┘     └──────────────┘     └──────────────┘
```

The only persistent trace is `auditor-trace.jsonl` — forensic log, never fed back as input. So if the auditor disapproved 3 times for the same reason, it has no memory of those failures and might disapprove for the same reason again.

---

### Q3: Fixed output conditions based on approve/disapprove?

**Currently: free-form text + marker parsing.** The output is whatever the LLM produces, parsed by `parseAuditorDecision()` looking for the LAST `<approved/>` or `<disapproved/>` tag.

```
Output: "blah blah... <disapproved/>"
         ↓ parseAuditorDecision()
Result: { approved: false, disapproved: true }
```

There's no structured schema. The auditor prompt asks for "a concise audit report" but doesn't enforce fields.

**Could be done** with:
- A structured output schema (JSON mode or tool-based extraction)
- Required fields: `verdict`, `reason`, `evidence[]`, `missing[]`
- Different templates for approve vs disapprove paths

---

### Q4: Pre-audit hooks (CLI gate before auditor runs)?

**Not currently supported.** The existing hook system (`command-hook-loader.ts`) wraps command handlers (`/goals`, etc.) with pre/post/override — but the auditor is NOT a command handler. It's called directly from `complete_goal.execute`.

```
complete_goal
  → runGoalCompletionAuditor()     ← no hook layer here
    → createSession()
    → session.prompt()
```

**What you're describing** is a `preAudit` gate:

```
complete_goal
  → preAuditHook()                 ← NEW
    → run CLI script / code
    → returns FALSE? → immediate disapprove, skip auditor entirely
    → returns TRUE? → proceed to auditor
  → runGoalCompletionAuditor()
```

This is very doable. The integration point is in `goal.ts`'s `complete_goal` handler, right before calling `runGoalCompletionAuditor`. Could use:
- The existing `command-hook-loader` pattern extended to support `complete_goal` with a pre-hook that can veto
- Or a dedicated `preAuditChecks` setting (list of CLI commands / scripts to run)

---

### Architecture sketch for all 4

```
complete_goal
  │
  ├─ [Q4] preAuditGate
  │   ├─ run configured CLI scripts / code
  │   ├─ any returns FALSE → { disapproved: true, error: "pre-audit gate failed: <reason>" }
  │   └─ all pass → continue
  │
  ├─ [Q2] inject previous audit context?
  │   └─ read last N entries from auditor-trace.jsonl
  │      → append to auditor prompt as "previous audit history"
  │
  ├─ runGoalCompletionAuditor()
  │   ├─ [Q1] streaming verdict detection
  │   │   └─ text_delta contains <disapproved/> → abort session early
  │   │
  │   └─ [Q3] structured output
  │       └─ parse into { verdict, reason, evidence[], missing[] }
  │          instead of free-form text
  │
  └─ return GoalAuditorResult
```

---

### Status at end of turn 1

All 4 questions analyzed against source code. No decisions locked (explore mode). 4 open threads identified.

→ Next: open-threads.yaml captures the 4 threads. No locked decisions to record.
