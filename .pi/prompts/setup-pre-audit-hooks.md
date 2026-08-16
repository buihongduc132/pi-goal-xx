---
name: setup-pre-audit-hooks
description: Configure pi-goal-xx pre-audit hooks — gate scripts, pass criteria, testing, debugging
argument-hint: "<purpose> [script-path]"
---

$ARGUMENTS

Make the cmd in the goal-xx about setting up the pre-audit hooks;

---

## GOAL

Set up pre-audit hooks in pi-goal-xx. Pass/fail gate script runs BEFORE completion auditor launches. Gate fail → audit skipped w/ `gateFailure` reason. Gate pass → auditor runs w/ hook output injected.

## Architecture (what exists — DO NOT recreate)

- `extensions/pre-audit-hooks.ts` — executor: `runPreAuditHooks`, `sanitizeHookOutput`, `evaluateCriteria`, `validatePreAuditHooksConfig`
- `extensions/goal-settings.ts` — `PreAuditHooksConfig` schema + `asPreAuditHooksBlock` parser
- `extensions/goal-auditor.ts` — gate wired in `runGoalCompletionAuditor` (lines ~639-645)
- `extensions/goal.ts` — `gateFailure` surfaced in rejection message

Settings schema (LD8):
```json
{
  "preAuditHooks": {
    "enabled": true,
    "globalScript": "/abs/path/check.sh",
    "localScript": "./.pi/hooks/pre-audit.sh",
    "passCriteria": {
      "status": 0,
      "regex": "PASS|SUCCESS",
      "stream": "both",
      "combinator": "AND",
      "negate": false
    },
    "injectOutput": true,
    "maxOutputChars": 5000,
    "timeoutMs": 30000
  }
}
```

## Steps — configure new hook

1. **WRITE hook script.**
   - bash, executable (`chmod +x`).
   - MUST exit 0 on pass, non-zero on fail.
   - Output (stdout+stderr) captured; sanitize strips ANSI/null/non-UTF8/secrets.
   - Example (test gate):
     ```bash
     #!/usr/bin/env bash
     set -euo pipefail
     npm test --silent
     ```

2. **PLACE script.**
   - Local: `<cwd>/.pi/hooks/pre-audit.sh` → `localScript: "./.pi/hooks/pre-audit.sh"`
   - Global: `~/.pi/hooks/pre-audit.sh` → `globalScript: "/home/user/.pi/hooks/pre-audit.sh"`
   - Both → chain (AND semantics, LD7).

3. **CONFIGURE `.pi/pi-goal-xx-settings.json`.**
   - Add `preAuditHooks` block per schema above.
   - `passCriteria.status`: expected pass exit code (default 0).
   - `passCriteria.regex`: match pass indicator in output (empty = skip regex).
   - `passCriteria.stream`: `stdout` | `stderr` | `both` (default both).
   - `passCriteria.combinator`: `AND` (status AND regex) | `OR` (either).
   - `passCriteria.negate`: invert result.

4. **TEST gate.**
   ```bash
   # Verify config parses
   node --experimental-strip-types -e "
     import { loadGoalSettings } from './extensions/goal-settings.ts';
     const s = loadGoalSettings('$PWD');
     console.log(s.preAuditHooks);
   "
   ```
   - Unknown nested keys → throws at load (additionalProperties: false).
   - Invalid stream/combinator → throws.

   ```bash
   # Verify executor behavior
   node --experimental-strip-types -e "
     import { runPreAuditHooks } from './extensions/pre-audit-hooks.ts';
     const r = await runPreAuditHooks('$PWD', { preAuditHooks: { enabled: true, localScript: './.pi/hooks/pre-audit.sh' }});
     console.log(r);
   "
   ```

5. **VERIFY end-to-end.**
   - Trigger `complete_goal` w/ gate configured.
   - Gate fail → result has `gateFailure: "<reason>"`, `disapproved: true`, no auditor session launched.
   - Gate pass → auditor runs, hook output injected into prompt.

## Steps — extend system (add new criteria / sanitization)

1. **RED test first.** Write failing test in:
   - `tests/pre-audit-hooks-settings.test.ts` (schema)
   - `tests/pre-audit-hooks-executor.test.ts` (behavior)
2. **GREEN implement.**
   - Schema change → `extensions/goal-settings.ts` (`asPreAuditHooksBlock` + `PreAuditHookPassCriteria` interface + `ALLOWED_SETTINGS_KEYS`)
   - Behavior change → `extensions/pre-audit-hooks.ts`
3. **VERIFY.**
   - `npx tsc --noEmit`
   - `node --experimental-strip-types --test tests/pre-audit-hooks-*.test.ts`
4. **UPDATE README** `## Pre-audit hooks` section + field reference table.

## Mistakes / lessons learned

- **DO NOT match raw text_delta for early disapproval** (OT8 CRITICAL). `parseAuditorDecision` uses last-occurrence b/c `<disapproved/>` appears mid-report as quoted evidence. Use dedicated tool call `early_disapprove(reason)` instead.
- **DO NOT inject raw hook output** (OT10). Sanitize first (ANSI, null, non-UTF8, secrets), THEN truncate to `maxOutputChars`. Wrap in `<hook-output>...</hook-output>` markers (OT14).
- **DO NOT skip ReDoS protection** (OT13). Wrap regex eval in `Promise.race` w/ 1s timeout. Catastrophic regex `(a+)+$` on 30 chars takes ~4s in V8 w/o protection.
- **DO NOT conflate gateFailure w/ error** (OT12). `gateFailure` = hook gate failed (disapproved). `error` = infra failure. Distinct fields on `GoalAuditorResult`.
- **DO NOT define global AND local negate globally** (OT11). Each hook evaluates own criteria independently. AND semantics: both must pass.
- **DO NOT skip timeoutMs** (OT9). Hanging script blocks `complete_goal` indefinitely. Default 30s.
- **Settings round-trip**: `saveGoalSettingsFileConfig` MUST persist `preAuditHooks`. Check both parse + save paths.
- **TDD order**: RED tests MUST reference modules that don't exist yet (import from `../extensions/...`). Tests compile via tsc but fail at runtime until GREEN.

## Tips

- Hook script must be executable: `chmod +x .pi/hooks/pre-audit.sh`.
- Use `set -euo pipefail` in bash hooks for fail-fast.
- For test gates: `npm test --silent` reduces noise.
- Inject output ON by default — disable if hook output sensitive.
- `maxOutputChars` caps CLEAN output (post-sanitization), not raw.
- Global hook runs first, then local. Both must pass (AND).
- Negate per-hook, not global.

## References

- `extensions/pre-audit-hooks.ts` — executor source
- `extensions/goal-settings.ts` — schema (`asPreAuditHooksBlock`)
- `extensions/goal-auditor.ts` — gate wiring (~line 639)
- `tests/pre-audit-hooks-settings.test.ts` — 29 schema tests
- `tests/pre-audit-hooks-executor.test.ts` — 42 executor tests
- `tests/goal-auditor-preaudit-integration.test.ts` — 6 integration tests
- `flow/findings/2026-07-31-auditor-capabilities-gaps/2026-07-31-locked-decisions.yaml` — LD2, LD5, LD6, LD7, LD8
- `flow/findings/2026-07-31-auditor-capabilities-gaps/2026-07-31-open-threads.yaml` — OT9-OT14
- `README.md` `## Pre-audit hooks` — user-facing docs
