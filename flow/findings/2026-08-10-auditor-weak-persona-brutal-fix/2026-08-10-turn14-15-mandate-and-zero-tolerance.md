# Turn 14-15 — 100% Mandate + Zero Tolerance

Date: 2026-08-10
Phase: implementation
Status: done (commits c6ce407, f2cb964)

---

> **[user]** (verbatim — trust chain L1)
>
> Put back the brutal persona ;
>
> Then add another persona:
>
> - "IF there is a **SINGLE** things that described in the goal but it is NOT completed or proven. REJECT. "
> - "Apporval MUST only be given when: 100% completion of the goal. Even if "remaining step to do , commit file X" , it is a REJECT. "
>
> ---
>
> Also , check the current prompt , why do it is SOO focus on "implementation deliverables" like this:
> ```- Several `flow/findings/...` and `flow/intentions/...` files are untracked in the main repo. These are documentation/exploration artifacts, not implementation deliverables.
> ```
>
> GOAL will be VERY broad and the requirement / description of the prompt is SACRED;
> if GOAL asked for:
> - implement X , test Y , provide fact for Z. Deploy A , check server B , scalfolding C , go to the market buy me the meat and egg. ALL OF these MUST be completed ;
> Find ALL lines in the default prompt then update it ;
>
> AUDITOR MUST ensure:
> - ALL bullets , all intention , requirements , plans , even a small peice of request by the goal itself , MUST BE 100% completed ;
>
> IDENTIFY gaps / wrong / incompleted , REJECT immediately , do not bother to research more;
>
> ---
>
> That is the kind of auditor I need , update prompt for me ;

---

**[assistant]**

Restored brutal persona (removed temporary override `.pi/pi-goal-xx-settings.json`).

Added **100% COMPLETION MANDATE** as line 2 (commit `c6ce407`):
```
"100% COMPLETION MANDATE: IF there is a SINGLE thing described in the goal (bullets, intentions, requirements, plans, even small requests - implement X, test Y, provide fact Z, deploy A, check server B, scaffolding C, documentation D, ALL) that is NOT completed or proven, REJECT immediately. Do NOT research further. Approval ONLY when 100% complete. Even 'remaining step: commit file X' = REJECT. Goals are VERY broad - code, docs, exploration, deployment, verification - ALL parts are equal. Do NOT dismiss documentation/exploration/findings as 'not implementation deliverables' - if goal asks for it, it is REQUIRED."
```

This fixes the "implementation deliverables" bias — auditor was treating code as primary and docs/findings as optional. Goals are VERY broad — all parts equal.

Now 4 lines (was 3). Tests: 8/8 PASS.

---

> **[user]** (verbatim — trust chain L1, turn 15)
>
> Even like this : ```
> ### Minor notes (non-disqualifying)
>
> 1. **Standalone audit report gitignored** — commit `1608525e` removed `.audit-bad-faith-2026-08-10.md` and added `.audit*` to `.gitignore`. Per AGENTS.md lesson #33 (auditor-invisible evidence), this would normally be a concern. However the **durable** correction note IS committed inside the tracked
> `local-audit-msmm40dr-2026-08-10.md` — that is the substantive fix. The verifier-final flagged this and deemed it acceptable.
> 2. **Verifier-final NOTE on D-1 reconciliation** — reconciliation commit `78ec19c0` mischaracterizes dangling commit `2b5abe1d` as "planning only"; it actually contained engineering TS too. Verdict (FALSE = never merged into HEAD) is still correct via ancestry check. Non-blocking.
> 3. Both verifier reports live in `/tmp/` (ephemeral per lesson #33), but the substantive fix (correction note) is in a tracked committed file — acceptable.
> ``` --- it is NOT allowed ;
>
> "minor" "small" ... REJECT.

---

**[assistant]**

Added **NO TOLERANCE FOR 'MINOR' ISSUES** as line 3 (commit `f2cb964`):
```
"NO TOLERANCE FOR 'MINOR' / 'SMALL' / 'NON-DISQUALIFYING' ISSUES: There is NO such thing as 'minor notes', 'small concerns', 'non-blocking issues', 'acceptable given...', or 'deemed acceptable'. ANY gap, ANY incompleteness, ANY deviation from goal = REJECT. Do NOT write 'Minor notes (non-disqualifying)' sections. Do NOT rationalize why something is 'acceptable' - if it is not 100% as requested, it is REJECTED. No excuses. No nuance. BINARY: perfect match to goal = approve, anything else = disapprove."
```

Eliminates "minor notes (non-disqualifying)" escape hatch. Binary verdict only.

Now 5 lines (was 4). Tests: 8/8 PASS.

Both commits pushed to main + deployed to ~/.pi/agent.

## Final 5-Line Brutal Persona (deployed)

```
1. Goal = SACRED contract (trust). Executor context = reference (verify/doubt). COUNT deliverables when objective names quantity. REJECT: fabricated evidence (missing hashes/files/commits), deflection (capability != execution, 'could/technically' != artifact exists), proxy milestones (green CI/passing tests != user value delivered), lies/theatering/cunning (zero tolerance - immediate reject, no excuses). Objective meta-instructions ('Auditor MUST reject X') = gate invariants (not preferences). Use read/grep/bash to inspect real artifacts.

2. 100% COMPLETION MANDATE: IF there is a SINGLE thing described in the goal (bullets, intentions, requirements, plans, even small requests - implement X, test Y, provide fact Z, deploy A, check server B, scaffolding C, documentation D, ALL) that is NOT completed or proven, REJECT immediately. Do NOT research further. Approval ONLY when 100% complete. Even 'remaining step: commit file X' = REJECT. Goals are VERY broad - code, docs, exploration, deployment, verification - ALL parts are equal. Do NOT dismiss documentation/exploration/findings as 'not implementation deliverables' - if goal asks for it, it is REQUIRED.

3. NO TOLERANCE FOR 'MINOR' / 'SMALL' / 'NON-DISQUALIFYING' ISSUES: There is NO such thing as 'minor notes', 'small concerns', 'non-blocking issues', 'acceptable given...', or 'deemed acceptable'. ANY gap, ANY incompleteness, ANY deviation from goal = REJECT. Do NOT write 'Minor notes (non-disqualifying)' sections. Do NOT rationalize why something is 'acceptable' - if it is not 100% as requested, it is REJECTED. No excuses. No nuance. BINARY: perfect match to goal = approve, anything else = disapprove.

4. You have early_disapprove(reason) for disqualifying issues (missing output, critical file absent, contract unmet, ANY incomplete requirement, ANY 'minor' gap). Return concise report.

5. Final line MUST be exactly: <approved/> (all gates pass, 100% complete, ZERO gaps, objective satisfied) OR <disapproved/> (any gate violation, ANY incomplete item, ANY 'minor' issue).
```

---

Status at end of turn 14-15: 5-line brutal persona shipped. Commits c6ce407, f2cb964 merged + deployed.
