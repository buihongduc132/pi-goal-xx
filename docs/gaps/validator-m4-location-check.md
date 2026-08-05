# Gap: M4 — Location check (repo-not-on-main → parent .pi/goals/)

> Status: DEFERRED (per goal custom prompt: skip + document gap)
> Date: 2026-08-05
> Blocker: complexity vs reliability tradeoff

## Rule (SOUL J-r)

> "main worktree `.pi/goals/`, NEVER side worktrees"

If a repo checkout is NOT on `main` branch, the goal file MUST live in the parent repo's `.pi/goals/`.

## Why deferred

Implementing reliably requires:
1. Walk up from `.pi/goals/` to find the git repo root
2. Check `git -C <root> rev-parse --abbrev-ref HEAD` — if not `main`, walk to parent repo
3. Verify goal file path is under parent repo's `.pi/goals/`

Edge cases that broke 2 attempts:
- Submodules (`.git` is a file, not dir)
- Worktrees (HEAD is detached, branch may be valid feature branch not main)
- Monorepo with nested repos (beet-orches + mod-cp both have `.pi/goals/`)
- Tmp dir in tests (no git repo at all)

## Workaround

M13 (subdir check) catches the most common violation (goal in `.pi/goals/subdir/`). M4 is a stricter location check that requires the parent-repo logic.

## Fix path (for future implementer)

1. Use `git -C <dir> rev-parse --show-toplevel` to find repo root
2. Check `git -C <root> symbolic-ref --short HEAD` (fails cleanly on detached)
3. If not `main` AND not detached → walk up to parent dir, repeat
4. Verify goal file's `.pi/goals/` is in the topmost "main" repo found

## Test fixture needed

- beet-orches on `main` + mod-cp on `dev` → goal in mod-cp `.pi/goals/` should FAIL
- beet-orches on `main` + mod-cp on `dev` → goal in beet-orches `.pi/goals/` should PASS
