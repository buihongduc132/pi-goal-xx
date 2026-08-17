# References

> Sources consulted during this explore/troubleshoot session.

## Source files

- `extensions/goal-auditor.ts` — auditor prompt construction (`buildAuditorPromptParts`), 5-line brutal persona (lines 250-256), `runGoalCompletionAuditor`, `GoalAuditorResult` interface
- `extensions/goal.ts` — `complete_goal` tool, rejection/approval message construction (L4014, L4033), `renderGoalAuditEvent`, `GOAL_AUDIT_ENTRY` message type, skip/bypass paths (L3644, L3726, L3905), 6 `display: true` sendMessage sites
- `extensions/goal-policy.ts` — `buildCompletionReport` function (constructs tool return with auditorReport)
- `extensions/auditor-prompt.ts` — `loadAuditorPrompt`, resolution order (inline → unified → legacy → default), `LoadAuditorPromptOptions` (factLayer invariant)
- `extensions/prompt-resolver.ts` — `resolvePrompt`, 6 modes, mtime-based file cache, `PromptMode` type
- `extensions/goal-settings.ts` — `GoalSettings`, `auditorPromptMode`, `prompts.auditor` config shape
- `extensions/early-disapprove-tool.ts` — `EARLY_DISAPPROVE_TOOL_NAME`, `earlyDisapproveTool`
- `extensions/auditor-log.ts` — audit trace logging

## Documents

- `flow/findings/2026-08-09-goal-prompt-override-append-mode/README.md` — auditor context + dead prompt + override/append design (merged gotchas into this)
- `flow/findings/2026-08-09-goal-prompt-override-append-mode/2026-08-09-locked-decisions.yaml` — LD1 (dead path), LD2 (fix applied), LD3 (no goal creation prompt injection)
- `flow/findings/2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn14-design-override-append.md` — Option B design (unified resolver + legacy fallback)
- `flow/findings/2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn15-auditor-gotchas.md` — comprehensive gotcha reference (G1-G8, W1-W5, 3 fix options) — created this session
- `flow/findings/2026-07-31-auditor-capabilities-gaps/README.md` — 4 gap questions, OT1+OT4 must implement, OT2 deferred, OT3 ok
- `flow/findings/2026-07-31-auditor-capabilities-gaps/2026-07-31-turn2-decisions-locked.md` — LD1-LD4, pre-audit hooks architecture (standalone, status/regex/AND/OR/negate, max 5k output injection)
- `flow/lesson_learn/2026-08-auditor-custom-prompt-dead-path.md` — G1 dead prompt path fix

## External sources

- Beet-orches goal archive: `beet-orches/.pi/goals/archived/goal_2026081000213131_mslz1ywk-ipyn2w.md` — the goal that triggered this investigation (auditor approved incomplete work)
- Git commit `1630a88` (upstream/main) — "Add independent goal completion auditor" by Gaoge Zhang, 2026-05-12 — weak persona origin
- PR #61: https://github.com/buihongduc132/pi-goal-xx/pull/61 — brutal persona replacement (commits a53ce60, 1582da3, merge 16598f0)
- PR #62: https://github.com/buihongduc132/pi-goal-xx/pull/62 — early_disapprove reason surfacing (commit 4c04e84)
- Commits c6ce407, f2cb964 — 100% completion mandate + zero tolerance for "minor" issues

## Code patterns

- **Dual emission anti-pattern**: `pi.sendMessage({ display: true, content: X })` + `return { content: [{ text: X }] }` in same tool execute() — causes duplicate UI rendering. Found in `complete_goal` (D1-D4), not in other tools.
- **Fact layer invariant**: `withFact(body) = body + factLayer` — fact layer ALWAYS concatenated regardless of mode, inline, or override. Invariant in `auditor-prompt.ts` `loadAuditorPrompt`.
- **Mtime-based hot-reload**: `readFileCached` checks `stat.mtimeMs`, invalidates cache on change. In `prompt-resolver.ts`.
- **Inline always wins**: `cfg.inline?.trim()` short-circuits before mode check, even under `mode: "off"`. In `prompt-resolver.ts` `resolveBlock`.
- **early_disapprove detection**: via `tool_execution_start` event ONLY (never via text_delta — OT8 rejects that as false-positive on quoted markers). In `goal-auditor.ts` subscribe callback.
- **Persona→factLayer split**: `buildAuditorPromptParts()` returns `{ persona, factLayer }` — override replaces ONLY persona, factLayer always appended. Enables "Goal data always injected" spec invariant.
