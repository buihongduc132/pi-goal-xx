# Finding — WHEN the pi-process-exits-after-completion bug started

**Date:** 2026-07-14
**Related:** `flow/bugs/2026-07-14_pi-process-exits-after-completion.md` (full root cause + 3-run repro)
**Question:** "Since WHEN or which commit did we encounter this?"

## Answer

**Bug became visible on 2026-07-04** (~10 days ago — matches the "like a plague" recurrence pattern). Two independent conditions had to collide in the global pi config before the bug could fire.

## The two necessary conditions

| # | Condition | Repo | Commit | Date |
|---|-----------|------|--------|------|
| 1 | `pi-print-clean-exit` extension exists (the killer) | pi-plugins | `9fa16754` "fix(print-mode): guarantee clean process exit (exit 0) in print/json mode" | **2026-06-19** |
| 2 | pi-goal-xx auditor `inheritFromCwd:true` (loads ALL host extensions) | pi-goal-xx | `043c16e` (#4) "feat(auditor): inherit cwd resources via DefaultResourceLoader" | **2026-07-03 23:12** |
| 3 | pi-goal-xx swapped in as the user's global goal extension (was npm `pi-goal-x`) | pi-plugins | `e0cfab97` "feat(deploy): switch pi-goal-x (npm upstream) → pi-goal-xx fork (git)" | **2026-07-04 10:52** |

## Why NOT before 2026-07-03

Fork-point `210d2cb` "Initial commit: fork of pi-goal-x v0.19.0" (2026-06-30) **already** had `SessionManager.inMemory` (in-process auditor — `goal-auditor.ts:323` at the fork), but did **NOT** have `inheritFromCwd`. The auditor loaded only its own minimal resources → never inherited `pi-print-clean-exit` → no exit possible.

Commit `043c16e` (#4) on 2026-07-03 flipped `inheritFromCwd` to `true` (via `makeAuditorResourceLoader` + `DefaultResourceLoader`) → auditor now loads all 53 host extensions including `pi-print-clean-exit` → bug became reachable.

## Why NOT before 2026-07-04

pi-goal-xx was not the user's global goal extension until commit `e0cfab97` in pi-plugins (2026-07-04). Before that, upstream `pi-goal-x` (npm) was used — different code, no `inheritFromCwd`, never inherited host extensions.

## Coincidence window

```
2026-06-19  pi-print-clean-exit created (pi-plugins)              ← condition 1 ready
2026-06-30  pi-goal-xx fork-point (no inheritFromCwd yet)
2026-07-03  inheritFromCwd lands in pi-goal-xx (#4)               ← condition 2 ready
2026-07-04  pi-goal-xx swapped into global pi config (e0cfab97)   ← bug VISIBLE from here
2026-07-14  root cause pinned via --trace-exit
```

Every goal completion since **2026-07-04** has exited pi. ~10 days of recurring "unresolved" reports.

## Distinct from the 2026-07-11 crash bug

The crash doc `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` describes a different symptom: hang-on-auditor-spawn + exit-on-reject (both fixed by PRs #24–#31, G1-G7). THIS bug is a clean `process.exit(0)` from a **completely different vector** — an inherited host extension deliberately calling `process.exit`. The G1-G3 guards (unhandledRejection / uncaughtException) cannot catch a deliberate `process.exit` call. Different failure class, different fix.

## Evidence

- Fork-point `210d2cb:extensions/goal-auditor.ts:323` — `SessionManager.inMemory(args.ctx.cwd)` present, no `inheritFromCwd`
- `043c16e` introduced `inheritFromCwd` via `DefaultResourceLoader` (pi-goal-xx)
- pi-plugins `9fa16754` created `pi-print-clean-exit` (2 files, 230 lines)
- pi-plugins `e0cfab97` swapped pi-goal-x → pi-goal-xx in `profile/settings.json`
- Full root cause + `--trace-exit` proof: `flow/bugs/2026-07-14_pi-process-exits-after-completion.md`

## Cross-repo note

This finding is mirrored in **pi-plugins** `flow/findings/2026-07-14_pi-process-exit-after-completion-timeline.md` — the killer (`pi-print-clean-exit`) lives there, so the fix locus (Option B — make the extension detect in-process child sessions) is also tracked in pi-plugins.
