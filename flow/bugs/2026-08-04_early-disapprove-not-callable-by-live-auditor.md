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

## Verification
- RED test: `tests/auditor-customtools-allowlist.test.ts` failed before fix
- GREEN test: passes after fix (2/2)
- Regression: 0 (7 pre-existing failures unchanged)
- Live auditor: STILL cannot call `early_disapprove` until pi restart

## Discovery Path
Setup-test goal (`.pi/goals/active_goal_..._mseoj3zo-t73kbt.md`) called completion to trigger auditor. Auditor rejected twice:
1. First rejection: revealed tool not in auditor's callable surface
2. Second rejection (post-fix): confirmed source fix correct but live process stale

## Lesson
Code fixes to extension behavior require pi process restart to take effect in the LIVE session that made the fix. Cannot verify extension-behavior fixes end-to-end within the same session that applied them.
