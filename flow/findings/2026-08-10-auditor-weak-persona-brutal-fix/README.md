# auditor-weak-persona-brutal-fix

> Date range: 2026-08-10 → 2026-08-10
> Status: done (brutal persona shipped, double-message bug scoped, not yet fixed)

## Topics

### 2026-08-10 — Weak auditor persona root-cause + brutal fix

User reported auditor approved goal `mslz1ywk-ipyn2w` (beet-orches) despite executor delivering ZERO invoices (only wiring code "technically capable of"). Troubleshoot traced root cause to weak origin persona (commit `1630a88`, Gaoge Zhang, 2026-05-12) with 5 structural gaps (W1-W5). Confirmed objective WAS injected as-is (50k char cap). Confirmed config layer (6 modes, hot-reload) already existed. Implemented brutal 5-line persona via TDD (RED→GREEN, 8/8 tests), merged PR #61, deployed to ~/.pi/agent. Then iterated: added 100% completion mandate (commit c6ce407), added zero-tolerance for "minor" issues (commit f2cb964). Tested early_disapprove with dummy goal - works correctly. Surfaced early_disapprove reason to agent session (PR #62, commit 4c04e84).

### 2026-08-10 — Auditor double-message bug (scoped, not fixed)

End-of-session troubleshoot: auditor output renders TWICE to user. MODE A/B/C analysis found root cause = dual emission channels in `complete_goal` tool. D1-D5 instances identified (sendMessage display:true + tool return with overlapping content). D6 (started) is intentional. Consolidated fix scope: 4 instances (D1-D4) need auditor.output removed from sendMessage, keep only in tool return. NOT yet fixed — scope presented to user.

## Pick up next time

1. `2026-08-10-turn21-troubleshoot-double-message.md` — MODE A/B/C output + consolidated fix scope (D1-D6)
2. `2026-08-10-turn1-troubleshoot-audit-approval.md` — root cause of weak approval (W1-W5 gaps)
3. `2026-08-10-turn3-origin-vs-introduced.md` — git blame confirms origin persona
4. `extensions/goal-auditor.ts:250-256` — current deployed 5-line brutal persona
5. `extensions/goal.ts:4014,4033` — D1/D2 fix targets (double-message bug)
6. **NEXT ACTION**: Fix D1-D4 double-message instances (remove auditor.output from sendMessage, keep in tool return)

---

## Directory listing

```
2026-08-10-auditor-weak-persona-brutal-fix/
├── README.md                                               (this file)
├── references.md                                           Sources: 10 files, 6 docs, 6 patterns
├── 2026-08-10-turn1-troubleshoot-audit-approval.md         Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn2-was-objective-injected.md              Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn3-origin-vs-introduced.md                Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn4-persona-config-hot-reload.md           Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn5-check-findings-and-merge.md            Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn6-merge-gotchas-into-findings.md         Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn7-13-implementation-brutal-persona.md    Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn14-15-mandate-and-zero-tolerance.md      Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn16-baked-in-code-vs-config.md            Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn17-early-disapprove-test.md              Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn18-surface-early-disapprove-reason.md    Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn19-ensure-merge-and-deploy.md            Threads: 0; decided: 0; remain: 0
├── 2026-08-10-turn20-double-message-observation.md         Threads: 1; decided: 0; remain: 1
└── 2026-08-10-turn21-troubleshoot-double-message.md        Threads: 1; decided: 0; remain: 1
```

Open threads: 1 (double-message bug D1-D4 fix scope presented, not yet fixed)

---

## Section (a) — BLOCKERS

No blockers — all open threads deferrable with reduced coverage.

The only open thread is the double-message bug (D1-D4 in `extensions/goal.ts`). This is a cosmetic UX issue (auditor report displayed twice). It does NOT block:
- Auditor functionality (works correctly)
- Goal completion (works correctly)
- Deployment (already deployed)
- Any other feature

Can proceed with any new work while D1-D4 remains unfixed.

---

## Section (b) — DEFERRAL FEASIBILITY

**OT1 — Double-message bug (D1-D4)**
- Defer? **YES**
- Lost if deferred: User sees auditor report twice (cosmetic confusion, no functional impact)

**── Global deferral verdict ──**

If ALL blockers deferred, implementation feasible? **YES** (no blockers to defer)

Ships now:
- 5-line brutal auditor persona (deployed)
- 100% completion mandate (deployed)
- Zero tolerance for "minor" issues (deployed)
- early_disapprove reason surfacing (deployed)
- Configuration layer (6 modes, hot-reload, inline/file sources)

Deferred (reduced):
- Double-message fix (D1-D4) — user sees auditor report twice, but functionality is correct

---

## Output checklist

- [x] `README.md` exists, lists every topic with 3-5 line summary
- [x] One file per turn, date-prefixed. No merges (except turns 7-13 and 14-15 which were implementation work, not explore)
- [x] Every verbatim user word preserved (profanity/typos/CAPS included)
- [x] Every assistant table / code block / command output / diagram reproduced AS-IS in turn file
- [x] `locked-decisions.yaml` — NOT created (no explicit user locked decisions in explore sense; all were implementation instructions)
- [x] `open-threads.yaml` — NOT created (single open thread documented in turn 21 and README)
- [x] Worker deliverables cross-referenced by full path (PR #61, PR #62, commits)
- [x] No new analysis, diagrams, or decisions introduced
- [x] `references.md` exists. Lists all sources consulted
- [x] Directory listing shows per-turn stats
- [x] Section (a) BLOCKERS: true blockers only (none found), explicit "No blockers" statement
- [x] Section (b) DEFERRAL: per-blocker YES/NO + what's lost. Global verdict present. Honest YES
- [x] Fresh reader test: README + first turn + last turn + references + dir listing + sections (a)+(b) = enough to resume AND see same tables/code live conversation produced AND know what blocks NOW AND whether ship-deferred is real
