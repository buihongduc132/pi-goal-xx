import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeQuestionnaireQuestions,
	formatQuestionnaireAnswers,
	shouldAutoConfirmProposal,
	proposalDecisionFromQuestionnaireResult,
	isHeadlessQuestionSufficientForDraft,
	proposalDialogFailureMessage,
	type GoalQuestionnaireQuestion,
	type GoalQuestionnaireResult,
} from "../extensions/goal-questionnaire.ts";

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
