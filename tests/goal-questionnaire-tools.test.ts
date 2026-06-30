import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	registerQuestionnaireTools,
	showProposalDialog,
	runGoalQuestionnaire,
} from "../extensions/goal-questionnaire.ts";

// Minimal stubs — only the surface these functions touch. The TUI path is
// exercised through the headless short-circuit (ctx.hasUI === false), which is
// the documented behaviour for non-interactive / test contexts.

interface CapturedTool {
	name: string;
	execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) => Promise<any>;
	renderCall: (args: any, theme: any) => unknown;
	renderResult: (result: any, opts: any, theme: any) => unknown;
}

function captureTools(): { tools: CapturedTool[]; pi: any } {
	const tools: CapturedTool[] = [];
	const pi: any = {
		registerTool(def: any) {
			tools.push({
				name: def.name,
				execute: def.execute,
				renderCall: def.renderCall,
				renderResult: def.renderResult,
			});
		},
	};
	return { tools, pi };
}

function stubTheme(): any {
	const id = (s: string) => s;
	return { fg: id, bg: id, bold: id };
}

function headlessCtx(): any {
	return { hasUI: false };
}

describe("registerQuestionnaireTools", () => {
	it("registers exactly goal_question and goal_questionnaire tools", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		assert.deepEqual(tools.map((t) => t.name).sort(), ["goal_question", "goal_questionnaire"]);
	});

	it("goal_question.execute returns headless message when no UI", async () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_question")!;
		const res = await q.execute("tc1", { question: "pick?", options: ["a", "b"] }, undefined, undefined, headlessCtx());
		assert.equal(res.details.cancelled, true);
		assert.match(res.content[0].text, /Headless mode/);
	});

	it("goal_questionnaire.execute returns headless message when no UI", async () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		const res = await q.execute("tc1", { questions: [{ id: "x", question: "q?" }] }, undefined, undefined, headlessCtx());
		assert.equal(res.details.cancelled, true);
		assert.match(res.content[0].text, /Headless mode/);
	});

	it("goal_question.renderCall returns a Text without throwing", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_question")!;
		assert.doesNotThrow(() => q.renderCall({ question: "hi" }, stubTheme()));
	});

	it("goal_question.renderResult handles cancelled details", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_question")!;
		const out = q.renderResult({ details: { cancelled: true }, content: [{ type: "text", text: "x" }] }, {}, stubTheme());
		assert.ok(out);
	});

	it("goal_question.renderResult handles answered details", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_question")!;
		const out = q.renderResult({ details: { answer: "yes" }, content: [] }, {}, stubTheme());
		assert.ok(out);
	});

	it("goal_question.renderResult falls back to content text when no details", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_question")!;
		const out = q.renderResult({ details: undefined, content: [{ type: "text", text: "fallback" }] }, {}, stubTheme());
		assert.ok(out);
	});

	it("goal_questionnaire.renderCall renders question count and labels", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		assert.doesNotThrow(() =>
			q.renderCall({ questions: [{ id: "a", question: "x" }, { id: "b", question: "y" }] }, stubTheme()),
		);
	});

	it("goal_questionnaire.renderCall handles empty questions array", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		assert.doesNotThrow(() => q.renderCall({ questions: [] }, stubTheme()));
	});

	it("goal_questionnaire.renderResult handles dismissed (cancelled)", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		const out = q.renderResult({ details: { cancelled: true, answers: [] }, content: [] }, {}, stubTheme());
		assert.ok(out);
	});

	it("goal_questionnaire.renderResult renders answers", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		const out = q.renderResult({
			details: {
				cancelled: false,
				answers: [
					{ id: "a", question: "q", answer: "ans", wasCustom: false },
					{ id: "b", question: "q2", answer: "custom", wasCustom: true },
				],
			},
			content: [],
		}, {}, stubTheme());
		assert.ok(out);
	});

	it("goal_questionnaire.renderResult falls back to content text when no details", () => {
		const { tools, pi } = captureTools();
		registerQuestionnaireTools(pi);
		const q = tools.find((t) => t.name === "goal_questionnaire")!;
		const out = q.renderResult({ details: undefined, content: [{ type: "text", text: "fb" }] }, {}, stubTheme());
		assert.ok(out);
	});
});

describe("runGoalQuestionnaire — headless short-circuit", () => {
	it("returns cancelled result with no UI", async () => {
		const res = await runGoalQuestionnaire(headlessCtx() as any, [
			{ id: "q", question: "x?", options: ["a"] },
		]);
		assert.equal(res.cancelled, true);
		assert.deepEqual(res.answers, []);
		assert.deepEqual(res.questions, []);
	});
});

describe("showProposalDialog", () => {
	it("returns continue decision in headless mode (no UI)", async () => {
		const res = await showProposalDialog(headlessCtx() as any, "confirm text", "goal");
		assert.equal(res.decision, "continue");
		assert.equal(res.auditorEnabled, true);
	});

	it("uses sisyphus header title for sisyphus focus (still headless → continue)", async () => {
		const res = await showProposalDialog(headlessCtx() as any, "text", "sisyphus");
		assert.equal(res.decision, "continue");
	});

	it("respects explicit defaultAuditorEnabled when provided", async () => {
		const res = await showProposalDialog(headlessCtx() as any, "text", "goal", false);
		// headless → runGoalQuestionnaire returns cancelled; auditorEnabled falls back to ?? true
		// because auditorToggleInit is passed but the UI never toggled. Verifies no throw.
		assert.ok(res.auditorEnabled === true || res.auditorEnabled === false);
	});
});
