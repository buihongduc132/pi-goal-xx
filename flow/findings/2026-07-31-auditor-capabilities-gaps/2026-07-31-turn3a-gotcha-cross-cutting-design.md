# Appendix to Turn 3 — Cross-Cutting Design Gaps

> Gotcha coverage for: Turn 3 (./2026-07-31-turn3-deferral-correction.md)
> Sub-agent: reviewer (2f22bac1)
> Items reviewed: LD4, OT1, OT4-OT7 (cross-cutting interactions)
> Note: This appendix is anchored to turn3 because it covers interactions between locked decisions across all turns.

## Findings (ranked)

### Rank 1 (Critical)

- **Streaming early-disapprove (OT1) directly contradicts last-occurrence parser**
  - What: `parseAuditorDecision` uses last-occurrence specifically because `<disapproved/>` can appear mid-report as quoted evidence while the final verdict is `<approved/>` (this was Bug #1 — the exact regression test in `auditor-decision-parser.test.ts:38-91`). OT1 proposes watching `text_delta` for `<disapproved/>` mid-stream → abort immediately. This will false-positive on any auditor output that quotes/displays the disapproved marker in body text.
  - Why missed: OT1 was analyzed as "watch text_delta for marker → abort" without cross-referencing the parser's last-occurrence fix. The two mechanisms have fundamentally incompatible assumptions about marker semantics.
  - Severity: Auditor aborts on legitimate approve reports that mention disapproval as evidence. Goal completions blocked that should pass.
  - Mitigation: Streaming detection must NOT match raw `<disapproved/>` in text deltas. Options: (a) only trigger on a dedicated tool call (`early_disapprove(reason)`), (b) require the marker to appear at the END of a complete message turn (buffer until assistant turn completes, then check last marker — but this defeats the purpose of streaming), or (c) use a different sentinel for streaming (e.g., a specific tool call or a structured first-token signal).

### Rank 2 (High)

- **Hook output injection (OT6) poisons streaming detection (OT1)**
  - What: OT6 injects up to 5k chars of hook output into the auditor prompt. If that output contains the literal text `<disapproved/>` (e.g., a test failure log quoting the marker, or a previous auditor trace), and the auditor echoes/quotes any of it back in its response, OT1's streaming detector fires prematurely.
  - Why missed: OT1 and OT6 were analyzed independently. Their interaction creates a prompt-injection-like vector where hook output reaches the auditor's output stream.
  - Severity: False early abort whenever hook output contains marker-like text.
  - Mitigation: If OT1 is implemented, it must use a signal that cannot appear in injected text (see Rank 1 mitigation). This interaction further argues against raw text-delta matching.

### Rank 3 (High)

- **No hook execution timeout specified (OT4)**
  - What: The auditor has `auditorTimeoutMs` (15min default) and `auditorTimeoutFloorMs`. Pre-audit hooks have no timeout. A hanging script (waiting for network, deadlocked, interactive prompt) blocks `complete_goal` indefinitely.
  - Why missed: The explore session focused on hook pass/fail criteria (OT5) and chaining (OT7) but didn't specify execution constraints for the hook runner itself.
  - Severity: `complete_goal` hangs forever → agent session stuck → user must Esc-abort.
  - Mitigation: Add `preAuditHooks.timeoutMs` (default 30s, configurable). Use `AbortController` + `setTimeout` to enforce. On timeout: treat as hook failure with clear error message.

### Rank 4 (Moderate)

- **Hook failure vs auditor error — semantic collision in GoalAuditorResult**
  - What: `goal.ts:3904` computes verdict as `auditor.approved ? "approved" : auditor.error ? "error" : "disapproved"`. When a pre-audit hook fails, the plan says return `{ approved: false, disapproved: true, error: "pre-audit hook failed: <reason>" }`. But setting BOTH `disapproved: true` AND `error` means the verdict becomes "error" (not "disapproved") per the ternary. The ledger records `verdict: "error"`, the rejection message shows "Auditor error: pre-audit hook failed", and the user sees a fundamentally different message than "goal not ready."
  - Why missed: The hook failure return shape was specified without tracing through the existing verdict classification in `goal.ts`.
  - Severity: User sees confusing "Auditor error" instead of "pre-audit check failed". Semantically wrong — hook failure is a gate, not an auditor malfunction.
  - Mitigation: Either: (a) add a new field `gateFailure?: string` to `GoalAuditorResult` and handle it in `goal.ts` before the auditor runs, or (b) set `error` only for infrastructure failures and use `disapproved: true` alone for hook gate failures (with the hook reason embedded in `output`).

### Rank 5 (Moderate)

- **"Optional" structured output (LD4) creates permanent dual-path maintenance**
  - What: If structured output is "implemented when convenient", the codebase will have `parseAuditorDecision()` (regex) AND a structured parser. The regex path must remain as fallback because LLMs don't always comply with schemas. Both paths need test coverage. The "optional" path will get zero coverage until someone notices it's broken.
  - Why missed: LD4 treats structured output as additive ("nice to have") without analyzing the maintenance cost of two parallel parsing strategies.
  - Severity: Low immediate risk, but the dual path will accumulate drift. Structured path will silently break on schema changes.
  - Mitigation: If LD4 stays "optional", document explicitly that the regex parser remains the canonical path and structured output is extractive (post-parse enrichment), not a replacement. The structured parser must ALWAYS fall through to `parseAuditorDecision()` on any schema violation.

### Rank 6 (Moderate)

- **Global vs local hook interaction undefined (OT7 × OT5)**
  - What: OT5 defines pass/fail criteria (status/regex/AND/OR/negate) for individual hooks. OT7 requires global+local chaining. But: if global hook passes and local hook fails, is the overall result pass or fail? Is it AND (both must pass) or OR (any passes)? What if global says "negate" and local doesn't?
  - Why missed: OT5 and OT7 were resolved in separate turns. Their intersection (how criteria compose across the chain) was never addressed.
  - Severity: Implementer will guess, likely getting it wrong. User confusion when global hook passes but local overrides it (or vice versa).
  - Mitigation: Define explicitly: global AND local must both pass (AND semantics). Each hook evaluates its own criteria independently. Negate applies per-hook, not globally. Document this in the spec before implementation.

### Rank 7 (Low-Moderate)

- **Hook output binary/encoding hazard (OT6)**
  - What: "max 5k chars" injected into auditor prompt. But script output may contain ANSI escape codes, null bytes, UTF-16 BOM, or binary garbage. This gets concatenated into the auditor prompt string.
  - Why missed: The explore session specified char count limit but not sanitization.
  - Severity: Auditor prompt corruption → LLM confusion → bad verdict. Worst case: prompt injection via crafted script output.
  - Mitigation: Strip ANSI, null bytes, and non-UTF-8 before injection. Truncate at 5k chars AFTER sanitization, not before.

### Rank 8 (Low)

- **auditor-trace.jsonl schema evolution**
  - What: `buildEndEntry` takes `output: string`. If structured output is eventually added, the trace needs to store both the raw output and the parsed structure. No forward-compatibility in the trace schema.
  - Why missed: Trace format was designed for free-form only. LD4's "when convenient" doesn't account for the trace needing to evolve.
  - Severity: Low — trace is forensic, not functional. But post-hoc analysis of structured verdicts will be awkward.
  - Mitigation: Add optional `structuredVerdict?: object` field to `buildEndEntry` now (even if always undefined). Cheap insurance.

## Summary

- **Rank 1 (Critical):** OT1 streaming detection as specified WILL cause false positives on any report that quotes disapproval markers. Must be resolved before implementation.
- **Cross-cutting misses:** OT1 and OT6 interaction; OT7 and OT5 interaction; LD4 maintenance cost.

## Cross-turn references
- Also relevant to: Turn 1 §Q1 (OT1 origin), Turn 2 §architecture-clarification (OT1 locked decision + OT6 injection)
