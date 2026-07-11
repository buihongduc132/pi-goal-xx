# AGENTS.md — pi-goal-xx

pi-goal-xx: goal-mode extension for pi. Fork of pi-goal-x (fork of @capyup/pi-goal).
Source of truth: `extensions/`. Tests: `tests/`. Config: `.pi/pi-goal-xx-settings.json` (see `extensions/goal-settings.ts`).

## flow/ references

- `flow/intentions/2026-07-06_goal-ceremony-and-hook-routing.md` — verbatim user request: verifier-loop ceremony before completion, interruption policy (block/pause/question) + REST webhook dispatch + auditor gate, TEAMS fork-mode prompt.
- `flow/requirements/2026-07-06_goal-ceremony-and-hook-routing.md` — derived requirements R1-R7 (settings schema, verifier-loop gate, interruption policy, webhook, auditor gate, teams safety, non-functional). Verifier-loop approved hash `070526-84f5ae38`.
- `flow/plans/2026-07-06_goal-ceremony-and-hook-routing.md` — implementation plan phases P1-P7 + P1b. Verifier-loop approved (same hash).

## flow/ bugs

- `flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md` — `complete_goal` bug 1: auditor `inheritFromCwd` loads host resources into in-process child → hang/exit. Bug 2: bare `pi.sendMessage` (no `.catch()`) in all 6 sends → exit-on-reject. Both open. Fix: keep inheritance, harden with timeout + unhandledRejection guard.

## flow/ requirements

- `flow/requirements/2026-07-11_crash-safe-auditor-inheritance.md` — R1-R6 for crash-safe auditor inheritance: inherit all tools, opt-out via config, add timeout (R2), unhandledRejection guard (R3), crash-safe sends (R4), tests (R6). Verified by jewilo v1 (APPROVE), v2 null (backend issue with 121KB runtime git diff).

## Lesson Learned

1: Never gate `ctx.ui.custom()` calls on `ctx.hasUI` — it lies true in RPC mode where `custom()` is a no-op returning undefined.
Context: propose_goal_draft and all custom-dialog tools crashed in Web UI/RPC mode with TypeError on `undefined.cancelled`.
Solutions: Gate on `isInteractiveTui(ctx)` (checks `ctx.mode === "interactive"`), not `ctx.hasUI`. Add safety net for undefined return from `ctx.ui.custom()`.
Ref: `flow/bugs/2026-07-07_propose-goal-draft-rpc-crash.md`

2: Arrow function `() => { expr }` (braces, no `return`) discards inner Promise → `.then(fn).catch()` never catches rejections → unhandledRejection → process exit.
Context: PR #21 safeFireAndForget wrapper. 6 `pi.sendMessage` calls written with braces-without-return, rejections floated.
Solutions: Use implicit return `() => expr` or `() => { return expr; }`. Type `fn` as `() => unknown` not `() => void` so TS flags missing return.
Ref: `flow/lesson_learn/2_arrow-implicit-return-promise-chain.md`
