# Forensic Diff — Every Divergence in `goal-auditor.ts` (fork vs upstream)

**Status:** Read-only investigation complete.
**Fork:** `buihongduc132/pi-goal-xx` @ `HEAD` of `pi-goal-xx-fix-complete-goal-crash`
**Upstream:** `tmonk/pi-goal-x` @ `upstream/main` (fetched & reachable)
**Author:** teammate `forensic-diff`, task #3.
**Scope:** `git diff upstream/main..HEAD -- extensions/goal-auditor.ts` (820 lines) + `complete_goal` region of `extensions/goal.ts`.
**Supersedes:** `flow/findings/2026-07-10_complete-goal-fork-diff-crash.md` (which focused on `complete_goal` in `goal.ts`, not `goal-auditor.ts` itself).

---

## 0. TL;DR (answer first)

**`inheritFromCwd` is the trigger, but it is NOT the root cause by itself.** The user was right to push back: `inheritFromCwd: true` is SDK-supported (`DefaultResourceLoader` + `createAgentSession` are public API). It *should* work.

**The real divergence is a MISSING CLEANUP STEP that the fork introduced a need for but never added:**

> The fork's auditor loads the host's full extension set (via `inheritFromCwd`) into an **in-process** `AgentSession`, but **never calls `session.dispose()`** to tear it down. Upstream doesn't call `dispose()` either — but upstream loads **zero** extensions (empty resource loader), so there is nothing to tear down.

The SDK provides `AgentSession.dispose()` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:508`) which:
1. invalidates the extension runner (`_extensionRunner.invalidate()`),
2. disconnects from agent events,
3. clears event listeners, and
4. **runs `cleanupSessionResources(sessionId)`** — the SDK's registry of session-scoped cleanup callbacks (`@earendil-works/pi-ai/dist/session-resources.js`) that MCP adapters, hooks, and resource allocators register into.

Because the fork loads host extensions (pi-mcp-adapter, hindsight-runtime-tags, immediate-compaction, todo-enforcer, session-summary, etc.) into the auditor child but never disposes the child, every resource those extensions register via `registerSessionResourceCleanup` **leaks into the host process** after the auditor returns. This is the materialized risk: leaked MCP sockets, leaked intervals, leaked `process.on(...)` listeners, and — critically — leaked in-flight async work that can still reject and trigger Node's default `unhandledRejection` handler = **process termination with no host stack trace**. This matches the observed symptom exactly.

`inheritFromCwd` is the **trigger**; the **missing `session.dispose()`** (made necessary *by* `inheritFromCwd`) is the **root cause**.

---

## 1. Method

1. `cd pi-goal-xx-fix-complete-goal-crash && git diff upstream/main..HEAD -- extensions/goal-auditor.ts` → 820 lines.
2. Read upstream's full `goal-auditor.ts` (436 lines) and fork's HEAD (993 lines) side by side.
3. Inspected SDK surfaces for cleanup: `AgentSession.dispose()` (`agent-session.d.ts:251`, `agent-session.js:508`), `cleanupSessionResources` (`@earendil-works/pi-ai/dist/session-resources.js`), `ExtensionRunner.invalidate()` (`extensions/runner.js:289`).
4. Cross-checked `complete_goal` region of `goal.ts` (the call site) for divergences that change the auditor's lifecycle.

---

## 2. Full hunk-by-hunk diff table (angle a — scope)

Every hunk in `git diff upstream/main..HEAD -- extensions/goal-auditor.ts`, classified.

| # | Lines (upstream) | What changed | Classification | Notes |
|---|---|---|---|---|
| H1 | imports | Added imports: `DefaultResourceLoader`, `getAgentDir`, `AuditorPatternCache`, `resolveAuditorResources`, `loadAuditorPrompt`, `auditor-log.ts` helpers | (1) intentional feature | New modules added by the fork. |
| H2 | `GoalAuditorResult` | Added `timedOut?: boolean` | (1) intentional feature | Timeout support (Bug 1a). |
| H3 | new | `PROMPT_FIELD_CAP` + `capPromptField()` helper | (1) intentional feature | Prompt-size guard. |
| H4 | `buildGoalAuditorPrompt` | Refactored into `buildAuditorPromptParts()` returning `{persona, factLayer}` + applies `capPromptField` to each field | (1) intentional feature | Prompt-config-resolution spec. |
| H5 | new | `isGoalSelfExtension(extPath)` — excludes `pi-goal` itself from inherited extensions | (1) intentional feature | B3 self-exclusion guard. **But see H12 — only protects against the *goal* plugin, not the host's OTHER extensions.** |
| H6 | `makeAuditorResourceLoader()` | **Signature changed from no-arg → `(resolved, mainResourceLoader)`**. Body now wraps `mainResourceLoader`, filters by include/exclude, excludes goal-self. `reload` now delegates to `mainResourceLoader?.reload()` instead of being a no-op | (1) intentional feature **with divergent side effect** | See H6b. |
| H6b | (within H6) | `reload: async () => {}` (upstream no-op) → `reload: async () => { await mainResourceLoader?.reload(); }` | **(2) accidental divergence / risky** | The auditor's loader now forwards reloads to the **host's** `DefaultResourceLoader`. Any reload-triggered code path inside the auditor (e.g. compaction, extension reload) re-runs the host's full resource discovery. Upstream is a safe no-op. |
| H7 | new | `MainSessionResources` interface (`tools`, `mcp`, `skills`, `extensions`, `resourceLoader`, `inheritFromCwd`) | (1) intentional feature | The `inheritFromCwd` opt. |
| H8 | `runGoalCompletionAuditor` signature | Added `mainResources?: MainSessionResources` param | (1) intentional feature | The trigger switch. |
| H9 | inside try | Hoisted `const startedAt = Date.now()` out of inner try (was inside inner try upstream) | (2) benign drift | Needed so outer catch can compute `elapsedMs`. |
| H10 | inside try | **Inheritance block:** if `inheritFromCwd`, build `new DefaultResourceLoader({cwd, agentDir, settingsManager})` + `await mainResourceLoader.reload()`; derive `mainSkills`/`mainExtensions` from the loader; call `resolveAuditorResources(...)`; resolve auditor prompt via `loadAuditorPrompt(...)`; `logAuditorTrace(buildStartEntry(...))` | (1) intentional feature | The whole inheritance machinery. **This is what loads the host's extensions/MCP into the in-process child.** |
| H11 | `emitProgress` | Added `if (aborted) return;` guard | (1) intentional feature | B6 abort-stops-progress. |
| H12 | `createSession` | **Before createSession:** logs a `pre-createSession` trace marker + wraps createSession in a `Promise.race` with `__auditor_cs_timeout__` + try/catch | (1) intentional feature | P1 fix. Note: `csTimeoutId` is **leaked** if `createSession` rejects (the `clearTimeout` is inside the try, after `Promise.race`). Minor. |
| H13 | `createSession` args | **`compaction: { enabled: false }` → `compaction: { enabled: true }`** | **(2) accidental divergence / risky** | Upstream hard-disables compaction in the auditor. Fork enables it. Combined with inherited extensions (`immediate-compaction`!) and `loadAuditorPrompt` / inherited prompt config, this can trigger compaction inside the auditor child — which calls back into the host's resource loader (H6b). |
| H14 | `createSession` args | **`tools: ["read","grep","find","ls","bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME]` → `tools: resolved.tools`** | (1) intentional feature with risk | Auditor now gets the host's *entire live active tool list* (filtered by settings). Huge tool schemas → larger model context → the `auto_retry_start` stall seen in the trace. |
| H15 | `createSession` args | `resourceLoader: makeAuditorResourceLoader()` → `makeAuditorResourceLoader(resolved, mainResourceLoader)` | (1) intentional feature | The actual wiring of H6. |
| H16 | inside `session.subscribe` | Added a forensic-trace block recording every event with bounded preview | (1) intentional feature | Benign (wrapped in try/catch). |
| H17 | `message_update` handler | Added `text_end` capture into `outputParts` | (1) intentional fix | Correctness fix (pi-core can drop text at `message_end`). |
| H18 | `abortSession` | Added `let aborted` flag + set-before-abort: `const abortSession = () => { aborted = true; session.abort(); }` | (1) intentional fix | B6 defense-in-depth. |
| H19 | new | **Timeout** `setTimeout(...)` + `let timedOut` | (1) intentional feature | Bug 1a. Cleared in finally. |
| H20 | new | **`unhandledRejectionHandler`** + `process.on("unhandledRejection", ...)` installed before `prompt`, removed in finally | (1) intentional feature | R3 scoped guard. **This is itself a process-global listener — proving the fork knows inherited extensions produce unhandled rejections.** |
| H21 | `session.prompt` | Wrapped in `.catch` that swallows only `AbortError` | (1) intentional fix | R2.4a. |
| H22 | after prompt | Replaced upstream's simple "if aborted return" with a branching: check `rejectionMessage` → timeout → aborted → decision, each emitting a trace `buildEndEntry` | (1) intentional feature | Verbose but correct. |
| H23 | catch block | Expanded to check timeout / rejectionMessage / generic, with trace logging | (1) intentional feature | Mirror of H22. |
| H24 | **finally block** | **Added `if (timeoutId) clearTimeout(timeoutId);` + `process.off("unhandledRejection", ...)`** before the existing `removeEventListener`/`emitProgress`/`unsubscribe` | (1) intentional feature | See §3 — **cleanup table**. |
| H25 | **finally block** | `unsubscribe()` is **STILL the last session cleanup**. **`session.dispose()` is NOT added** | **(3) missing-from-fork cleanup step** | **★ ROOT CAUSE ★** — see §3, §4. |
| H26 | post-finally | Upstream had a post-finally block: `if (args.signal?.aborted) { return {...} } const output = ...; const decision = ...; return {...}`. Fork **DELETED** this block (the logic moved inside the try — H22). | (1) intentional refactor | Equivalent semantics; not a divergence in behavior. |

**Count:** 26 hunks. **(1) intentional feature:** 22. **(2) accidental/risky divergence:** 3 (H6b, H13, H14-side-effect). **(3) missing cleanup:** 1 (H25 — the `session.dispose()`).

---

## 3. The missing-cleanups table (angle c — purity)

> **Question:** Does upstream call ANY cleanup we don't? Specifically: `unsubscribe`, `dispose`, `removeListener`, `clearTimeout`, `abortController`.

### 3a. Cleanup actions upstream performs, and fork status

| Cleanup action | Upstream calls it? | Fork calls it? | Consequence if fork-missing |
|---|---|---|---|
| `args.signal.removeEventListener("abort", abortSession)` | ✅ yes (finally) | ✅ yes (finally) | — (matched) |
| `unsubscribe()` (the subscribe handle) | ✅ yes (finally) | ✅ yes (finally) | — (matched) |
| `clearTimeout(timeoutId)` | n/a (no timeout) | ✅ yes (finally) | — (fork-only feature, cleaned) |
| `process.off("unhandledRejection", handler)` | n/a | ✅ yes (finally) | — (fork-only feature, cleaned) |
| **`session.dispose()`** | ❌ **no** (but N/A — empty loader) | ❌ **no** | **★ LEAK ★ — see §3b** |
| **`session.abort()` on normal completion** | ❌ no | ❌ no | n/a (prompt already resolved) |

**Verdict on angle c (upstream-has-fork-lacks):** Upstream does NOT call any cleanup the fork is missing. Both omit `session.dispose()`. **So by the literal "does upstream call something we don't" test, there is NO missing cleanup.** This is why the prior forensic doc (2026-07-10) — which used only angle c — concluded "the only fork-only material hunk is `mainResources`."

### 3b. The real gap: cleanups the fork *needs* but neither side has

The prior analysis missed that `inheritFromCwd` **creates a new need** for a cleanup that neither version has. This is the angle-c blind spot: angle c only asks "what does upstream do that we don't?" — it never asks "what does the *fork's new feature* require?"

| Resource created by fork's `inheritFromCwd` path | SDK-provided cleanup | Fork calls it? | Consequence of not calling it |
|---|---|---|---|
| The auditor `AgentSession` itself (with its own `ExtensionRunner` holding a second instance of every host extension) | `session.dispose()` → `_extensionRunner.invalidate()` + `_disconnectFromAgent()` + `_eventListeners = []` | ❌ **NO** | The auditor's `ExtensionRunner` is **never invalidated**. Its extension instances outlive the auditor's logical lifetime. |
| Session-scoped resources registered by inherited extensions via `registerSessionResourceCleanup(fn)` (MCP adapter connections, hindsight client, gitnexus client, etc.) | `session.dispose()` → `cleanupSessionResources(sessionId)` iterates the registry | ❌ **NO** | **Every inherited extension's session-scoped resource LEAKS.** MCP sockets stay open, intervals keep firing, the `immediate-compaction` / `todo-enforcer` / `session-summary` extensions' background work continues. |
| Process-global listeners an inherited extension installs via `process.on(...)` or `setInterval(...)` (the fork itself installs one — H20 `process.on("unhandledRejection")` — proving this is a known failure mode) | `process.off(...)` / `clearInterval(...)` — but only if the extension explicitly registers a cleanup | ❌ NO (and not the SDK's job) | Late async rejections from leaked in-flight work fire **after** the auditor returns and the fork's `unhandledRejectionHandler` has been removed → reach Node's default handler → **process termination, no host stack trace**. This is the observed symptom. |

**This is the divergence.** `inheritFromCwd` is SDK-supported in the sense that `DefaultResourceLoader` + `createAgentSession` are public API — but the SDK's contract is that the **caller disposes the session** when done (`agent-session.d.ts:247-252`: *"Remove all listeners and disconnect from agent. Call this when completely done with the session."*). The fork's auditor callsite never disposes.

### 3c. Why upstream "gets away" with not disposing

Upstream's `makeAuditorResourceLoader()` returns hard-coded empties (`extensions: []`, skills `[]`, etc.) and a no-op `reload`. So `createAgentSession` for the auditor instantiates **zero** extensions, registers **zero** session-resource cleanups, and creates no process-global side effects. The session object becomes unreachable as soon as `runGoalCompletionAuditor` returns and `unsubscribe()` runs. GC reclaims it. No leak. **`dispose()` is redundant upstream.** The fork broke the invariant that made `dispose()` redundant.

---

## 4. Conclusion — is `inheritFromCwd` the root cause?

### No, not by itself.

`inheritFromCwd: true` is a **legitimate, SDK-supported** way to give the auditor the host's tool list + MCP. Used correctly it would be fine.

The root cause is the **incomplete pairing** of that feature with the SDK's cleanup contract:

```
  load host extensions into in-process child   ←  inheritFromCwd (fork-added)
       │
       ▼
  child session allocates session-scoped resources
  (MCP sockets, intervals, listeners, hooks)
       │
       ▼
  auditor finishes / aborts / times out
       │
       ▼
  ✘ finally block runs only:
      clearTimeout, process.off, removeEventListener, emitProgress, unsubscribe
  ✘ session.dispose() NEVER called
       │
       ▼
  cleanupSessionResources(sessionId) NEVER runs
       │
       ▼
  resources leak into host process
       │
       ▼
  leaked async work rejects after the fork's unhandledRejection guard is removed
       │
       ▼
  Node default handler → process exit, no host stack trace  ← observed symptom
```

### Evidence chain (why this fits better than "inheritFromCwd is the cause")

1. **`session.dispose()` exists in the SDK and is documented as the teardown path** (`agent-session.d.ts:247-252`, `agent-session.js:508-516`). The prior doc never mentions it.
2. **`cleanupSessionResources` is a registry pattern** (`@earendil-works/pi-ai/dist/session-resources.js`) — it's literally the SDK's hook for "extensions that allocate per-session resources register a cleanup here." The fork loads extensions that use this hook (pi-mcp-adapter, hindsight-runtime-tags) but never drains the registry.
3. **The fork's own code proves it knows inherited extensions produce async rejections** — H20 installs a scoped `process.on("unhandledRejection")` specifically to catch them. But that guard is **removed in the finally block** (H24), so any rejection that fires *after* the finally (from a leaked resource still doing work) escapes uncaught. This is the precise window the leak opens.
4. **The lifecycle gap** (`audit_started` ✓ / `audit_result` ✗) falls inside `await runGoalCompletionAuditor` — exactly where `session.prompt` runs with the inherited (leak-prone) extension set. Consistent.
5. **The trace ending at `auto_retry_start`** is consistent with the inherited tool schema being huge (H14: host's entire tool list) AND with leaked in-flight work interfering with the child's model call.
6. **`compaction: { enabled: true }` (H13) is an independent contributing divergence** — upstream hard-disables it. With `inheritFromCwd` loading the `immediate-compaction` extension AND compaction enabled in the auditor's own settings, the child can compact mid-audit, which re-enters the resource loader (H6b `reload` now forwards to the host loader). This is a compounding factor, not the root cause.

### The fix (two lines, preserves the feature)

The 2026-07-10 doc's recommendation ("delete `mainResources`") throws away a legitimate feature. The user's instinct is correct. **Keep `inheritFromCwd`, add the missing teardown:**

```diff
 // extensions/goal-auditor.ts, finally block (currently H24/H25)
 } finally {
     if (timeoutId) clearTimeout(timeoutId);
     process.off("unhandledRejection", unhandledRejectionHandler);
     args.signal?.removeEventListener("abort", abortSession);
     progress.phase = "done";
     progress.label = "Audit complete.";
     progress.percentage = 100;
     emitProgress();
     unsubscribe();
+    // ★ Missing cleanup that inheritFromCwd makes necessary.
+    // Invalidates the auditor's ExtensionRunner + runs cleanupSessionResources
+    // (MCP sockets, intervals, listeners registered by inherited extensions).
+    // Upstream omits this because it loads zero extensions; the fork must not.
+    try { session.dispose(); } catch { /* best-effort teardown */ }
 }
```

**Caveat:** `dispose()` calls `_extensionRunner.invalidate()` + `cleanupSessionResources()` — it does NOT itself `abort()` the session or close MCP transports unless those extensions registered cleanups. So `dispose()` is **necessary** but may not be **sufficient** if an inherited extension allocates a resource without registering a cleanup callback. Two follow-ups:

- **(a)** Also call `session.abort()` defensively in the finally (no-op if prompt already settled) to force the agent loop to release its in-flight fetches.
- **(b)** Audit the inherited extension list (`pi-mcp-adapter`, `hindsight-runtime-tags`, `immediate-compaction`, `todo-enforcer`, `session-summary`, `session-activity`, `pi-archon-workflow`, `lint-on-edit`, `coding-guard-edit`, `pi-gitnexus-local`, `pi-memory-guard`, `pi-safety-net`) and confirm each registers a `registerSessionResourceCleanup` for its transports/timers. Any that don't are leak sources even with `dispose()`.

Also strongly consider reverting **H13** (`compaction: { enabled: true }` → `false`) to match upstream's hard-disable for the auditor — compaction mid-audit is a needless re-entry into the inherited loader.

### Ranking of divergences by crash-relevance

| Rank | Hunk | Why |
|---|---|---|
| 🥇 1 | **H25** — missing `session.dispose()` | Direct leak of inherited extensions' session-scoped resources → the unhandled-rejection-then-exit path. |
| 🥈 2 | **H13** — `compaction: enabled: true` | Re-enters inherited loader mid-audit; compounding. |
| 🥉 3 | **H6b** — `reload` forwards to host loader | Any reload inside the auditor replays host discovery; combined with H13 is dangerous. |
| 4 | **H14** — host's full tool list | Inflates schema → `auto_retry_start` stall. Not a crash, but a hang precursor. |
| 5 | H20 — removing `unhandledRejection` guard in finally | The leak window. Necessary to remove (can't keep a process-global listener forever), but it's the moment the leak becomes fatal. |

`inheritFromCwd` (H7/H8/H10/H15) is the **trigger** but ranks below the missing `dispose()` (H25) as the **cause**, because `inheritFromCwd` + `dispose()` would be safe, whereas `inheritFromCwd` without `dispose()` is not.

---

## 5. What this corrects about the 2026-07-10 doc

The 2026-07-10 doc (`flow/findings/2026-07-10_complete-goal-fork-diff-crash.md`) used **only angle c** ("does upstream call a cleanup we don't?") and correctly found the answer is *no* — then concluded the only material fork-only hunk is `mainResources: { inheritFromCwd: true }`, and recommended deleting it. That doc's own §0 disclaimer records that the user overruled the "delete it" recommendation in favor of hardening the in-process boundary.

This doc adds the angle the prior one lacked: **angle b applied to the fork's own new feature** — "what cleanup does `inheritFromCwd` *require*, and is it present?" The answer (no — `session.dispose()` is absent) is the root cause the prior doc couldn't reach from angle c alone. The chosen hardening direction (timeout + `unhandledRejection` guard + crash-safe sends, per `flow/requirements/2026-07-11_crash-safe-auditor-inheritance.md`) addresses *symptoms* of the leak but not the leak itself; **`session.dispose()` in the finally block should be added to that hardening set.**

---

## 6. Evidence index

| What | Fork (HEAD) location | Upstream location |
|---|---|---|
| `runGoalCompletionAuditor` signature with `mainResources` | `goal-auditor.ts` (~line 372) | `goal-auditor.ts` (no `mainResources`) |
| `inheritFromCwd` branch + `new DefaultResourceLoader` + `await .reload()` | `goal-auditor.ts` (~line 443-450) | absent |
| `makeAuditorResourceLoader(resolved, mainResourceLoader)` overload | `goal-auditor.ts` (~line 289) | no-arg, returns empties |
| `createSession` compaction enabled vs disabled | `goal-auditor.ts` (~line 575) | `goal-auditor.ts` (~line 324) |
| `createSession` tools: `resolved.tools` vs hardcoded 6 | `goal-auditor.ts` (~line 576) | `goal-auditor.ts` (~line 325) |
| `reload: async () => { await mainResourceLoader?.reload(); }` | `goal-auditor.ts` (~line 338) | no-op `async () => {}` |
| **finally block — NO `session.dispose()`** | `goal-auditor.ts` (~line 968) | `goal-auditor.ts` (~line 405) |
| **SDK: `AgentSession.dispose()`** | — (SDK) | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:508` |
| **SDK: `cleanupSessionResources(sessionId)` registry** | — (SDK) | `node_modules/@earendil-works/pi-ai/dist/session-resources.js:8` |
| **SDK: `ExtensionRunner.invalidate()`** | — (SDK) | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:289` |
| fork's scoped `process.on("unhandledRejection")` (proof fork knows about async rejections) | `goal-auditor.ts` (~line 760) | absent |
| fork's `unhandledRejectionHandler` removed in finally | `goal-auditor.ts` (~line 970) | n/a |
| `complete_goal` call site passing `mainResources: { inheritFromCwd: true }` | `goal.ts` (~line 3170) | `goal.ts` (~line 2587) (no `mainResources`) |

---

## 7. Limitations

- Did not run the auditor against the real host to capture a leaked-resource inventory (would require instrumenting `registerSessionResourceCleanup` or `process.on` counts before/after). The conclusion is reached by static analysis of the SDK contract + the fork's cleanup surface.
- `dispose()` may not be sufficient on its own (§4 caveat (a)/(b)) — it is necessary, and is the single highest-leverage missing line, but a full fix requires auditing each inherited extension for un-registered resources.
- The 23 MB `auditor-trace.jsonl` in beet-orches was not read (out of scope per task constraints).
