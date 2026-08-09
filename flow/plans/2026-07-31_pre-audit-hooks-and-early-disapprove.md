# Plan — Pre-audit Hooks + Early Disapproval

> Date: 2026-07-31
> Source: `flow/findings/2026-07-31-auditor-capabilities-gaps/` (LD1-LD9, OT1-OT18)
> Branch: `feat/pre-audit-hooks-and-early-disapprove`

## Scope (LD coverage)

| LD | Topic | Scope |
|----|-------|-------|
| LD1 | Early disapproval (must implement) | Auditor tool `early_disapprove(reason)` |
| LD2 | Pre-audit hooks standalone system (must implement) | Settings + executor |
| LD3 | Defer cross-audit persistence | **NO WORK** (deferred) |
| LD4 | Structured output optional | **NO WORK** (optional, defer) |
| LD5 | Pre-audit hooks dynamic opt-in | `enabled` flag, no-op when unconfigured |
| LD6 | Hook output injection ≤5k chars | Sanitize + cap + inject into auditor prompt |
| LD7 | Global+local script chaining | AND semantics per OT11 |
| LD8 | Pre-audit hook YAML schema (nested block) | `passCriteria` sub-block |
| LD9 | Early disapproval signal mechanism | Tool call, not raw text_delta |

## Gotcha coverage during implementation

| OT | Severity | Mitigation in this plan |
|----|----------|-------------------------|
| OT8 | CRITICAL | Tool call signal (LD9) |
| OT9 | rank3 | `timeoutMs`, validate existence, fail-closed on crash |
| OT10 | rank3 | Sanitize ANSI/null/non-UTF8 + secret redaction + wrap markers |
| OT11 | rank3 | AND semantics for global+local |
| OT12 | rank4 | New `gateFailure?: string` field on `GoalAuditorResult` |
| OT13 | rank5 | Timeout on regex eval (Promise.race) |
| OT14 | rank5 | Wrap injected output in `<hook-output>...</hook-output>`, document untrusted |
| OT15 | rank5 | Out of scope for v1 (single-audit lock exists; documented residual) |
| OT16 | rank5 | Auditor tools are read-only → abort mid-tool-call is safe |
| OT17 | rank5 | Regex parser stays canonical; structured is extractive |
| OT18 | rank3 | Out of scope; rely on existing auditor-trace.jsonl + goal_events.jsonl |

## Files to touch

### New
- `extensions/pre-audit-hooks.ts` — `runPreAuditHooks(cwd, settings): Promise<HookResult>`, `sanitizeHookOutput`, `evaluateCriteria`, `validatePreAuditHooksConfig`
- `extensions/early-disapprove-tool.ts` — `earlyDisapproveTool` definition + `EARLY_DISAPPROVE_TOOL_NAME`
- `tests/pre-audit-hooks.test.ts` — RED tests
- `tests/early-disapprove.test.ts` — RED tests

### Modified
- `extensions/goal-settings.ts` — add `preAuditHooks` to schema, `asPreAuditHooksBlock`, `PreAuditHooksConfig` interface, `PreAuditHookPassCriteria` interface, ALLOWED_SETTINGS_KEYS, save round-trip
- `extensions/goal-auditor.ts` — add `early_disapprove` tool to customTools, detect `tool_execution_start` event for `early_disapprove` → abort, add `earlyDisapproved`/`earlyDisapprovalReason`/`gateFailure` to `GoalAuditorResult`, accept `preAuditContext` arg for injected hook output
- `extensions/goal.ts` — `complete_goal` handler: run pre-audit hooks BEFORE `runGoalCompletionAuditor`. On gate failure → short-circuit return (no auditor launch).

## TDD order (per goal_custom_prompt)

1. **RED phase** — 2 sub-agents in parallel write failing tests:
   - RED-A: pre-audit hooks tests (settings parse + executor + criteria eval + sanitize)
   - RED-B: early-disapprove tool tests (abort on tool_execution_start + result fields)
2. **GREEN phase** — 2 sub-agents in parallel implement:
   - GREEN-A: pre-audit-hooks.ts + goal-settings.ts changes
   - GREEN-B: early-disapprove-tool.ts + goal-auditor.ts changes
3. **INTEGRATION** — 1 sub-agent wires goal.ts → runPreAuditHooks → runGoalCompletionAuditor
4. **REFACTOR** — pass

## Done criteria

- `mise run check` (tsc) passes
- `npm test` passes (all existing + new RED tests green)
- LD1-LD9 coverage demonstrated in tests
- Settings round-trip preserves `preAuditHooks`
- No regression in `auditor-decision-parser.test.ts` (Bug #1 still fixed)
