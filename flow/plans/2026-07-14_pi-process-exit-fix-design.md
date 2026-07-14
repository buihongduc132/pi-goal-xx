# Design — Robust fix for pi-process-exits-after-completion

> Date: 2026-07-14
> Owner: w1-design-fix
> Status: **DESIGN ONLY — no code changed**
> Bug: `flow/bugs/2026-07-14_pi-process-exits-after-completion.md`
> Timeline: `flow/findings/2026-07-14_pi-process-exit-after-completion-timeline.md`
> Verifier: run the mental loop in §6 before implementation.

## 0. Bug in one paragraph

`pi-print-clean-exit` arms a `.unref()`'d `setTimeout(process.exit, 1500)` on `agent_end` in headless (`print`/`json`) mode. pi-goal-xx's completion auditor runs **in-process** (`SessionManager.inMemory` + `inheritFromCwd`, `goal-auditor.ts:738-749, 495-501`) and **inherits all 53 host extensions** including the killer. The auditor child session runs with headless `ctx.mode`, fires `agent_end` → arms the timer → ~1.5s later `process.exit(0)` kills the **host** TUI process (same Node process). G1–G3 unhandledRejection guards cannot intercept a deliberate `process.exit`. Proven by `--trace-exit` (Run 3).

## 1. Chosen approach — **A+ (content-scan exclude) ⊕ B+ (sentinel self-guard)**

Belt AND suspenders. Either fix alone closes the bug; together they survive independent regressions in either repo. **Both ship.**

> **Deploy dependency (clarified 2026-07-14 during verifier loop).** A+ is the
> LOAD-BEARING fix and is complete + verified entirely within this repo: it
> excludes any `process.exit`-calling extension from the auditor's inherited
> set, so the killer never loads in the child and the timer is never armed.
> A+ ALONE fully fixes the bug. B+ is a PRODUCER in this repo + a CONSUMER in
> the separate **pi-plugins** repo (`profile/extensions/pi-print-clean-exit`,
> committed `81f2cebf`). The B+ producer is correct, race-free, tested for
> set/clear (Zones 2-4) and for enabling a sentinel-honoring consumer to
> self-skip during the audit window (Zone 5). Until the pi-plugins consumer
> (`81f2cebf`) is **deployed**, B+ is producer-only and harmless, and A+ holds
> alone. The cross-repo consumer deploy is a tracked dependency, NOT a defect
> in this PR. Deploying it is out of scope for the pi-goal-xx PR.
>
> Note: the commit message of `8fe563d` phrases B+ as "pi-print-clean-exit reads
> this to self-skip" — accurate as design intent / forward contract, but not yet
> true in any deployed stage until pi-plugins `81f2cebf` ships. That message is
> immutable here (rebase is blocked by the environment safety hook); the
> authoritative, current scoping lives in this section and the PR description.

| Layer | Where | What | Survives |
|-------|-------|------|----------|
| **A+ (primary)** | pi-goal-xx `makeAuditorResourceLoader` | Exclude any inherited extension whose **source contains `process.exit(`**. Content-scan, not a static name list → self-maintaining. | "new process.exit extension added to pi-plugins later" |
| **B+ (secondary)** | pi-plugins `pi-print-clean-exit` | Skip arming when `globalThis.__PI_GOAL_AUDITOR_IN_PROCESS__ === true`. Sentinel set/cleared by pi-goal-xx around `createSession`. | "pi-goal-xx inheritance re-enabled after refactor" / "3rd party spawns in-process child that reuses the sentinel" |

**Rejected:**
- **Option C (out-of-process auditor)** — correct and the documented ultimate fix, but a multi-week refactor (IPC, resource isolation, MCP re-exposure). Tracked as residual in §7. Do NOT block the robust fix on it.
- **Option D (process.exit monkey-patch)** — fragile; `process.exit` override can be defeated by `Reflect.apply`, worker threads, or a future Bun change. Rejected.
- **Static name exclude list (Option A as originally worded)** — goes stale the moment a new `process.exit`-calling extension lands. Replaced by A+ content-scan.

## 2. File:line change list

### 2.1 pi-goal-xx — A+ content-scan exclude

**File:** `extensions/goal-auditor.ts`

**(a) New helper `isProcessExitExtension` (insert after `isGoalSelfExtension`, ~line 334).**
Scans extension source text for the literal token `process.exit` (case-sensitive, not a regex — avoids ReDoS and false positives on `process.exited`). Reads source via `node:fs.readFileSync(e.path ?? e.resolvedPath, "utf8")` with a hard 2 MB cap (skip+log if larger; extensions are tiny). Wrapped in try/catch → on read failure, **exclude** (fail-closed: a killer we can't read is more dangerous than a false exclude of an unreadable extension).

```ts
const PROCESS_EXIT_TOKEN = "process.exit";
const MAX_EXIT_SCAN_BYTES = 2 * 1024 * 1024;

function extensionCallsProcessExit(extPath: string | undefined): boolean {
	if (!extPath) return false; // can't read → don't exclude by this rule (isGoalSelfExtension handles goal.ts)
	try {
		const src = require("node:fs").readFileSync(extPath, "utf8");
		if (src.length > MAX_EXIT_SCAN_BYTES) return true; // too big to scan → fail-closed exclude
		return src.includes(PROCESS_EXIT_TOKEN);
	} catch {
		return true; // unreadable → fail-closed exclude (defense-in-depth)
	}
}
```

> `require("node:fs")` at call site avoids adding an import to a file that already imports 20+ symbols; alternatively hoist to a top-level `import { readFileSync } from "node:fs"`. Implementer's choice — prefer the import for cleanliness.

**(b) Extend the filter in `makeAuditorResourceLoader.getExtensions` (line 347-352).**
Add the content-scan clause alongside the existing `isGoalSelfExtension` check:

```ts
const filtered = all.extensions.filter((e) => {
	if (isGoalSelfExtension(e.path) || isGoalSelfExtension(e.resolvedPath)) return false;
	// A+: never inherit any extension that calls process.exit — an in-process
	// auditor child shares the host's process; a deliberate process.exit in an
	// inherited extension kills the host TUI. Content-scan (not a name list)
	// so newly added process.exit extensions are caught automatically.
	if (extensionCallsProcessExit(e.path) || extensionCallsProcessExit(e.resolvedPath)) return false;
	return extAllow.has(e.path) || extAllow.has(e.resolvedPath);
});
```

**(c) Forensic log: extend the `pre-createSession` trace entry (line 605-613)** to record which extensions were excluded by the process.exit rule, so a future regression is visible in the audit trace:

```ts
const exitExcluded = all.extensions
	.filter((e) => extensionCallsProcessExit(e.path) || extensionCallsProcessExit(e.resolvedPath))
	.map((e) => e.path ?? e.resolvedPath);
// → add `exitExcludedExtensions: exitExcluded` to the pre-createSession trace entry
```

### 2.2 pi-goal-xx — B+ sentinel set/clear

**File:** `extensions/goal-auditor.ts`

**(d) Set sentinel BEFORE `createSession` (line ~650, right after the G1 guards install, before the `try { try { const created = await Promise.race([createSession(...` block at 738).**

```ts
// B+: mark the in-process audit window so any inherited process.exit-calling
// extension can self-skip. globalThis (not env) — env is inherited by the host
// shell and would leak; globalThis is scoped to this process and this window.
(globalThis as any).__PI_GOAL_AUDITOR_IN_PROCESS__ = true;
```

**(e) Clear sentinel in the OUTER finally (line ~1230, alongside G1/G2/G3 cleanup).** Must clear on EVERY path (success, timeout, abort, throw). Use `delete` not `= false` so a `in` check is unambiguous.

```ts
try { delete (globalThis as any).__PI_GOAL_AUDITOR_IN_PROCESS__; } catch {}
```

> Place this line FIRST in the outer finally, before listener removal, so even if a later cleanup line throws the sentinel is already cleared.

### 2.3 pi-plugins — B+ self-guard

**File:** `profile/extensions/pi-print-clean-exit/index.ts`

**(f) New detection constant + check (modify `armCleanExit` guard at the top of the `agent_end` handler, line ~130).** Check BEFORE the existing `isHeadlessMode` short-circuit so the sentinel wins even in headless mode.

```ts
// B+: in-process auditor child sentinel. The completion auditor runs
// in-process (same Node process as the host TUI) but with headless ctx.mode.
// Without this guard, our armed process.exit(0) timer kills the HOST ~1.5s
// after every goal completion. See pi-goal-xx bug 2026-07-14.
const SENTINEL = "__PI_GOAL_AUDITOR_IN_PROCESS__";
function isInsideInProcessChild(): boolean {
	try { return (globalThis as any)[SENTINEL] === true; } catch { return false; }
}
```

**(g) Add the early-return in the `agent_end` handler** (before `if (!isHeadlessMode(ctx)) return;`):

```ts
pi.on("agent_end", async (event, ctx) => {
	if (!isEnabled(EXT, "agent_end")) return;
	if (isInsideInProcessChild()) return; // B+: never arm inside an in-process child
	if (!isHeadlessMode(ctx)) return;
	// ... unchanged
});
```

**(h) Same guard in the `session_shutdown` handler (line ~145)** for symmetry — the belt-and-suspenders arm path must also respect the sentinel.

### 2.4 Export `__test__` hooks (both files)

- pi-print-clean-exit: export `isInsideInProcessChild` and the `SENTINEL` name from `__test__` so the RED/GREEN tests can drive them.
- goal-auditor: export `extensionCallsProcessExit` from the module (it is already file-local; add to a `__test__` export block) for unit testing the scanner.

## 3. Detection mechanism — counterfactual analysis

**The signal:** `globalThis.__PI_GOAL_AUDITOR_IN_PROCESS__ === true`, set by pi-goal-xx for the duration `[createSession-start, outer-finally]`.

**Why this and not the obvious alternatives:**

| Candidate signal | Verdict |
|------------------|---------|
| `process.pid` / `process.ppid` diff | ❌ In-process child has IDENTICAL pid/ppid to host. Useless. |
| `process.stdin.isTTY` / `process.stdout.isTTY` | ❌ Ambiguous: a real `pi -p` ALSO has no TTY (piped). False positives would break legit headless mode. |
| `ctx.mode === "print"/"json"` | ❌ Already what the bug exploits. Identical for auditor child and real `pi -p`. |
| `process.env.PI_…` env var | ⚠️ Env is inherited by the host's shell and any spawned subprocess; leaks beyond the window. globalThis is process-scoped and window-scoped. |
| **globalThis sentinel (CHOSEN)** | ✅ Race-free within Node's single-threaded event loop; scoped to the audit window; no cross-process leak; cheap read. |
| `ctx.sessionFile` presence | ⚠️ In-memory sessions may have `sessionFile: undefined`/`""`, but pi-core's contract here is undocumented and may change. Unreliable. |

**Race-freedom proof:** Node runs JS on a single thread. The sentinel is written synchronously before `await createSession(...)`. The child's `agent_end` handler runs as a microtask/macrotask on the same thread, strictly after. The sentinel is read synchronously inside the handler. No interleaving is possible. The clear in the outer finally runs only after `session.prompt()` has resolved/rejected — i.e. after all child handlers have fired. ✅ No false negatives, no false positives.

**Can a hostile extension defeat it?** Yes — a hostile extension could `delete globalThis[SENTINEL]`. **Out of scope.** Malicious extensions can `process.exit` directly regardless of any guard; the threat model here is *forgetful* (new process.exit ext added without sentinel check) and *regression* (inheritance re-enabled), both of which A+ and B+ cover. A+ (content-scan) is the layer that catches a forgetful new extension that does NOT check the sentinel.

## 4. Test plan

### 4.1 RED test (must FAIL before fix) — pi-goal-xx

**File:** `extensions/__tests__/goal-auditor.process-exit.test.ts` (new)

Reproduces the bug deterministically without a real LLM. Inject a mock `createSession` whose auditor child (a) inherits a fake "killer" extension and (b) fires `agent_end` in headless mode, then asserts the host process is still alive 3s later.

```ts
// 1. Install a real armed-timer detector: monkey-patch globalThis.process.exit
//    to record calls instead of dying (restore in afterEach).
// 2. createSession mock: returns a session whose subscribe() delivers a
//    synthetic { type: "message_end", message: { role: "assistant" } } then
//    resolves prompt(). The mock session's extensions include a fake extension
//    that, on agent_end, calls the REAL armCleanExit logic (import from
//    pi-print-clean-exit __test__) — or simpler, directly schedules
//    setTimeout(() => process.exit(0), 1500).
// 3. Call runGoalCompletionAuditor with inheritFromCwd:false but a hand-built
//    resourceLoader that includes the fake killer extension.
// 4. await runGoalCompletionAuditor(...); then await delay(2500).
// 5. RED assertion (BEFORE fix): expect(process.exitMock.calls.length).toBe(1)
//    → FAILS pre-fix because the killer fired; the assertion is written to
//    PASS when no exit was called, so pre-fix it FAILS.
```

**RED assertion (pre-fix):** `expect(process.exitCalls).toEqual([])` → **FAILS** pre-fix (exactly one exit call recorded). Post-fix: PASSES.

> The mock must install the `process.exit` shim BEFORE `createSession` and restore it in `finally`, mirroring how G1/G2 snapshot listeners. This makes the test hermetic (no real process death).

### 4.2 GREEN assertions (post-fix)

| Test | File | Assertion |
|------|------|-----------|
| **G-A+** content-scan excludes killer | pi-goal-xx | After fix, the audit trace's `pre-createSession` entry lists the killer path under `exitExcludedExtensions`, and the resolved extension set does NOT contain it. `process.exitCalls === []`. |
| **G-B+** sentinel self-guard | pi-plugins | Unit test `pi-print-clean-exit`: set `globalThis[SENTINEL]=true`, fire a synthetic headless `agent_end`, assert NO timer is armed (spy on `setTimeout` / check `armedTimer===null` via `__test__`). Clear sentinel, repeat, assert timer IS armed. |
| **G-backcompat** legit headless still exits | pi-plugins | Sentinel unset, `ctx.mode="print"`, `agent_end` with no pending messages → timer armed → `process.exit(0)` still fires (legit `pi -p` hang-mitigation preserved). |
| **G-regression** no exit within X s of complete_goal in TUI | pi-goal-xx (integration) | Spawn real `pi` in a detached tmux PTY with a completable micro-goal, assert the process is STILL ALIVE 10s after `goal_completed`. (Reuses the existing `/tmp/pi-exit-probe3/` harness.) |

**Regression threshold:** `X = 5s` (well above the 1.5s killer grace; well below the ~10s+ a human waits before concluding "pi died"). The 1.5s timer is the only thing that could fire in that window post-complete_goal; if anything fires, the fix regressed.

### 4.3 Verifier angles (self-check before deliver)

- **Angle A (scope):** Does the fix cover ALL re-emergence paths?
  - *auditor-approved* (the original repro): A+ excludes killer → covered. ✅
  - *auditor-rejected*: same inheritance path, same `agent_end` → covered by A+. ✅
  - *auditor-disabled* (config turns auditor off): no createSession → no inheritance → no child agent_end → no exit. ✅ (no fix needed; A+ is inert)
  - *escape-bypass* (the bug's "B3" sibling — an extension that escapes the unhandledRejection guard by calling process.exit directly, not via the killer): A+ content-scan catches ANY `process.exit`-calling extension, not just the known one. ✅
- **Angle B (logic):** Race-free per §3. No false negatives (sentinel set before createSession, read in handler, cleared in finally). No false positives (sentinel is pi-goal-xx-specific name; legit `pi -p` never sets it).
- **Angle C (purity):** A+ adds a read-only fs scan (no mutation). B+ adds one globalThis read + one boolean check. No NEW process.exit introduced. No code outside bug scope touched (the audit window's G1/G2/G3 guards are unchanged). The content-scan is O(extension count × file size) at audit-start — negligible vs the ~45s createSession.

## 5. Counterfactual robustness table

| "What if…" | A+ response | B+ response | Net |
|------------|-------------|-------------|-----|
| New `process.exit`-calling extension added to pi-plugins (no sentinel check) | ✅ Content-scan excludes it automatically | ⚠️ New ext doesn't check sentinel → would fire (B+ inert) | ✅ A+ holds |
| pi-goal-xx inheritance (`inheritFromCwd`) re-enabled after refactor | ✅ A+ still scans inherited extensions | ✅ Sentinel still set around createSession | ✅ both hold |
| A+ scanner has a bug / false-negative (misses a process.exit call) | ⚠️ bug slips through | ✅ B+ sentinel still blocks the KNOWN killer (pi-print-clean-exit) | ✅ B+ holds for known killer |
| B+ sentinel name collides / is cleared early by a 3rd extension | ✅ A+ content-scan still excludes the killer regardless of sentinel | ⚠️ B+ defeated | ✅ A+ holds |
| 3rd-party tool spawns an in-process child reusing the sentinel convention | ✅ A+ excludes any process.exit ext in that child too (if it inherits via a loader that calls makeAuditorResourceLoader) | ✅ if the 3rd-party sets the same sentinel | ✅ generalizable |
| 3rd-party tool spawns an in-process child with its OWN loader (not makeAuditorResourceLoader) | ⚠️ A+ not applied | ⚠️ B+ only if that tool sets a sentinel the killer recognizes | ⚠️ residual → Option C (out-of-process) is the only full fix |
| Extension calls `process.exit` via indirection (`globalThis.process.exit`, `Reflect.apply`, `eval`) | ⚠️ A+ still matches `process.exit` substring in source | n/a | ✅ A+ holds for the common case; exotic indirection is residual |

**Defense-in-depth verdict:** A+ ⊕ B+ closes the bug and all *likely* regressions. The only true residual is a 3rd-party in-process child with a bespoke loader — documented in §7 for Option C.

## 6. Backward-compat impact

| Scenario | Before fix | After fix | OK? |
|----------|-----------|-----------|-----|
| Real `pi -p` / `pi --mode json` hang (the original mitigation target) | timer arms, `process.exit(0)` forces exit | **Unchanged.** Sentinel is unset (no auditor), timer arms normally. | ✅ |
| Interactive TUI, no goal auditor | inert (not headless) | **Unchanged.** | ✅ |
| Interactive TUI, goal auditor runs (the bug) | host dies ~1.5s after completion | host survives; auditor's inherited killer excluded + self-guards | ✅ (the fix) |
| Auditor with `inheritFromCwd:false` (legacy/tests) | no inheritance → no bug | A+ inert (no loader), B+ sentinel never set → inert | ✅ |
| An extension that legitimately needs `process.exit` in the auditor child | (n/a — no such ext exists) | excluded from auditor; still works in real headless mode | ✅ (correct: auditor child must never exit the host) |

**No legit headless mode is broken.** The only behavioral change is: process.exit-calling extensions no longer run inside the in-process auditor child — which is exactly the desired invariant.

## 7. Deploy blast radius

| Repo | Stage path | Change | Deploy action |
|------|-----------|--------|---------------|
| **pi-goal-xx** | `extensions/goal-auditor.ts` (A+ scanner + filter, B+ sentinel set/clear, trace field) | source | `pi install`/git pull in pi-plugins `profile/` (pi-goal-xx is git-sourced); redeploy via `mise run deploy-full` (4→3→2→1). |
| **pi-plugins** | `profile/extensions/pi-print-clean-exit/index.ts` (B+ self-guard + `__test__` export) | source | same `deploy-full` chain — pi-print-clean-exit is a local extension in `profile/`. |
| **pi-goal-xx** | `extensions/__tests__/goal-auditor.process-exit.test.ts` (new) | test | runs in `mise run test-deploy` / project test suite. |

**Order:** Fix pi-plugins (B+ self-guard) AND pi-goal-xx (A+ + sentinel) in the **same deploy cycle**. Either alone fixes the bug, but shipping only one leaves the other repo one refactor away from regression. Deploy pi-plugins first (it is the lower stage in the chain), then pi-goal-xx, so the sentinel consumer exists before the producer is relied upon — though since both are belt-and-suspenders, ordering is not load-bearing.

**Stages touched:** all four (4→3→2→1) via `deploy-full`. No config (`settings.json`/`mcp.json`) change → no drift-gate interaction. No new packages → no `pi install` of npm deps. Content-integrity gate: two source files modified, one test file added — all within existing content dirs.

**Smoke test addition (recommended):** add a smoke assertion to `smoke-test.sh` that, after a `pi -p` invocation, confirms the process exited via the killer's own timer (proving B+ did NOT break legit headless exit). This guards against a future over-broad B+ that breaks real `pi -p`.

## 8. Residual risk (tracked, not blocking)

1. **Out-of-process auditor (Option C)** remains the only fix that survives a 3rd-party in-process child with a bespoke loader. It is the documented ultimate fix (`goal-auditor.ts:1228` comment region). File a follow-up intention; do NOT block this robust fix on it.
2. **Exotic process.exit indirection** (`Reflect.apply(process.exit, ...)`, `eval("process.ex"+"it")`) evades the A+ substring scan. Acceptable: no real extension does this, and B+ covers the known killer regardless.
3. **Concurrent audits** (two `runGoalCompletionAuditor` overlapping) could race the sentinel clear — but audits are serialized by the goal lock (documented G2 limitation), so this is theoretical.

## 9. Implementation checklist (for the implementer — not this design's scope)

- [ ] A+: add `extensionCallsProcessExit` + filter clause + trace field (goal-auditor.ts)
- [ ] B+ producer: set/clear `globalThis.__PI_GOAL_AUDITOR_IN_PROCESS__` (goal-auditor.ts)
- [ ] B+ consumer: `isInsideInProcessChild` guard in `agent_end` + `session_shutdown` (pi-print-clean-exit)
- [ ] Export `__test__` hooks from both files
- [ ] RED test → confirm FAIL → implement → confirm GREEN
- [ ] G-regression PTY test (reuse `/tmp/pi-exit-probe3/` harness)
- [ ] Run `mise run test-deploy-bats` (no regressions in 142 existing tests)
- [ ] Deploy-full, smoke test, verify no goal-completion exit for 24h

---

**One-line summary:** Exclude any `process.exit`-calling extension from the in-process auditor by content-scan (A+, self-maintaining), AND make `pi-print-clean-exit` self-skip via a `globalThis` sentinel the auditor sets around `createSession` (B+). Either alone fixes the bug; both ship for defense-in-depth. Detection is race-free (single-threaded JS, synchronous set before `await createSession`, synchronous read in handler, clear in outer finally). No legit headless mode broken.
