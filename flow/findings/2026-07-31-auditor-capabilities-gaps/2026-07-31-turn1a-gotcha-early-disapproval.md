# Appendix to Turn 1 — Early Disapproval Gotchas

> Gotcha coverage for: Turn 1 (./2026-07-31-turn1-auditor-questions.md)
> Sub-agent: reviewer (8d55e7c5)
> Items reviewed: OT1, OT2, LD1, LD3

## Findings (ranked)

### Rank 5 (Sophisticated)

- **Prompt-injection / self-reference false-positive on the marker**
  - What: If the audited artifact (goal output, code, docs, user message) contains the literal `<disapproved/>`, and the auditor quotes/echoes it during analysis, the streaming detector aborts on the *quote*, not a verdict. Adversarial or accidental content can force an abort — a denial-of-service on the audit itself.
  - Why missed: Findings framed detection as "watch text_delta for marker," treating the auditor as the only emitter. Ignored that audited content is untrusted input that can appear in the stream.
  - Severity: False abort → goal never approvable; trivially weaponizable.
  - Mitigation: Detect marker only in a designated *verdict segment* (e.g., last assistant turn, or a fenced block), not anywhere in the cumulative buffer. Require the marker to be standalone on its own line / emitted by a tool call rather than free text.

- **Thinking/reasoning models emit the decision outside `text_delta`**
  - What: On models with separate reasoning/thinking streams (or tool-use blocks), the auditor may *decide* to disapprove during thinking and never repeat the marker in `text_delta` — or emit it inside a thinking delta the detector doesn't scan. Detection scoped to `text_delta` silently never fires.
  - Why missed: Decision assumes a single assistant-text channel. Modern auditors are often reasoning models.
  - Severity: Fast-fail never triggers on exactly the models most likely to be used as auditors.
  - Mitigation: Define the marker contract at the *event* level (which delta types count), scan reasoning deltas too, or require the marker via a structured tool call rather than prose.

- **Abort mid-tool-call leaves orphaned side effects**
  - What: Auditors often invoke tools (read files, run checks, write reports). If `<disapproved/>` streams *after* a tool call has begun but before its result is processed — or after a side-effecting tool (write/commit/shell) ran — the abort leaves half-applied state: partial file writes, open handles, uncommitted changes, held locks. "Fresh context per launch" then re-runs into the dirty state.
  - Why missed: Findings treated abort as session-level only; didn't model in-flight tool transactions.
  - Severity: State corruption, unreproducible re-audits, leaked resources.
  - Mitigation: Define an abort contract — either (a) auditor tools are strictly read-only so abort is always safe, or (b) abort waits for the current tool-call boundary, or (c) abort triggers a compensating rollback/cleanup hook.

### Rank 4 (Significant)

- **Token-boundary splitting of the marker**
  - What: Streaming APIs chunk arbitrarily. `<disapproved/>` can arrive as `<disap` + `proved/>`, or split across reasoning/text boundaries. Naive per-delta substring match misses every split case.
  - Why missed: Resolution says "watch text_delta for `<disapproved/>`" — implies exact-match per chunk.
  - Severity: Silent false-negatives; fast-fail degrades to never-fast-fail under adversarial chunking.
  - Mitigation: Rolling overlap buffer (length = marker − 1); match across buffer tail. Test with fixtures that split at every offset.

- **Marker variants the LLM actually emits**
  - What: Real models produce `<disapproved />` (space), `<disapproved>` (unclosed), `<DISAPPROVED/>`, `<disapproved></disapproved>`, leading whitespace, markdown-fenced, or a JSON `{"verdict":"disapproved"}`. Exact-string detection misses most.
  - Why missed: Lock fixes the canonical form with no tolerance spec.
  - Severity: High false-negative rate against real model output → feature appears to "not work."
  - Mitigation: Canonicalize before match (lowercase, strip whitespace, accept self-close or pair). Better: contract the auditor to emit via a tool call with a schema, not free text.

- **Race: abort fired against an already-finalized session**
  - What: If the full completion event and the marker-detection race (marker was in the final delta), the abort call hits a session that has already emitted `done`/`completed`. Depending on the SDK this is a no-op, a throw, or a second terminal event.
  - Why missed: No state machine for "detection fires after session is unabortable."
  - Severity: Spurious errors, double-completion, broken downstream listeners.
  - Mitigation: Abort must be idempotent and guarded by a session-state check (only abort if state ∈ {running}); log late-detection as "detected post-completion" instead of erroring.

- **No calibration of "disqualifying issue"**
  - What: "Disqualifying" is whatever the auditor LLM judges. An over-eager auditor aborts on nitpicks (goal never completes); a lenient one never aborts (fast-fail is dead code). There's no threshold, no allowlist of disqualifying categories, no human override.
  - Why missed: Decision assumes the marker is emitted only for genuinely disqualifying issues.
  - Severity: Feature effectiveness is entirely uncoupled from correctness; tuning is impossible.
  - Mitigation: Enumerate disqualifying categories in the auditor prompt; log the *reason* with every abort; expose an override/"not-disqualifying" path.

### Rank 3 (Moderate)

- **Combined amplification: early-abort × no cross-audit memory = N× redundant cost**
  - What: OT2's own note admits "disapproves 3× for same reason, no memory." Layering early-abort on top means each of those 3 runs is cut short *before* emitting a full rationale, so the human gets a terse reason 3× and the auditor re-derives the same conclusion 3×. The deferral and the implementation interact negatively.
  - Why missed: OT1 and OT2 analyzed in isolation; interaction unmodeled.
  - Severity: Wasted tokens, repeated user confusion, no accumulation of diagnostic detail.
  - Mitigation: On early abort, persist the *reason* (not full context) to a small append-only log the human reads, even though auditor context stays fresh. Cheap middle ground between "full memory" and "none."

- **"Fresh context" is not actually fresh if any resource inheritance exists**
  - What: LD3 says "fresh context per launch," but if the auditor inherits cwd, env, files, tool state, or a prior session's side effects (the general pattern for in-process child auditors), host state leaks in. "Fresh" is a claim, not a guarantee.
  - Why missed: Decision equates "no persisted audit memory" with "fresh context." They're orthogonal.
  - Severity: Non-determinism, hidden coupling, audits that pass/fail based on host residue.
  - Mitigation: Define "fresh" operationally — explicit allowlist of inherited inputs, hermetic cwd, no env leak. Test that two runs in different host states agree.

- **No audit trail / provenance when persistence is deferred**
  - What: Deferring cross-audit context also defers any historical record of *why* audits failed. For compliance, debugging, and "did the user actually fix this?", there's nothing to point at.
  - Why missed: Treated persistence only as auditor-working-memory, not as a system-of-record.
  - Severity: Undebuggable verdicts; no regression baseline; can't tell repeat-issue from new-issue.
  - Mitigation: Separate the two concerns — defer *auditor working memory* (justified), but keep a *verdict log* (reason + timestamp + run-id) outside the auditor context.

- **Concurrency: two "fresh" audits writing the same goal state**
  - What: Nothing in either decision addresses parallel/re-entrant audits of the same goal. Two fresh auditors can run, both write a verdict to goal state → last-write-wins or interleaved corruption.
  - Why missed: Single-auditor mental model throughout.
  - Severity: Lost verdicts, inconsistent state, indeterminate approval.
  - Mitigation: Goal-level lock or single-writer for audit verdicts; reject/queue duplicate audits.

- **No graceful degradation when the detector itself throws**
  - What: If the streaming matcher raises (regex error, buffer bug, transport hiccup), behavior is undefined — does the audit hang, abort, or run blind to completion?
  - Why missed: Happy-path only; detector treated as infallible.
  - Severity: Audit pipeline brittle to a peripheral component.
  - Mitigation: Wrap detector; on exception, fall back to a single post-completion full-scan and log the degradation. Never let detector failure block the verdict.

### Rank 2 (Minor)

- **Severity inversion in the locks**
  - What: OT1 (implement) is S3; OT2 (defer) is S4. The *deferred* item outranks the *implemented* one, yet the higher-severity concern is the one postponed.
  - Why missed: Severity assigned per-thread without cross-thread comparison.
  - Severity: Scheduling/attention misallocation; the bigger risk keeps getting deferred.
  - Mitigation: Re-rank in a shared matrix; flag that deferring an S4 needs an explicit revisit trigger, not just "deferred."

- **Protocol versioning of the marker**
  - What: `<disapproved/>` is a v1 wire protocol. No namespace/version. Evolving it (new reasons, structured payload, v2 schema) will collide with old detectors/auditors. No upgrade path defined.
  - Why missed: Treated as a one-shot string, not a versioned contract.
  - Severity: Future-breaking change with no migration story.
  - Mitigation: Add a version attribute now (`<disapproved version="1"/>` or a namespaced tag), even if unused; document the contract.

- **Idempotency / double-abort**
  - What: If the rolling buffer matches the marker twice (e.g., auditor restates it), or detection + a separate timeout both fire, abort runs twice. Non-idempotent aborts corrupt state.
  - Why missed: Single-match assumption.
  - Severity: Double terminal events, listener confusion.
  - Mitigation: Guard abort with an "already aborted" flag.

- **Cost/time accounting on partial abort**
  - What: Early abort still consumed input + partial output tokens and wall-clock. If telemetry only records completed runs, partial-abort cost is invisible.
  - Why missed: Abort treated as "stops cost."
  - Severity: Unattributed spend; can't compare fast-fail savings vs. overhead.
  - Mitigation: Emit a usage event at abort time with partial token counts.

- **No observability to tune detection**
  - What: No metrics defined for abort-rate, time-to-abort, false-positive (human-overturned) rate, or marker-emitted-but-missed rate. Without these, the feature can't be tuned and regressions are invisible.
  - Why missed: Decision is behavior-only, no instrumentation.
  - Severity: Feature ships blind; can't prove it works or improve it.
  - Mitigation: Define 3-4 core metrics at launch (abort count, mean time-to-abort, overturn rate, detector-exception count).

### Rank 1 (YAGNI)

- **No symmetric early-approval**
  - What: Only disapproval can fast-fail; approval always runs to completion. Not necessarily wrong, but the asymmetry is unstated and may surprise.
  - Why missed: Single-direction framing.
  - Severity: Cosmetic / expectation mismatch.
  - Mitigation: Document the asymmetry as intentional, or note early-approval as out-of-scope.

- **Buffer memory growth**
  - What: A rolling buffer to defeat token-splitting grows with audit length if unbounded.
  - Why missed: Buffer strategy unspecified.
  - Severity: Memory bloat on long audits.
  - Mitigation: Cap buffer at `2 × marker length`; drop prefix.

- **Entity-escaped / encoded marker**
  - What: If the stream entity-escapes (`&lt;disapproved/&gt;`) or wraps in markdown, raw match fails.
  - Why missed: Assumed raw text.
  - Severity: Edge-case false-negative.
  - Mitigation: Unescape before match, or use a tool-call contract that sidesteps encoding entirely.

## Cross-turn references
- Also relevant to: Turn 2 §architecture-clarification (OT1 locked decision), Turn 3 §deferral-correction (OT1 must-implement)
