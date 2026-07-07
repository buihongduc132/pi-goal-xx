import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeQuestionnaireQuestions,
	formatQuestionnaireAnswers,
	shouldAutoConfirmProposal,
	proposalDecisionFromQuestionnaireResult,
	isHeadlessQuestionSufficientForDraft,
	proposalDialogFailureMessage,
	runGoalQuestionnaire,
	type GoalQuestionnaireQuestion,
	type GoalQuestionnaireResult,
} from "../extensions/goal-questionnaire.ts";
import * as questionnaireModule from "../extensions/goal-questionnaire.ts";

describe("normalizeQuestionnaireQuestions", () => {
	it("assigns sequential id q{n} when id is blank", () => {
		const out = normalizeQuestionnaireQuestions([
			{ id: "", question: "a", options: [] },
			{ id: "   ", question: "b", options: [] },
		]);
		assert.equal(out[0].id, "q1");
		assert.equal(out[1].id, "q2");
	});

	it("deduplicates duplicate ids with suffix", () => {
		const out = normalizeQuestionnaireQuestions([
			{ id: "scope", question: "a", options: [] },
			{ id: "scope", question: "b", options: [] },
		]);
		assert.equal(out[0].id, "scope");
		assert.equal(out[1].id, "scope-2");
	});

	it("filters out blank options", () => {
		const out = normalizeQuestionnaireQuestions([
			{ id: "q", question: "a", options: ["yes", "", "   ", "no"] },
		]);
		assert.deepEqual(out[0].options, ["yes", "no"]);
	});

	it("drops out-of-range recommended index", () => {
		const base: GoalQuestionnaireQuestion = { id: "q", question: "a", options: ["x", "y"] };
		assert.equal(normalizeQuestionnaireQuestions([{ ...base, recommended: 5 }])[0].recommended, undefined);
		assert.equal(normalizeQuestionnaireQuestions([{ ...base, recommended: -1 }])[0].recommended, undefined);
		assert.equal(normalizeQuestionnaireQuestions([{ ...base, recommended: 1 }])[0].recommended, 1);
	});

	it("recommended adjusts to filtered options length (drops when >= filtered length)", () => {
		// options has one blank that gets filtered → effective length 1 → index 1 invalid
		const out = normalizeQuestionnaireQuestions([
			{ id: "q", question: "a", options: ["x", ""], recommended: 1 },
		]);
		assert.deepEqual(out[0].options, ["x"]);
		assert.equal(out[0].recommended, undefined);
	});

	it("defaults allowCustom to true when undefined, preserves explicit false", () => {
		const out = normalizeQuestionnaireQuestions([
			{ id: "a", question: "q", options: [] },
			{ id: "b", question: "q", options: [], allowCustom: false },
		]);
		assert.equal(out[0].allowCustom, true);
		assert.equal(out[1].allowCustom, false);
	});

	it("preserves context and question fields", () => {
		const out = normalizeQuestionnaireQuestions([
			{ id: "q", question: "why?", context: "ctx", options: [] },
		]);
		assert.equal(out[0].question, "why?");
		assert.equal(out[0].context, "ctx");
	});
});

describe("formatQuestionnaireAnswers", () => {
	it("renders Q/A pairs joined by --- separator", () => {
		const result: GoalQuestionnaireResult = {
			questions: [{ id: "q1", question: "What?", options: ["a", "b"] }],
			answers: [{ id: "q1", question: "What?", answer: "a", wasCustom: false }],
			cancelled: false,
		};
		const out = formatQuestionnaireAnswers(result);
		assert.match(out, /\*\*Q:\*\* What\?/);
		assert.match(out, /Options: a \/ b/);
		assert.match(out, /\*\*A:\*\* a/);
	});

	it("includes context line when present", () => {
		const result: GoalQuestionnaireResult = {
			questions: [{ id: "q1", question: "What?", context: "Background info", options: [] }],
			answers: [{ id: "q1", question: "What?", answer: "custom", wasCustom: true }],
			cancelled: false,
		};
		const out = formatQuestionnaireAnswers(result);
		assert.match(out, /Background info/);
		assert.match(out, /\*\*A:\*\* custom/);
	});

	it("omits Options line when no options", () => {
		const result: GoalQuestionnaireResult = {
			questions: [{ id: "q1", question: "What?", options: [] }],
			answers: [{ id: "q1", question: "What?", answer: "x", wasCustom: true }],
			cancelled: false,
		};
		assert.doesNotMatch(formatQuestionnaireAnswers(result), /Options:/);
	});

	it("joins multiple answers with separator", () => {
		const result: GoalQuestionnaireResult = {
			questions: [
				{ id: "q1", question: "A?", options: [] },
				{ id: "q2", question: "B?", options: [] },
			],
			answers: [
				{ id: "q1", question: "A?", answer: "1", wasCustom: false },
				{ id: "q2", question: "B?", answer: "2", wasCustom: false },
			],
			cancelled: false,
		};
		const out = formatQuestionnaireAnswers(result);
		assert.match(out, /\*\*A:\*\* 1\n\n---\n\n\*\*Q:\*\* B\?/);
	});

	it("returns empty string for no answers", () => {
		const result: GoalQuestionnaireResult = {
			questions: [{ id: "q1", question: "x?", options: [] }],
			answers: [],
			cancelled: true,
		};
		assert.equal(formatQuestionnaireAnswers(result), "");
	});
});

describe("shouldAutoConfirmProposal", () => {
	it("returns false when autoConfirmEnv is explicit '0'", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
		assert.equal(shouldAutoConfirmProposal({ hasUI: false, autoConfirmEnv: "0" }), false);
	});

	it("returns true when hasUI is false (headless)", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
		assert.equal(shouldAutoConfirmProposal({ hasUI: false, autoConfirmEnv: undefined }), true);
	});

	it("returns false when hasUI is true and no env", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true }), false);
	});

	it("returns true when autoConfirmEnv is '1' regardless of UI", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
		assert.equal(shouldAutoConfirmProposal({ hasUI: false, autoConfirmEnv: "1" }), true);
	});

	// --- RED tests: mode-aware auto-confirm (RPC hasUI lie fix) ---

	it("returns true when mode is 'rpc' even though hasUI is true", () => {
		assert.equal(
			shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: undefined, mode: "rpc" }),
			true,
		);
	});

	it("returns false when mode is 'interactive' and hasUI is true", () => {
		assert.equal(
			shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: undefined, mode: "interactive" }),
			false,
		);
	});

	it("opt-out preserved: autoConfirmEnv '0' wins over mode 'rpc'", () => {
		assert.equal(
			shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0", mode: "rpc" }),
			false,
		);
	});

	it("autoConfirmEnv '1' still forces true in interactive mode", () => {
		assert.equal(
			shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1", mode: "interactive" }),
			true,
		);
	});

	it("mode 'print' (non-interactive, non-rpc) auto-confirms like headless", () => {
		assert.equal(
			shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: undefined, mode: "print" }),
			true,
		);
	});

	it("backward compat: existing calls without mode still pass", () => {
		// These duplicate the original tests but are here to ensure the
		// mode-optional signature doesn't break existing callers.
		assert.equal(shouldAutoConfirmProposal({ hasUI: true }), false);
		assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	});
});

describe("isInteractiveTui", () => {
	const isInteractiveTui = (questionnaireModule as any).isInteractiveTui as
		| ((args: { mode?: string; hasUI: boolean }) => boolean)
		| undefined;

	it("exists as an exported function", () => {
		assert.equal(typeof isInteractiveTui, "function", "isInteractiveTui must be exported");
	});

	it("returns true for interactive mode with hasUI", () => {
		assert.equal(isInteractiveTui!({ mode: "interactive", hasUI: true }), true);
	});

	it("returns false for rpc mode even when hasUI is true", () => {
		assert.equal(isInteractiveTui!({ mode: "rpc", hasUI: true }), false);
	});

	it("returns false for print mode", () => {
		assert.equal(isInteractiveTui!({ mode: "print", hasUI: false }), false);
	});

	it("falls back to hasUI when mode is absent (hasUI true)", () => {
		assert.equal(isInteractiveTui!({ hasUI: true }), true);
	});

	it("falls back to hasUI when mode is absent (hasUI false)", () => {
		assert.equal(isInteractiveTui!({ hasUI: false }), false);
	});
});

describe("runGoalQuestionnaire — RPC regression", () => {
	it("does NOT call ctx.ui.custom when mode is 'rpc' (hasUI lies true)", async () => {
		let customCallCount = 0;
		const ctx: any = {
			hasUI: true,
			mode: "rpc",
			ui: {
				custom: () => {
					customCallCount++;
					return undefined;
				},
			},
		};

		const result = await runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "What?", options: ["a", "b"] },
		]);

		assert.equal(customCallCount, 0, "ctx.ui.custom must NOT be called in RPC mode");
		assert.equal(result.cancelled, true, "RPC mode should return cancelled result");
	});

	it("backward compat: undefined mode with hasUI false returns headless result", async () => {
		let customCallCount = 0;
		const ctx: any = {
			hasUI: false,
			ui: {
				custom: () => {
					customCallCount++;
					return undefined;
				},
			},
		};

		const result = await runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "What?", options: ["a"] },
		]);

		assert.equal(customCallCount, 0, "ctx.ui.custom must NOT be called when hasUI is false");
		assert.equal(result.cancelled, true, "headless should return cancelled");
	});
});

describe("proposalDecisionFromQuestionnaireResult", () => {
	it("returns continue when cancelled", () => {
		assert.equal(
			proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: "Confirm" }),
			"continue",
		);
	});

	it("returns confirm when answer starts with Confirm", () => {
		assert.equal(
			proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — create now" }),
			"confirm",
		);
	});

	it("returns continue for non-confirm answer", () => {
		assert.equal(
			proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting" }),
			"continue",
		);
	});

	it("returns continue when answer undefined", () => {
		assert.equal(
			proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: undefined }),
			"continue",
		);
	});
});

describe("isHeadlessQuestionSufficientForDraft", () => {
	it("returns false for short/vague topics", () => {
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "short", questionText: "x" }), false);
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "organize notes", questionText: "x" }), false);
	});

	it("returns true for sufficiently detailed topic", () => {
		assert.equal(
			isHeadlessQuestionSufficientForDraft({ topic: "Build a CLI tool that does X and Y", questionText: "x" }),
			true,
		);
	});

	it("returns false for notes-ending topics (zh + en)", () => {
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "整理笔记", questionText: "x" }), false);
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "organize notes", questionText: "x" }), false);
	});
});

describe("proposalDialogFailureMessage", () => {
	it("includes error message for Error instance", () => {
		const msg = proposalDialogFailureMessage(new Error("boom"));
		assert.match(msg, /Goal draft confirmation failed: boom/);
		assert.match(msg, /NOT created/);
	});

	it("stringifies non-Error values", () => {
		const msg = proposalDialogFailureMessage("oops");
		assert.match(msg, /: oops/);
		assert.match(msg, /drafting remains active/);
	});

	it("handles object thrown", () => {
		const msg = proposalDialogFailureMessage({ code: 42 });
		assert.match(msg, /\[object Object\]|code/);
	});
});
