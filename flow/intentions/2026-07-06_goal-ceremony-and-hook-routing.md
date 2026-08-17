# Intentions — Goal ceremony + hook routing

> Date: 2026-07-06
> Source: webui chat upload `01-webui-input-2026-07-05T18-34-20Z.txt`
> Status: raw (verbatim)

## Verbatim user words

> intentions How do I be able to append / completely override the goals set / sisyphus for these behavior: adding ceremony:
> - before calling completion , must always do the verifier loop. Auditor MUST always reject the works if it NOT having verifier loop approval.
> - hides / disable: block / pause / question after the goal start , or just disable it completely. DO WE be able to enable hooks that pass these block / pause / question to the other backend? Do we be able to pass these hooks to auditor as well?
> - <conditional , check if TEAMS having the goal inherit in the FORK mode fixed or not>. IF NOT , then add the prompt NEVER delegate teams in fork mode

### Q/A clarifications (verbatim answers)

**Q1 "append / completely override"** → `via setting file.`
**Q2 "block / pause / question"** (asked i/ii/iii) → `isn't 1 2 3 is the same itself ?`
**Q3 "pass to other backend"** → `just give me the capability. like it is a curl / rest api call.`
**Q4 "pass hooks to auditor"** → `for review and decide if it should be actually block / pause / question OR reject it and demand the main agent to take another action`
**Q5 "before completion"** → `final` (final goal completion only)
**Q5 "verifier loop"** → `exactly that one , the one in the skill.`
**Q6 "TEAMS fork check"** → `check`

---

## Elaboration

### E1 — Scope of "block / pause / question" (Q2 unification)
User treats the three as one category. In implementation they're distinct layers, but user intent = unified control surface. Treat as **one policy class "interruption events"** spanning:
- (i) goal-xx's own question/pause tools mid-goal (`goal_question`, `goal_questionnaire`, `pause_goal`)
- (ii) other extensions' block/pause/question hooks firing while goal active
- (iii) agent-initiated pauses (`pause_goal`, `confirmFocusOverride`)
→ Single settings flag family `interruptions.*` controls all three.

### E2 — Verifier-loop ceremony scope
- Trigger: BEFORE `complete_goal` final (NOT per-task).
- Verifier = jewilo CLI per skill `verifier-loop`.
- Auditor gate: if no `mmddyy-XXXXXXXX` hash → auditor REJECTS.
- Hash must be cited in goal completion record.

### E3 — Hook dispatch = REST/curl capability
- User wants raw HTTP capability, NOT opinionated backend integration.
- Settings: `interruptions.webhook.url`, `interruptions.webhook.method`, headers, body template.
- Events: `block`, `pause`, `question` fired as JSON.
- Async fire-and-forget by default (don't block agent on webhook latency).
- Optional: auditor-as-webhook (single endpoint that returns decision).

### E4 — Auditor policy gate on hook events
- Webhook response (or local auditor) decides per-event:
  - `allow` → execute the interruption
  - `reject` → cancel interruption, demand agent take alternative action
- Auditor logic reuses existing auditor subsystem.

### E5 — TEAMS fork-mode goal inheritance
**VERDICT: BROKEN / NOT inherited.**
- Evidence: `pi-agent-teams/extensions/teams/leader.ts:640-643` — child spawned with `--no-skills -e <teamsEntry>` (only teams ext loaded; goal-xx NOT loaded).
- Worktree mode = separate cwd → goal file not in child cwd.
- Branch mode copies session JSONL but goal is file+extension state, not in branch JSONL payload as runtime state.
- **→ Conditional prompt "NEVER delegate teams in fork mode" REQUIRED.**

### E6 — Settings file location
Per existing goal-xx pattern: `.pi/goal-xx.json` or `flow/_STATE.md`-style. To be confirmed in requirements; existing settings live in `extensions/goal-settings.ts`.

### E7 — Ambiguity still open (deferred)
- Disable mode: hard-disable (tool registration skipped) vs soft-disable (tool present but auto-rejected by auditor). User said "disable completely" — leaning hard, but auditor-gate implies soft. Plan MUST support both; default TBD.

## Cross-refs
- Verifier loop skill: `~/.agents/skills/verifier-loop/SKILL.md`
- Auditor config design: `flow/findings/auditor-config-design/`
- Existing auditor inheritance: `flow/findings/2026-07-03-auditor-resource-inheritance-unblocked.md`
