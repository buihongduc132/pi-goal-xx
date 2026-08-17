# Finding — Goal Interruption Recovery UX (/goal-resume <short-id>)

> Date: 2026-08-11
> Phase: troubleshoot → fix → ship
> Status: merged + deploying

## Symptom [E1]

FX goal `msoqxrjk-juh1a0` (in `../beet-orches`) created 2026-08-11T14:19:09.104Z,
paused 0.87s later (14:19:09.978Z) with ledger `reason: "user"`. User saw:

```
Error: Request timed out.
Thinking...
Stale checkpoint — goal msoqxrjk-juh1a0 no longer active.
Goal paused
```

## Root Cause [C1]

**Stale session.** Deployed prod code (`~/.pi/agent/git/.../pi-goal-xx/extensions/goal.ts`)
can ONLY emit pause reasons `escape` (L1618) / `command` (L2430) — `PauseReason` type
has no `"user"` (goal-settings.ts:60). The `"user"` reason only exists in pre-`8c2de8c`
code (hardcoded `stopActiveGoal("paused", "user")`, replaced by parameterized `reason`
in commit `8c2de8c` on 2026-08-10).

The beet-orches pi session loaded pre-`8c2de8c` in-memory extension code (session started
before the deploy). First turn timed out → old abort-detection (removed in `d9c915a`) fired
→ `pauseActiveGoal()` with no args → `stopActiveGoal("paused", "user")`.

**Already resolved** by the deploy itself. New sessions load the fixed code.

## Pause Paths [E2] (deployed prod — goal.ts)

Only TWO pause sites remain (abort paths removed in `d9c915a`):
- L1618: `pauseActiveGoal(ctx, "escape")` — Esc key during active+autoContinue goal
- L2430: `pauseActiveGoal(ctx, "command")` — `/goal-pause` command

`"user"` CANNOT be emitted by current deployed code. Definitive (scout-confirmed).

## Shipped Fix [F1]

`/goal-resume <short-id>` — bypasses picker, focuses+resumes specific open goal.
Enables fast recovery from goal interruptions via command line.

- PR #63 squash-merged → commit `1b2b089` on `origin/main`
- `handleGoalResume(ctx, rawArgs?)` — mirrors `/goal-focus <short-id>` pattern
- Match by exact id or suffix; `confirmFocusOverride` before focus switch
- Picker fallback when no rawArgs (backward compat)
- 6 tests pass (3 original + 3 scout-recommended edge cases)
- Typecheck clean

## Verifier Loop [T1]

Reviewer subagent (run `13175c02`) returned **APPROVED**:
- [C1-6]: Correctness verified (matcher, confirmFocusOverride order, state.goal getter, picker fallback, stale-lock gate)
- [T1]: `tsc --noEmit` clean
- [T2]: goal-resume-by-id 6/6 pass; adjacent (headless-resume, stale-lock, focus-picker) 16/16 pass — no regressions
- [E1-5]: Edge cases verified
- [RISK]: Auditor persona untouched (diff empty on auditor-prompt.ts, goal-auditor.ts, prompts/goal-prompts.ts)

## Auditor Persona Integrity [E3]

Pre-deploy baseline (source = prod, md5 identical):
- `extensions/auditor-prompt.ts`: `93c7af63e8975b8f809d10aa4f336e73`
- `extensions/goal-auditor.ts`: `237673a149dccab6ad7e8151ab34bfb3`
- `extensions/prompts/goal-prompts.ts`: `046a10b55b61306739e11689057a8428`

Fix touches ONLY `extensions/goal.ts` (handleGoalResume) + new test file.
Zero auditor files modified.

## Deploy [T2]

pi-goal-xx is git-sourced in pi-plugins (`profile/settings.json`) as plain URL
`https://github.com/buihongduc132/pi-goal-xx` (no pin) → deploy pulls main HEAD
(`1b2b089`) automatically.

Chain: LOCAL → dev(3) → staging(2) → prod(1).
