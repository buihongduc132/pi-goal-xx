# References

> Sources consulted during this explore session.

## Source files

- `extensions/goal-auditor.ts` — `runGoalCompletionAuditor`, `buildAuditorPromptParts`, `buildGoalAuditorPrompt`, `makeAuditorResourceLoader`, `complete_goal` tool definition
- `extensions/auditor-prompt.ts` — `loadAuditorPrompt`, `DEFAULT_PROMPTS_DIR`, `globalAuditorPromptPath`, `resolveAuditorPromptMode`
- `extensions/goal-prompt-resolver.ts` — `loadGoalPrompt`, `customGoalPromptBlock`, `GoalPromptMode`, legacy path resolution
- `extensions/prompt-resolver.ts` — unified `resolvePrompt`, `PromptMode`, `PromptConfig`, mtime cache
- `extensions/goal-settings.ts` — `promptsDir`, `goalPromptMode`, `goalPrompt` inline, settings schema
- `extensions/prompts/goal-prompts.ts` — `goalPrompt()`, `customGoalPromptBlock` injection sites (L191, L228, L251, L299)
- `~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md` — repo source copy of auditor custom prompt (confirmed dead — not on resolver path)
- `/home/bhd/.pi/goal-prompt.md` — global goal custom prompt (confirmed live)

## Code patterns

- `DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/"` — unified prompts dir relative to home/cwd; found in `auditor-prompt.ts` and `prompt-resolver.ts`
- Legacy auditor path: `<home|cwd>/.pi/auditor-prompt.md` — backward compat fallback in `auditor-prompt.ts`
- Legacy goal path: `<home|cwd>/.pi/goal-prompt.md` — current only path in `goal-prompt-resolver.ts` (not yet migrated to unified)
- `resolveBlock()` in `prompt-resolver.ts` — handles all 6 modes: override, append, global-local, local, global-local-merge, off
