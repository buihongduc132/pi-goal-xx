# Guard map + tool friction — who blocks what, sanctioned paths

- date: 2026-08-29
- trigger: session burned ~10 tool calls on guard-blocked git ops + broken process tool; user demanded subagent research + honest no-progress audit.

## Guard layers (3, distinct)

| Tag in output | Source | Scope | Sanctioned path |
|---|---|---|---|
| `[pi-bash-guard]` | `~/.pi/agent/extensions/pi-bash-guard/` (config: `<cwd>/.pi-bash-guard.json` or `~/.config/pi-bash-guard/config.json`) | timeouts, env preamble, arg rewrites (vitest `--run`) | rewrite groups refuse pipes → run target cmd with direct args, no pipes |
| `BLOCKED: ... (rule: custom:NNNN)` + `Rule family: custom` | **pi-opa-net** `~/.pi/agent/npm/node_modules/pi-opa-net/` policy `policy/safety.rego` | git checkout/switch branch allowlist (GROUP G L562), worktree dirs (GROUP H), destructive git | 1) **worktree isolation** — GROUP G only fires when `signals.repo.is_main_worktree == true`; work inside `.worktrees/` = exempt BY DESIGN 2) `PIOPANET_ALLOWED_BRANCHES` env (Config.ts:95) 3) unlock keys `PIOPANET_UNLOCK_KEYS`+salt |
| `[git-guard] BLOCKED ... GIT_GUARD_DISABLE=1` | hermes-side shell guard (aliases `ggc`, `ggs_`) | NOT active in pi bash tool | n/a in pi |

## The sanctioned branch-test-merge loop (zero violations)

1. `git worktree add <repo>/.worktrees/<name> <branch>` — GROUP H allows `.worktrees/` prefix.
2. Run tests IN worktree: node --test needs no node_modules for pure-node tests; if deps needed, `npm ci` in worktree (NOT symlink — vite resolves foreign roots).
3. Review: `git diff main...<branch>` from main worktree (read-only, always allowed).
4. Merge: `gh pr merge N --squash` (gh is unguarded).
5. `git pull` while ON main (main is allowlisted; never left it).
6. Cleanup: worktree remove fails on untracked leftovers — `rm -rf <wt> && git worktree prune` (rm of own temp files allowed).

Never: `git checkout <branch>` in main worktree, `git stash push/pop`, `git restore`/`checkout --` (all user-rules blocked; provide one-liner for human if truly needed).

## process tool ENOENT root cause

- `pi-processes/src/manager.ts:65` — `logDir = /tmp/pi-processes-<ts>`, mkdir at construction (session start).
- `src/hooks/cleanup.ts:6` — `pi.on("session_shutdown")` → `manager.cleanup()` → `rmSync(logDir, recursive)`.
- **Bug**: in-process child sessions (goal auditor children, subagents) fire `session_shutdown` on the shared bus → logDir deleted while host session lives → every later `process.start` = ENOENT (`start.ts:172`).
- Evidence: this session's dir `pi-processes-1787716466666` gone; other sessions' dirs alive; disk not full.
- Fix direction (NOT applied): guard cleanup to root-session shutdown only, or re-mkdir logDir inside `start()`.

## Process discipline failures (self-audit, this session)

1. `rg -r` replaces matches — used it twice, corrupted own search output ("ln=1" artifacts). Use plain `rg -n`.
2. Assumed vitest; repo = `node --test` (package.json readable in 1 line). Read runner BEFORE running.
3. No main-baseline before branch-suite comparison → 84-vs-80 flipflop; baseline-first would have been 1 diff.
4. Guard guessing (6 blocked attempts) instead of reading the guard source first — `grep -rln "Rule family" ~/.pi/agent/npm/node_modules` was one command.
