# Forensic Diff — WHY `complete_goal` Crashes the Host Session (fork-only, no exception)

> **HISTORICAL DISCLAIMER** — This analysis was performed on a **pre-fix** revision of the fork (md5 `f473045d…`). The 'Primary fix' recommendation in §5 below proposes **removing** `inheritFromCwd: true`. That recommendation was **superseded** by the user's design decision: inheritance is **intentionally retained** and the in-process boundary is hardened instead (auditor timeout `auditorTimeoutMs`, scoped `unhandledRejection` guard, crash-safe sends). This document is kept for its forensic value (root-cause analysis, evidence chain, line references) — NOT as the current fix direction. See `flow/requirements/2026-07-11_crash-safe-auditor-inheritance.md` for the chosen approach.

**Status:** Read-only investigation complete.
**Fork:** `buihongduc132/pi-goal-xx` @ `main` (md5 `f473045d…` — confirmed identical to the file deployed in beet-orches at `~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx/extensions/goal.ts`).
**Upstream:** `tmonk/pi-goal-x` @ `upstream/main` (fetched & reachable — no re-spawn needed).
**Author:** teammate `wave1-fork-diff-auditor`, task #1.

---

## 0. TL;DR (answer first)

The crash is **not** the `sendMessage`/`serializedSend`/`triggerTurn` region the prior fixes targeted. Those fixes patch a line **upstream** of the actual failure.

The real, narrow, fork-only root cause is a **single argument passed to the auditor spawn**:

```ts
// extensions/goal.ts, complete_goal.execute  (~line 3137, FORK-ONLY)
const auditor = await runGoalCompletionAuditor({
    ...
    mainResources: {                       // ← THIS ENTIRE BLOCK IS ABSENT UPSTREAM
        tools: safeGetActiveTools(pi),
        inheritFromCwd: true,
    },
    ...
});
```

`inheritFromCwd: true` makes the auditor child (which runs **in-process** via `createAgentSession` + `SessionManager.inMemory`) load the **host's full resource set** — every host extension, every MCP server, and the host's live tool list. Upstream's auditor is **strictly isolated** (empty resource loader + a 6-item hardcoded tool list + compaction off). Loading host extensions/MCP inside the in-process auditor either **hangs `session.prompt()` forever** (inherited MCP/extension await that never resolves, surfacing in the trace as a stuck `auto_retry_start`) or throws an **async unhandled-rejection** in the child's path → Node terminates the whole process with **no host-side stack trace**. The lifecycle gap (`audit_started` ✓ / `audit_result` ✗) falls exactly inside `await runGoalCompletionAuditor`.

---

## 1. Scope confirmation (verifier angle a)

- `complete_goal` lives in the monolithic `extensions/goal.ts` in **both** repos (both also have the `goal-core.ts` / `goal-auditor.ts` / etc. split, but the tool body itself stays in `goal.ts`).
  - Fork: `name: "complete_goal"` @ `extensions/goal.ts:2870`; execute body `2892–3338`.
  - Upstream: `name: "complete_goal"` @ `extensions/goal.ts:2301`; execute body `2323–2734`.
- Diff was produced by extracting both regions (`sed -n '2868,3339p'` fork vs `2299,2742p` upstream) and running `git diff --no-index`. 472 vs 444 lines.
- The diff is **entirely** within the `complete_goal` tool + audit-spawn region. No unrelated file was touched for this analysis. The deployed file == `main` (md5 match).

## 2. The minimal fork-vs-upstream diff (complete_goal + audit-spawn only)

Only the **semantically material** hunk is shown. Trivial drift omitted (the `regTool()` wrapper applied to every tool, `loadGoalSettings`-once vs 4×, `setTurnStopped()` vs `turnStoppedFor =`, the `logAuditorTrace()` line in the abort branch — all verified benign, see §5).

### Hunk A — the audit-start `sendMessage` (already "fixed" in fork; **upstream of the crash**)

```diff
 // Auditor is enabled — run the normal audit flow
-await pi.sendMessage<GoalAuditEventDetails>({       // UPSTREAM
+// IMPORTANT: do NOT await this sendMessage …        // FORK (post ff36e54)
+pi.sendMessage<GoalAuditEventDetails>({
     customType: GOAL_AUDIT_ENTRY,
     content: [ … ].filter(…).join("\n"),
     display: true,
     details: { phase: "started", … },
-}, { triggerTurn: true });                           // UPSTREAM
+});                                                  // FORK: no await, no triggerTurn
```

This is the region the two prior commits (`aa2f4d1` removed `triggerTurn:true`; `ff36e54` removed the `await` + added `serializedSend`) modified. **It executes at fork line ~3078, *before* `audit_started` is written at ~3087.** The ledger proves the host runs past it. It is therefore **not** where the lifecycle gap is. See §4 for why the fix can't help.

### Hunk B — the auditor spawn call (THE root-cause region)

```diff
 const auditor = await runGoalCompletionAuditor({
     ctx,
     goal: auditTarget,
     completionSummary: params.completionSummary,
     detailedSummary: detailedSummary(auditTarget),
     verificationSummary: params.verificationSummary,
-    settings: loadGoalSettings(ctx.cwd),             // UPSTREAM
+    settings,                                         // FORK (same value, benign)
     signal: auditAbortController.signal,
+    mainResources: {                                  // FORK-ONLY — ABSENT UPSTREAM
+        tools: safeGetActiveTools(pi),                //   host's LIVE active tool list
+        inheritFromCwd: true,                         //   build a DefaultResourceLoader from cwd
+    },
     onProgress: (progress) => { … },
 });
```

### Hunk C — what that `mainResources` argument turns on inside `runGoalCompletionAuditor` (`extensions/goal-auditor.ts`)

```diff
 // build the auditor's resourceLoader + createSession:

-// UPSTREAM: auditor is FULLY ISOLATED
+// FORK: auditor INHERITS host resources
 const mainResourceLoader = args.mainResources?.resourceLoader;
-if (!mainResourceLoader && args.mainResources?.inheritFromCwd) {   // FORK-ONLY branch
+if (!mainResourceLoader && args.mainResources?.inheritFromCwd) {
     const settingsManager = SettingsManager.create(args.ctx.cwd, getAgentDir());
     mainResourceLoader = new DefaultResourceLoader({ cwd: args.ctx.cwd, agentDir, settingsManager });
     await mainResourceLoader.reload();                              // ← loads ALL host ext/MCP/skills
 }

 const { session } = await createSession({
     cwd: args.ctx.cwd,
     model, thinkingLevel, modelRegistry: args.ctx.modelRegistry,
-    resourceLoader: makeAuditorResourceLoader(),                    // UPSTREAM: empty loader
+    resourceLoader: makeAuditorResourceLoader(resolved, mainResourceLoader), // FORK: host loader, filtered
     sessionManager: SessionManager.inMemory(args.ctx.cwd),
-    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), // UPSTREAM
+    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),  // FORK
-    tools: ["read","grep","find","ls","bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME], // UPSTREAM: 6 hardcoded
+    tools: resolved.tools,                          // FORK: host's entire active tool list
     customTools: [reportProgressTool],
 });
```

**Upstream `makeAuditorResourceLoader()` takes zero arguments and returns hard-coded empties** for every category (`getExtensions: () => ({ extensions: [], … })`, empty skills/prompts/themes, `reload: async () => {}`). Verified at `upstream/main:extensions/goal-auditor.ts`. The fork overload `makeAuditorResourceLoader(resolved, mainResourceLoader)` wraps the host loader and only strips `pi-goal` itself (`isGoalSelfExtension`) — **every other host extension + every MCP server passes through**.

## 3. Ranked root-cause hypotheses (best fit first)

### 🥇 H1 — Auditor inherits host resources via `mainResources: { inheritFromCwd: true }` (PRIMARY)

**Mechanism.** The auditor is an **in-process** child (`createAgentSession` + `SessionManager.inMemory` — same Node process as the host). With `inheritFromCwd: true`, the fork's `createSession` loads:
- every host extension except `pi-goal` itself (pi-safety-net, hindsight-runtime-tags, lint-on-edit, session-summary, todo-enforcer, pi-gitnexus-local, pi-memory-guard, session-activity, immediate-compaction, pi-archon-workflow, …),
- every host MCP server (GitNexus `:4747`, Hindsight `:24300`, … via pi-mcp-adapter),
- the host's **live active tool list** (`safeGetActiveTools(pi)`), and
- **compaction enabled** (upstream hard-disables it for the auditor).

Two failure modes, both matching the "no stack trace" constraint:

1. **Hang.** An inherited extension's `onLoad` or an MCP adapter handshake `await`s something that never resolves (MCP connect, a watcher init, a registry reload). `await createSession(...)` or, more often, `await session.prompt(...)` never returns → `await runGoalCompletionAuditor(...)` never returns → `complete_goal.execute` hangs forever on its single blocking await. Matches "hang-then-exit" and the trace stalling at `auto_retry_start` (the auditor model call entered pi-core's auto-retry — typical when the inherited tool/MCP schema is huge or malformed).

2. **Silent quit (no host stack trace).** An inherited extension throws an **asynchronous** unhandled rejection from its `onLoad`/hook in the auditor child's event-loop path. Node's default `unhandledRejection` handler **terminates the entire process**. Because the rejection originates in the child's async path — not inside `complete_goal.execute`'s frame — the host's try/catch never sees it and **no host stack trace is emitted**. This is the exact symptom.

**Smoking gun (the fork author already half-knew).** `extensions/goal-auditor.ts:579-580`, immediately after the fork's `createSession`:
```ts
} catch (createError) {
    // createSession itself threw — almost certainly an extension onLoad
    // failure in the auditor's inherited resource loader. Log it.
```
The author acknowledges the inherited loader causes extension-`onLoad` failures and wraps `createSession` in try/catch. But while a `try/catch` around `await` DOES catch rejections from the awaited expression itself, it does **not** catch (a) a **detached** async `onLoad` rejection that fires after `createSession` resolves (the promise is not chained), or (b) a `createSession`/`session.prompt` that simply **hangs** (never resolves or rejects). Both escape the catch → unhandled rejection or infinite await → host dies, exactly as observed.

**Fork-only?** ✅ Yes (verified absent upstream — purity angle c). Upstream passes **no** `mainResources`, calls `makeAuditorResourceLoader()` with no args (hard-coded empties), uses a 6-item hardcoded `tools` list, and sets `compaction.enabled = false`.

**Fits all evidence?** ✅
- Lifecycle gap (`audit_started` ✓, `audit_result` ✗) → failure is *inside* `await runGoalCompletionAuditor` ✓
- No stack trace → async rejection in in-process child / or pure hang ✓
- hang-then-exit ✓
- fork-only, upstream unaffected (upstream auditor is isolated) ✓
- trace ends at `auto_retry_start` (auditor model call stuck/retrying) ✓

### 🥈 H2 — Bare fire-and-forget `pi.sendMessage({...})` with no `.catch()` (latent bug, likely CONTRIBUTING, not primary)

At fork `extensions/goal.ts:3080` the audit-start send is `pi.sendMessage<…>({…})` with **no `await` and no `.catch()`**. `pi.sendMessage` returns a Promise. The `serializedSend` mutex's own comment (line ~491) documents that concurrent sends surface as **"Agent is already processing"** errors. At the moment this fires, the host **is** mid-turn (`complete_goal` is executing) → the send can reject → unhandled rejection → Node kills the process, no host stack trace. Upstream avoids this specific death because it **`await`s** the send, turning any rejection into a thrown error inside `execute` (catchable, recoverable, *with* a stack trace).

- Fork-only form: ✅ (the no-await/no-catch shape is a direct artifact of the `ff36e54` "fix").
- Why secondary, not primary: the lifecycle gap places the failure *inside* `runGoalCompletionAuditor`, and the ledger proves execution proceeds past this send to write `audit_started`. An async rejection from this send *could* fire later during the auditor await, so it is fully consistent with the symptom — but it is a consequence of the same "fix" that papered over H1, and fixing it alone (adding `.catch()`) would **not** stop the H1 hang. Flag it as a separate latent bug to fix regardless.

### ❌ Ruled out

- **H3 — `triggerTurn: true` re-entrancy.** Already removed by `aa2f4d1` (B2). Not present in current code. Critically: **upstream *does* use `await pi.sendMessage({…}, { triggerTurn: true })` and does NOT crash** — so `triggerTurn:true` cannot be the fork-only cause. The task hint to "hunt for `triggerTurn:true` re-introduced" returns negative: the only remaining `triggerTurn:true` calls are in the **continuation path** (`goal.ts:1590`, `1718`), unrelated to `complete_goal`.
- **H4 — `emitAuditorSubscription`.** Fully fire-and-forget: body runs inside `queueMicrotask` with two nested `try/catch` blocks; returns `void`. Cannot hang or surface a rejection to the caller. (`extensions/goal-auditor-subscriptions.ts`.)
- **H5 — `serializedSend` mutex deadlock.** The audit-start send is a **bare** `pi.sendMessage` (not wrapped). `serializedSend` wraps only the continuation sends (`goal.ts:1576, 1704, 1748`), none in the `complete_goal` body. No deadlock reachable from `complete_goal`.
- **H6 — `process.exit` / kill / destroy / poll loop.** `grep` of the entire `complete_goal` region (`goal.ts:2868–3340`) and all of `goal-auditor.ts` for `process.exit | process.kill | .kill( | .destroy( | sessionManager | while (` → **zero matches**. Not a process-kill mechanism.
- **H7 — `logAuditorTrace`.** Wrapped in `try { } catch { }` ("trace logging must never crash the audit"). Benign.

## 4. Why the current `serializedSend` + fire-and-forget fix does NOT address it

The two landed fixes both touch the **audit-start `sendMessage` at `goal.ts:~3080`** — i.e. *before* `audit_started` is appended (`:3087`). The ledger for goal `n270l-bzrhy7` shows `completion_requested` + `audit_started` are both present, so execution demonstrably **passes** the patched line and reaches the auditor spawn. The actual hang/exit is **inside** `await runGoalCompletionAuditor({...})` at `goal.ts:~3137` → `await session.prompt(...)` at `goal-auditor.ts:~707`. No change to the `sendMessage` line can affect a hang that occurs ~60 lines and one `await` later, inside the auditor's model call. The fix is literally patching the wrong line — which is why the crash persisted through *both* commits.

(Secondary: the `ff36e54` fire-and-forget also **introduces** the H2 unhandled-rejection vector. So the "fix" is not merely ineffective against the real cause — it adds a new silent-death path of its own.)

## 5. The precise fix (make fork match upstream's safe behavior)

**Primary fix (one block, ~4 lines) — remove the inheritance, restore isolation:**

```diff
 // extensions/goal.ts, complete_goal.execute (~line 3137)
 const auditor = await runGoalCompletionAuditor({
     ctx,
     goal: auditTarget,
     completionSummary: params.completionSummary,
     detailedSummary: detailedSummary(auditTarget),
     verificationSummary: params.verificationSummary,
     settings,
     signal: auditAbortController.signal,
-    mainResources: {
-        tools: safeGetActiveTools(pi),
-        inheritFromCwd: true,
-    },
     onProgress: (progress) => { … },
 });
```

This single deletion restores upstream's behavior: `runGoalCompletionAuditor` then receives no `mainResources`, skips the `inheritFromCwd` branch, calls `makeAuditorResourceLoader()` with no host loader, and `createSession` runs with an empty resource set. To *exactly* match upstream's isolation, also restore inside `goal-auditor.ts` `createSession`:
- `resourceLoader: makeAuditorResourceLoader()` (no args),
- `tools: ["read","grep","find","ls","bash", REPORT_AUDITOR_PROGRESS_TOOL_NAME]` (hardcoded),
- `settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } })`.

(The `inheritFromCwd` feature, commit `043c16e`, was a deliberate fork addition so the auditor can verify work "using the same tools the executor had." That capability is what reintroduces the crash. If the team still wants resource inheritance, it must be done **out-of-process** or with a hard extension/MCP allow-list — never by replaying the host's live loader into an in-process child. That is a design change, not a one-liner, and is out of scope for this read-only task.)

**Secondary fix (independent latent bug — recommended regardless):**

```diff
 // extensions/goal.ts:~3080  — close the H2 unhandled-rejection hole
-pi.sendMessage<GoalAuditEventDetails>({ … });
+pi.sendMessage<GoalAuditEventDetails>({ … }).catch(() => { /* UI notify best-effort */ });
```

## 6. Upstream reachability

✅ `upstream/main` **is** fetched and reachable. `git fetch upstream` succeeded; `git show upstream/main:extensions/goal.ts` and `…/goal-auditor.ts` both resolve. No re-spawn with fetch instructions is needed.

## 7. Evidence index (line numbers, fork `main` unless noted)

| What | Fork location | Upstream location |
|---|---|---|
| `complete_goal` tool def | `goal.ts:2870` | `goal.ts:2301` |
| audit-start `sendMessage` (fire-and-forget) | `goal.ts:~3080` | `goal.ts:~2533` (`await …, { triggerTurn: true }`) |
| `audit_started` ledger append | `goal.ts:~3087` | `goal.ts:~2540` |
| `runGoalCompletionAuditor` call w/ `mainResources` | `goal.ts:~3137` | `goal.ts:~2587` (**no** `mainResources`) |
| `serializedSend` mutex | `goal.ts:492-509` | absent |
| `inheritFromCwd` branch + `await mainResourceLoader.reload()` | `goal-auditor.ts:443-450` | absent |
| `makeAuditorResourceLoader()` empty vs `(resolved, mainResourceLoader)` | `goal-auditor.ts:289` | `goal-auditor.ts` (no-arg, empties) |
| `createSession` (host tools/compaction-on vs hardcoded/compaction-off) | `goal-auditor.ts:566-578` | `goal-auditor.ts:317-326` |
| author's own "extension onLoad failure" comment | `goal-auditor.ts:579-580` | n/a |
| `await session.prompt(...)` (the actual hang point) | `goal-auditor.ts:~707` | `goal-auditor.ts:399` |
| `isGoalSelfExtension` self-exclusion guard | `goal-auditor.ts:280-287, 307` | absent (no inheritance to guard) |

**Relevant commits:** `043c16e` (introduced `inheritFromCwd`), `aa2f4d1` (removed `triggerTurn:true` B2 + added `isGoalSelfExtension` B3 + forensic logging + compaction-on), `ff36e54` / `ba95d07` / `ec4517c` (removed `await` + added `serializedSend`).

---

### Note on the trace
The 23 MB `auditor-trace.jsonl` lives in beet-orches and was **not** read (out of scope: "Do NOT touch beet-orches"). The task briefing already establishes its salient facts: it instruments the auditor **child** only and ends at `auto_retry_start`; the **host** side is uninstrumented; goal `n270l-bzrhy7` has `completion_requested` + `audit_started` but no `audit_result`/`goal_completed`. This report relies on those stated facts; the code-level analysis above is self-consistent with them and does not require the raw trace.
