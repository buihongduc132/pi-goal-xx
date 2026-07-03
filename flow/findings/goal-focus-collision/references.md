# References

> Sources consulted during this explore session.

## Source files (pi-goal-xx repo)

- `extensions/goal-pool.ts` — `resolveSessionFocus` (lines 37-55): the auto-focus logic that steals the only open goal into a fresh session. `openGoalsFromPool`, `focusedGoalFromPool`. Core of collision C1.
- `extensions/goal.ts` — orchestration. Key sections read:
  - Lines 186-200 (`isWorkerSession`): worker detection is ONLY `process.env.PI_TEAMS_WORKER === "1"`. No worktree/ad-hoc detection. [E3]
  - Lines 420-435 (`focusedGoalId` module state): per-session focus state.
  - Lines 744-746 (`armFocusedContinuation`): arms auto-continue after focus.
  - Lines 941-1004 (`loadState`): session_start loads goal pool from disk, resolves focus via `resolveSessionFocus`. Worker session early-returns; non-worker falls through to auto-focus.
  - Lines 1417-1444 (`queueContinuation`): the auto-run mechanism.
  - Lines 3647-3663 (`session_start` handler): `loadState` → `queueContinuation(ctx, true)` unconditional. No lock gate. [E2]
- `extensions/storage/goal-files.ts` — disk persistence:
  - Line 19 (`GOALS_DIR = ".pi/goals"`): cwd-relative, shared across sessions. [E4]
  - Lines 87-95 (`atomicWriteGoalFile`): write-tmp + rename. Prevents torn writes, NOT lost-update races. [E5]
  - Lines 264-286 (`readActiveGoalFiles`, `readActiveGoalPool`): reads all `.pi/goals/*.md` into the pool.

## Source files (node_modules — @earendil-works/pi-coding-agent)

- `dist/core/sdk.js:83-99` (`createAgentSession`): with no `resourceLoader`, auto-builds `DefaultResourceLoader({cwd, agentDir, settingsManager})` and `.reload()`s it. The discovery that unblocked the auditor inheritance (prior work).
- `dist/core/sdk.js:275` + `dist/core/agent-session.js:1874-1911`: `createAgentSession` loads extensions via `resourceLoader.getExtensions()` and fires `session_start` on them. [E6] — confirmed the auditor sub-session loads `pi-goal-xx` → its `session_start` → `loadState` → collision vector C4.
- `dist/index.d.ts:14` — exports `DefaultResourceLoader`.
- `dist/core/resource-loader.d.ts:56-107` — `DefaultResourceLoaderOptions` constructor shape.

## Code patterns referenced

- **Per-session focus, shared disk pool** — `focusedGoalId` is module-level (per-session) but the goal files it reads/writes are cwd-shared. The asymmetry is the root cause of C1/C5.
- **Auto-derivation from disk** — `loadState` reads `.pi/goals/` on every `session_start`/`session_tree`, deriving focus from disk state rather than from an explicit session-owned intent. The auto-focus + auto-run chain (`loadState` → `resolveSessionFocus` → `queueContinuation`) has no gate between "I discovered a goal" and "I started running it."
- **Single escape hatch (`PI_TEAMS_WORKER`)** — the only mechanism that prevents focus inheritance. Too narrow: misses worktrees, ad-hoc sessions, auditor sub-sessions.
- **Atomic write (tmp+rename) without versioning** — prevents corruption but allows lost updates when two sessions hold stale views of the same file.

## Documents / prior findings

- `flow/findings/2026-07-03-auditor-resource-inheritance-unblocked.md` — prior session's post-mortem on the auditor inheritance fix. Established that `createAgentSession({cwd})` auto-discovers from cwd. Context for C4 (the new collision vector that fix introduced).
- `flow/findings/auditor-config-design/` — the auditor-config explore (turns 1-3, locked decisions LD1-LD6). The inheritance mechanism's locked decisions. The work whose side-effects (AGENTS.md coupling, auditor loading pi-goal-xx) surfaced OT7/OT8.
- `openspec/changes/configurable-auditor/design.md` — D5 (resource inheritance mechanism) documents the `DefaultResourceLoader(cwd)` approach that this explore's C4 builds on.

## External concepts

- **Lease-based locking** — the two-signal liveness model (PID check + lease TTL) is a standard distributed-systems pattern. The AND-logic (both must hold for LOCKED) is what makes it robust against PID reuse and hung processes. Referenced from general knowledge; no specific doc cited.
- **Advisory lock** — the lock does not physically prevent access; it's a coordination signal that cooperating sessions check. User explicitly chose advisory semantics (LD2: "the lock is advisory; the user is the authority").
