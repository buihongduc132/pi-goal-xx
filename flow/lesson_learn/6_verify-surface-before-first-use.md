# 6: Guessing unproven surfaces — flags, paths, discovery hops

## Context
Three same-shape failures in one session:
- F3: guessed multica CLI flags (`--body-file` → unknown flag → had to read --help after the fact). Correct: `--content-file` + `--allow-external-file`.
- F5: guessed skill path (`~/.agents/skills/compress` → ENOENT → fd search → real: `~/.pi/agent/skills/compress`). Machine has MULTIPLE skill roots (~/.pi/agent, ~/.agents, ~/.claude, ~/.codex, ~/.opencode).
- F6: 3-hop discovery loop (ls → grep → grep) for an API route where ONE scoped search resolves it: `fd -t f route.ts src/app/api/goals`.

Root cause: try-first, verify-later on any surface not yet proven THIS session.

## Solutions
HARD rules:
1. ANY CLI subcommand used FIRST TIME in session → run `<cmd> <sub> --help` BEFORE first call. No analogical flag guessing.
2. Skill/path resolution = one-shot search, never guess:
   `fd -t f 'SKILL.md' ~/.pi/agent/skills/<n> ~/.agents/skills/<n> ~/.claude/skills/<n> 2>/dev/null | head -1`
3. Before ANY directory walk: ONE scoped search on the LEAF name (`fd -t f '<leaf>' <root>` / `rg -l '<symbol>' <root>`). Widen only on empty result. (Machine mandates rg/fd/eza preference anyway.)
4. One-guess budget: max 1 speculative attempt on an unfamiliar surface, then MANDATORY `--help`/search. Arms the 3-strikes rule at strike 1 for silent-wrong failures (output accepted, no error — the class that never triggers 3-strikes on its own).

Cross-cutting: "verify surface before first use" — help text / fd search / fact grep. Same habit kills all three.
