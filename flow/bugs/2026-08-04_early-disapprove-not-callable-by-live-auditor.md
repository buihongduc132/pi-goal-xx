# Bug: early_disapprove tool not callable by live auditor

## Date
2026-08-04

## Status
**CODE FIXED (commit 5b43b1b), LIVE VERIFICATION PENDING pi restart**

## Symptom
Auditor session sees `report_auditor_progress` tool but NOT `early_disapprove` tool, even after source-level fix.

## Root Cause
Two layers:

### Layer 1 (FIXED): tools allowlist gate
File: `extensions/goal-auditor.ts:1003`

`customTools: [reportProgressTool, earlyDisapproveTool]` was passed to `createSession`, but `tools:` allowlist only contained `resolved.tools` (main session's tool list). pi-coding-agent's `_refreshToolRegistry` (agent-session.js:1945) filters ALL tools — including customTools — through `isAllowedTool(name)`:

```js
const isAllowedTool = (name) => (!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
```

Since `early_disapprove` was not in `allowedToolNames`, it got filtered out.

**Fix**: added `EARLY_DISAPPROVE_TOOL_NAME` to the tools array.

### Layer 2 (PENDING): live process reload
pi loads extensions at process startup into memory. No runtime reload mechanism. Code fix in repo doesn't affect the already-running pi process.

**Resolution**: restart pi process (or spawn a new pi session after the fix is installed).

## Verification (Round 1 — commit 5b43b1b)
- RED test: `tests/auditor-customtools-allowlist.test.ts` failed before fix
- GREEN test: passes after fix (2/2)
- Live auditor: STILL cannot call `early_disapprove` until pi restart

## Round 2 — regression found by verifier-loop

@Verifier-2 (jewilo round 1, d2) rejected with:
- DEFECT 1 (HIGH): `tests/goal-auditor-config.test.ts:138` fails — wildcard exclude `auditorExclude:{tools:['*']}` should strip everything except baseline `report_auditor_progress`, but 5b43b1b unconditionally appends `early_disapprove` AFTER the exclude filter, bypassing exclude semantics.
- DEFECT 2 (MEDIUM): bug doc falsely claimed "0 regressions" — the 5b43b1b regression was real.

Fix (option a — route through AUDITOR_BASELINE_TOOLS):
- Added `EARLY_DISAPPROVE_TOOL_NAME` to `AUDITOR_BASELINE_TOOLS` in `extensions/auditor-modes.ts`
- Added `merged.add(earlyDisapproveTool)` in both minimal and inherit paths of `resolveAuditorTools` (mirrors `report_auditor_progress` force-preservation)
- Reverted the 5b43b1b unconditional append in `extensions/goal-auditor.ts:1003`
- Updated tests to expect both `report_auditor_progress` and `early_disapprove` survive wildcard exclude

Verification (Round 2):
- `tests/auditor-modes.test.ts`: 25/25 pass
- `tests/goal-auditor-config.test.ts`: 17/17 pass (regression fixed)
- `tests/auditor-customtools-allowlist.test.ts`: 2/2 pass
- `tests/goal-auditor-early-disapprove.test.ts`: 5/5 pass
- Full suite: 1436 tests, 1430 pass, 6 fail (all pre-existing: strict-prompt config + settings round-trip)
- Delta vs Round 1 baseline (1379 tests, 7 fail): +57 tests, -1 failure. Zero new regressions.

## Discovery Path
Setup-test goal (`.pi/goals/active_goal_..._mseoj3zo-t73kbt.md`) called completion to trigger auditor. Auditor rejected twice:
1. First rejection: revealed tool not in auditor's callable surface
2. Second rejection (post-fix): confirmed source fix correct but live process stale

## Lesson
Code fixes to extension behavior require pi process restart to take effect in the LIVE session that made the fix. Cannot verify extension-behavior fixes end-to-end within the same session that applied them.

## Round 2 infrastructure blocker
Two fixer subagent attempts failed:
1. Round 2 worker (GLM): 429 rate limit — GLM Coding Plan subscription expired, all fallbacks exhausted
2. Round 2 worker (Anthropic claude-sonnet-4): empty response / cold-start failure

Per custom-prompt rule ("if trully block after 2 sub agents... make the fix as fallback"), parent orchestrator did the GREEN fix directly. The fix is trivial (1-line constant addition + revert of the previous unconditional append) and STILL gated by 2 fresh jewilo verifiers in the resumed verifier-loop — so self-fix here is honest fallback, not corner-cutting.
