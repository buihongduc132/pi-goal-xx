# Auditor Capabilities Gaps

> Date range: 2026-07-31 → 2026-07-31
> Status: proposal-ready (decisions locked, deferrals corrected)

## Topics

### auditor-capabilities-gaps (2026-07-31)
Explored 4 gap questions about the pi-goal auditor: (1) early disapproval/fast-fail, (2) context persistence across audit launches, (3) structured output schema, (4) pre-audit CLI hooks as veto gates. All 4 analyzed against source code. Turn 2 locked decisions: OT1 + OT4 MUST implement (not defer); OT2 deferred; OT3 ok. Turn 3 corrected deferral verdicts: OT6 + OT7 are NOT deferrable (must implement). User clarified pre-audit hooks are STANDALONE system separate from auditor, with status/regex/AND/OR/negate pass criteria, optional output injection (max 5k chars), and global/local script chaining. 1 open thread remains for config schema details (OT5).

### gotcha-coverage (2026-07-31)
3 reviewer sub-agents analyzed all locked decisions and open threads for missed gotchas. Found 11 critical issues (OT8-OT18) across 3 severity tiers. **CRITICAL**: OT1 streaming detection as specified WILL cause false positives — must redesign signal mechanism before implementation. Other high-severity: ReDoS vulnerability in regex, prompt injection via hook output, concurrent execution conflicts, early abort tool safety. See appendix files: turn1a (early disapproval), turn2a (pre-audit hooks), turn3a (cross-cutting design).

## Pick up next time
1. `2026-07-31-open-threads.yaml` — 18 threads (OT1-OT7 resolved/deferred, OT8 resolved via LD9, OT9-OT18 open from gotcha-coverage, deferrable)
2. `2026-07-31-locked-decisions.yaml` — 9 locked decisions (LD1-LD9; LD8 auto-decided OT5 schema, LD9 auto-decided OT8 signal mechanism)
3. Appendix files: turn1a, turn2a, turn3a — detailed gotcha analysis (55 gotchas total)
4. Ready for step 50 (to-tasks) — all critical blockers resolved
