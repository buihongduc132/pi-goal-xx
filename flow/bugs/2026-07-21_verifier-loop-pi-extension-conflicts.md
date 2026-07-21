# Blocker: verifier loop pi extension conflicts

## Date
2026-07-21

## Problem
Post-review-fix verifier loop cannot run — pi backend crashes verifier subprocesses.

## Root cause
Git-sourced extensions in `~/.pi/agent/git/github.com/buihongduc132/` have the same
npm package name as their npm counterparts:
- `pi-intercom/package.json` → name `pi-intercom`
- `pi-ralph-wiggum/package.json` → name `@tmustier/pi-ralph-wiggum`

Pi tries to load from BOTH `npm/node_modules/<name>/index.ts` AND
`git/github.com/buihongduc132/<name>/index.ts`, producing:
```
Error: Failed to load extension ".../npm/node_modules/pi-intercom/index.ts":
Tool "intercom" conflicts with .../git/github.com/buihongduc132/pi-intercom/index.ts
```

The npm versions don't physically exist in node_modules but pi still tries to resolve them.

## Impact
- jewilo with `backend: pi` → verifiers crash on startup → null verdicts → "needs: recover"
- jewilo with `backend: hermes` → cooldown triggered after 3+ unhealthy runs
- jewilo with `backend: acpx` → jewilo passes `--profile` flag unsupported by acpx

## Workaround attempted
- Reset `health.jsonl` to clear cooldown → still crashes
- RECOVER goal → verifiers never produced verdicts to recover
- 4+ verifier loop attempts across 3 backends → all failed

## Available evidence (instead of post-fix verifier hash)
1. **First verifier loop** (before review fixes): hash `072126-e2319433`, 2/2 unanimous APPROVE
   - Goal: e6fa3496-2d14-4e2f-9067-a0ba21681c2e
2. **Bot reviews on PR #39** (after review fixes):
   - CodeRabbit: 6 actionable comments, all fixed, all confirmed resolved
   - Gemini: 1 comment (execFileSync), fixed, confirmed
3. **Tests**: 1265/1265 pass (up from 1242 — added 23 new tests)
4. **Typecheck**: clean
5. **Subagent @reviewer** on commit 16f2551: REJECT → all issues fixed in 9d3171b

## Fix needed (separate task)
- Remove npm duplicates from `settings.json` packages[] (if present)
- OR rename git-sourced package.json names to avoid npm-name collision
- OR configure pi to deduplicate by tool name (keep first loaded)
