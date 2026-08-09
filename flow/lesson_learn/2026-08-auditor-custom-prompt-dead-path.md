# LSL: Auditor custom prompt was never loaded

## Problem
`auditor.md` existed only at the git-sourced repo path inside pi-agent dir:
`.pi/agent/git/github.com/buihongduc132/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md`

The resolver lookups are:
- global: `~/.pi/pi-goal-xx/prompts/auditor.md`
- local:  `<cwd>/.pi/pi-goal-xx/prompts/auditor.md`

Neither existed → auditor always fell through to hardcoded default. The custom prompt (fail-fast rule + fallback clause) was never applied.

## Solution
Copy `auditor.md` to the correct global path:
```
~/.pi/pi-goal-xx/prompts/auditor.md
```

## Prevention
After editing `.pi/pi-goal-xx/prompts/auditor.md` in the repo, always sync to `~/.pi/pi-goal-xx/prompts/` manually or via deploy script. The repo copy is source-of-truth but NOT the loaded path.
