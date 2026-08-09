# Q1 Decision: create_goal enable = (b) functional

> Date: 2026-07-21
> Goal: mruclxo8-zl33gu (start_goal/create_goal callable-while-hidden)
> Task: t1 (BLOCKER resolution)
> Decider: pi-agent (autonomous — override prohibits user pause)

## Decision

**create_goal when enabled via `PI_GOAL_ENABLE_CREATE_GOAL=1`:**
- Un-delete from active set (callable).
- Remove the hard-locked REJECT in execute().
- Execute creates a goal WITHOUT auto-run (startNow=false), preserving semantic distinction from start_goal.

```ts
// extensions/goal.ts create_goal execute (when enabled):
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const raw = (params.objective ?? "").trim();
    if (!raw) return { content: [{type:"text", text:"create_goal REJECTED: no objective provided."}], details: goalDetails(state.goal) };
    if (raw.length > MAX_OBJECTIVE_LENGTH) return { content: [{type:"text", text:`create_goal REJECTED: objective >${MAX_OBJECTIVE_LENGTH}-char limit.`}], details: goalDetails(state.goal) };
    const { objective, verificationContract } = extractVerificationContract(raw, ctx.cwd, loadGoalSettings(ctx.cwd));
    const autoContinue = params.autoContinue ?? true;
    const sisyphus = params.sisyphus ?? false;
    clearContinuationState();
    clearActiveAccounting();
    confirmationIntent = null;
    syncGoalTools();
    replaceGoal({ objective, autoContinue, sisyphus }, ctx, false, verificationContract); // startNow=FALSE — no auto-run
    return {
        content: [{type:"text", text: buildGoalCreatedReport({ objective: raw, detailedSummary: detailedSummary(state.goal) })}],
        details: goalDetails(state.goal),
    };
}
```

## Rationale

- (a) honeypot rejected: vacuous. No use case for enabling a tool that just rejects.
- (b) preserves opt-in's purpose: user explicitly wants create_goal functional.
- startNow=false preserves create-vs-start distinction (create_goal ≠ start_goal).
- Default off → safety net (propose_goal_draft confirmation path) intact for non-opt-in users.
- Mirrors propose_goal_draft's post-confirm behavior (create-only, no auto-run loop start).

## Trade-offs (documented)

- Bypasses propose_goal_draft user-confirmation when enabled. ACCEPTED — opt-in is explicit consent.
- Schema still visible to model (pi-core limit, OT3). Model can call create_goal unprompted when env=1. Mitigated by no-promptSnippet (no prose ad).

## Verification

- Decision recorded here: `flow/decisions/2026-07-21_q1-create-goal-functional.md`
- Decision recorded in goal objective + t3/t4 commit messages.
