/**
 * RED PHASE — auditor prompt must instruct the model about early_disapprove (LD1/LD9).
 *
 * Spec: flow/findings/2026-07-31-auditor-capabilities-gaps/
 *   - LD1: must implement early disapproval
 *   - LD9: signal mechanism is the `early_disapprove(reason)` tool call
 *   - flow/findings/.../2026-07-31-turn1a-gotcha-early-disapproval.md Rank 4
 *     "No calibration of 'disqualifying issue'" → mitigation: enumerate the tool
 *     in the auditor prompt so the model knows HOW to early-disapprove.
 * Plan: flow/plans/2026-07-31_pre-audit-hooks-and-early-disapprove.md (RED-B).
 *
 * Contract under test (GREEN implements in extensions/goal-auditor.ts):
 *  - buildGoalAuditorPrompt's persona preamble (the first ~1500 chars of the prompt,
 *    i.e. the persona array before the fact layer) must instruct the auditor model
 *    about the early_disapprove(reason) tool: what it is, when to call it, and that
 *    calling it aborts the audit immediately.
 *
 * Today this FAILS: the current persona preamble never mentions early_disapprove.
 * Project `tsc --noEmit` stays green (tests excluded from tsconfig).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGoalAuditorPrompt } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-prompt-instruction",
		objective: "Build the thing for real",
		status: "active",
		autoContinue: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

describe("Auditor prompt — instructs about early_disapprove(reason) (LD9)", () => {
	it("persona preamble mentions the early_disapprove tool", () => {
		const prompt = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "All tasks complete",
		});
		// The persona preamble lives at the top of the prompt, before the fact layer.
		const preamble = prompt.slice(0, 1500);
		assert.ok(
			preamble.includes("early_disapprove"),
			"persona preamble must teach the model the early_disapprove tool exists",
		);
	});

	it("persona preamble references the reason parameter (early_disapprove(reason))", () => {
		const prompt = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "All tasks complete",
		});
		const preamble = prompt.slice(0, 1500);
		assert.ok(
			/early_disapprove\s*\(\s*reason\s*\)/.test(preamble) || preamble.includes("reason"),
			"persona preamble must show the early_disapprove(reason) call shape",
		);
	});

	it("persona preamble says calling early_disapprove aborts the audit immediately", () => {
		const prompt = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "All tasks complete",
		});
		const preamble = prompt.slice(0, 1500).toLowerCase();
		assert.ok(
			preamble.includes("abort"),
			"persona preamble must state that early_disapprove aborts the audit",
		);
		assert.ok(
			preamble.includes("immediate") || preamble.includes("immediately"),
			"persona preamble must state the abort is immediate",
		);
	});
});
