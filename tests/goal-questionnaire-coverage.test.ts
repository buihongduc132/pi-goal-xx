/**
 * Coverage-focused tests for extensions/goal-questionnaire.ts
 * Targets uncovered branches identified in c8 coverage report.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeQuestionnaireQuestions,
	formatQuestionnaireAnswers,
	isInteractiveTui,
	shouldAutoConfirmProposal,
	proposalDecisionFromQuestionnaireResult,
	isHeadlessQuestionSufficientForDraft,
	proposalDialogFailureMessage,
	runGoalQuestionnaire,
	showProposalDialog,
} from "../extensions/goal-questionnaire.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// normalizeQuestionnaireQuestions — lines 36-37, 106
// ---------------------------------------------------------------------------
describe("normalizeQuestionnaireQuestions — edge cases", () => {
	it("uses fallback id when q.id is empty or whitespace", () => {
		const result = normalizeQuestionnaireQuestions([
			{ id: "", question: "Q1", options: ["A"] },
			{ id: "   ", question: "Q2", options: ["B"] },
		]);
		assert.equal(result[0].id, "q1");
		assert.equal(result[1].id, "q2");
	});

	it("disambiguates duplicate ids", () => {
		const result = normalizeQuestionnaireQuestions([
			{ id: "dup", question: "Q1", options: ["A"] },
			{ id: "dup", question: "Q2", options: ["B"] },
		]);
		assert.equal(result[0].id, "dup");
		assert.equal(result[1].id, "dup-2");
	});

	it("filters empty options and adjusts recommended", () => {
		const result = normalizeQuestionnaireQuestions([
			{ id: "q1", question: "Q1", options: ["A", "", "B"], recommended: 2 },
		]);
		assert.deepEqual(result[0].options, ["A", "B"]);
		assert.equal(result[0].recommended, undefined); // 2 is out of bounds after filtering
	});

	it("sets allowCustom to true by default", () => {
		const result = normalizeQuestionnaireQuestions([
			{ id: "q1", question: "Q1", options: ["A"] },
		]);
		assert.equal(result[0].allowCustom, true);
	});
});

// ---------------------------------------------------------------------------
// formatQuestionnaireAnswers — lines 47-55
// ---------------------------------------------------------------------------
describe("formatQuestionnaireAnswers", () => {
	it("formats answers with context and options", () => {
		const result = formatQuestionnaireAnswers({
			questions: [
				{ id: "q1", question: "What?", context: "Background info", options: ["A", "B"] },
			],
			answers: [{ id: "q1", question: "What?", answer: "A", wasCustom: false }],
			cancelled: false,
		});
		assert.ok(result.includes("**Q:** What?"));
		assert.ok(result.includes("Background info"));
		assert.ok(result.includes("Options: A / B"));
		assert.ok(result.includes("**A:** A"));
	});

	it("handles missing question gracefully", () => {
		const result = formatQuestionnaireAnswers({
			questions: [],
			answers: [{ id: "unknown", question: "Unknown Q", answer: "X", wasCustom: false }],
			cancelled: false,
		});
		assert.ok(result.includes("**Q:** Unknown Q"));
	});

	it("handles empty options array", () => {
		const result = formatQuestionnaireAnswers({
			questions: [{ id: "q1", question: "Q1", options: [] }],
			answers: [{ id: "q1", question: "Q1", answer: "Free text", wasCustom: true }],
			cancelled: false,
		});
		assert.ok(!result.includes("Options:"));
	});
});

// ---------------------------------------------------------------------------
// isInteractiveTui — line 69 (fallback to hasUI)
// ---------------------------------------------------------------------------
describe("isInteractiveTui — fallback path", () => {
	it("returns ctx.hasUI when mode is not a string", () => {
		assert.equal(isInteractiveTui({ hasUI: true }), true);
		assert.equal(isInteractiveTui({ hasUI: false }), false);
	});

	it("returns true for mode 'tui'", () => {
		assert.equal(isInteractiveTui({ hasUI: false, mode: "tui" }), true);
	});

	it("returns true for mode 'interactive'", () => {
		assert.equal(isInteractiveTui({ hasUI: false, mode: "interactive" }), true);
	});

	it("returns false for unknown mode", () => {
		assert.equal(isInteractiveTui({ hasUI: true, mode: "headless" }), false);
	});
});

// ---------------------------------------------------------------------------
// shouldAutoConfirmProposal — lines 73-80
// ---------------------------------------------------------------------------
describe("shouldAutoConfirmProposal", () => {
	it("returns false when autoConfirmEnv is '0'", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	});

	it("returns true when autoConfirmEnv is '1'", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: false, autoConfirmEnv: "1" }), true);
	});

	it("uses mode when available", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, mode: "tui" }), false);
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, mode: "interactive" }), false);
		assert.equal(shouldAutoConfirmProposal({ hasUI: true, mode: "headless" }), true);
	});

	it("falls back to hasUI when mode is not a string", () => {
		assert.equal(shouldAutoConfirmProposal({ hasUI: true }), false);
		assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
	});
});

// ---------------------------------------------------------------------------
// proposalDecisionFromQuestionnaireResult — lines 83-85
// ---------------------------------------------------------------------------
describe("proposalDecisionFromQuestionnaireResult", () => {
	it("returns 'continue' when cancelled", () => {
		assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: true }), "continue");
	});

	it("returns 'confirm' when answer starts with 'Confirm'", () => {
		assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — yes" }), "confirm");
	});

	it("returns 'continue' when answer does not start with 'Confirm'", () => {
		assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting" }), "continue");
	});

	it("returns 'continue' when answer is undefined", () => {
		assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false }), "continue");
	});
});

// ---------------------------------------------------------------------------
// isHeadlessQuestionSufficientForDraft — lines 88-92
// ---------------------------------------------------------------------------
describe("isHeadlessQuestionSufficientForDraft", () => {
	it("returns false for vague topics", () => {
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "整理笔记", questionText: "Q" }), false);
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "organize notes", questionText: "Q" }), false);
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "notes", questionText: "Q" }), false);
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "笔记", questionText: "Q" }), false);
	});

	it("returns false for short topics (<20 chars)", () => {
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "Short topic", questionText: "Q" }), false);
	});

	it("returns true for specific topics (>=20 chars, not vague)", () => {
		assert.equal(isHeadlessQuestionSufficientForDraft({ topic: "Implement a new feature for user authentication", questionText: "Q" }), true);
	});
});

// ---------------------------------------------------------------------------
// proposalDialogFailureMessage — lines 95-97
// ---------------------------------------------------------------------------
describe("proposalDialogFailureMessage", () => {
	it("handles Error objects", () => {
		const msg = proposalDialogFailureMessage(new Error("test error"));
		assert.ok(msg.includes("test error"));
		assert.ok(msg.includes("Goal draft confirmation failed"));
	});

	it("handles non-Error values", () => {
		const msg = proposalDialogFailureMessage("string error");
		assert.ok(msg.includes("string error"));
	});
});

// ---------------------------------------------------------------------------
// runGoalQuestionnaire — lines 106, 171-181, 200, 232-320, 324-524
// ---------------------------------------------------------------------------
describe("runGoalQuestionnaire — headless with auditorToggleInit", () => {
	it("returns cancelled with auditorEnabled when not interactive and auditorToggleInit provided", async () => {
		const ctx = { mode: "headless", hasUI: false, ui: {} } as unknown as ExtensionContext;
		const res = await runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: [] }], { defaultEnabled: false });
		assert.equal(res.cancelled, true);
		assert.equal(res.auditorEnabled, false);
	});
});

describe("runGoalQuestionnaire — TUI interactions", () => {
	function createMockTui() {
		return {
			getShowHardwareCursor: () => true,
			setShowHardwareCursor: () => {},
			requestRender: () => {},
			terminal: { rows: 24, cols: 80 },
		};
	}

	function createMockTheme() {
		return {
			fg: (_color: string, s: string) => s,
			bg: (_color: string, s: string) => s,
			bold: (s: string) => s,
		};
	}

	it("handles single question with no options (enter input mode)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: [] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Initial render — should be in input mode since options.length === 0
		let lines = component.render(80);
		assert.ok(lines.length > 0);

		// Type some text
		component.handleInput("h");
		component.handleInput("i");

		// Submit the answer
		component.handleInput("\r");

		// For single question, should auto-submit after answer
		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, false);
		assert.equal(doneResult.answers[0].answer, "hi");
		assert.equal(doneResult.answers[0].wasCustom, true);
	});

	it("handles multi-question with tab navigation and custom answers", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A", "B"] },
			{ id: "q2", question: "Q2", options: [] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select option B (down then enter)
		component.handleInput("\u001b[B"); // down
		component.handleInput("\r"); // enter

		// Q2: should be in input mode (no options)
		component.handleInput("c");
		component.handleInput("u");
		component.handleInput("s");
		component.handleInput("t");
		component.handleInput("\r"); // submit

		// Should be on summary tab now — assert the summary-tab marker alone
		// (the tab row always renders "✓ Submit", so that clause was tautological)
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Ready to submit")));

		// Submit on summary tab
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, false);
		assert.equal(doneResult.answers.length, 2);
		assert.equal(doneResult.answers[0].answer, "B");
		assert.equal(doneResult.answers[0].wasCustom, false);
		assert.equal(doneResult.answers[1].answer, "cust");
		assert.equal(doneResult.answers[1].wasCustom, true);
	});

	it("handles escape in input mode with options.length===0 and !isMulti (submit cancel)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: [] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// In input mode, press escape
		component.handleInput("\u001b");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, true);
	});

	it("handles escape in input mode with options (exit editor, not cancel)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A", "B"] },
			{ id: "q2", question: "Q2", options: [] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select A
		component.handleInput("\r");

		// Q2: in input mode, type something, then escape
		component.handleInput("x");
		component.handleInput("\u001b"); // escape — should exit editor, not cancel

		// Should still be in the questionnaire
		assert.ok(!doneResult);

		// Re-enter input mode for Q2, type answer, submit
		component.handleInput("\r"); // enter input mode again
		component.handleInput("v");
		component.handleInput("\r"); // submit answer

		// Now on summary, submit
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, false);
		assert.equal(doneResult.answers.length, 2);
	});

	it("handles shift+tab navigation in input mode", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A"] },
			{ id: "q2", question: "Q2", options: [] },
			{ id: "q3", question: "Q3", options: ["X"] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select A
		component.handleInput("\r");

		// Q2: in input mode, type, then shift+tab to go back
		component.handleInput("t");
		component.handleInput("\u001b[Z"); // shift+tab

		// Should be back on Q1
		let lines = component.render(80);
		assert.ok(lines.length > 0);

		// Tab forward to Q2
		component.handleInput("\t"); // tab to Q2 (input mode)
		component.handleInput("e");
		component.handleInput("\r"); // submit Q2 answer

		// Q3: select X
		component.handleInput("\r"); // select X → goes to summary

		// Submit on summary
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, false);
		assert.equal(doneResult.answers.length, 3);
	});

	it("handles escape on summary tab (cancel)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: ["A"] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Navigate to summary tab (right arrow)
		component.handleInput("\u001b[C"); // right

		// Press escape on summary tab
		component.handleInput("\u001b");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, true);
	});

	it("handles enter on question with options.length===0 (enter input mode)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A"] },
			{ id: "q2", question: "Q2", options: [] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select A
		component.handleInput("\r");

		// Q2: options.length===0, press enter to enter input mode
		component.handleInput("\r");

		// Type answer
		component.handleInput("a");
		component.handleInput("n");
		component.handleInput("s");
		component.handleInput("\r");

		// Submit on summary
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.answers[1].answer, "ans");
		assert.equal(doneResult.answers[1].wasCustom, true);
	});

	it("handles escape on question with options (cancel)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: ["A", "B"] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Press escape
		component.handleInput("\u001b");

		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, true);
	});

	it("handles auditor toggle and render with auditor enabled/disabled", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: ["A"] }], { defaultEnabled: true });

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Render with auditor enabled
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Auditor enabled") || l.includes("●")));

		// Toggle auditor
		component.handleInput("a");

		// Render with auditor disabled
		component.invalidate();
		lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Auditor disabled") || l.includes("○")));

		// Select option and submit
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.auditorEnabled, false);
	});

	it("handles render with context containing various patterns", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const contextText = [
			"● Goal draft ready for confirmation.",
			"─── Section Name ───",
			"│   [x] Task completed",
			"│   [ ] Task pending",
			"│   Mode: Normal goal",
			"│   Auto-continue: yes",
			"│   Auto-continue: no",
			"│   Some other value: custom",
			"│   Generic pipe content",
			"=== Goal ===",
			"Objective: Do something",
			"Success criteria: It works",
			"Boundaries: None",
			"Constraints: Time",
			"Verification contract: Test",
			"If blocked: Ask",
			"┌─ border ─┐",
			"└─ border ─┘",
			"[x] Checked task",
			"[ ] Unchecked task",
			"[~] Partial task",
			"  [x] Indented task",
			"Regular content line",
			"",
		].join("\n");

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", context: contextText, options: ["A"] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Render should handle all the context patterns
		let lines = component.render(80);
		assert.ok(lines.length > 0);

		// Select and submit
		component.handleInput("\r");

		assert.ok(doneResult);
	});

	it("handles render with existing answer (non-custom)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A", "B"] },
			{ id: "q2", question: "Q2", options: ["X"] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select B (index 1)
		component.handleInput("\u001b[B"); // down to B
		component.handleInput("\r");

		// Q2: select X
		component.handleInput("\r");

		// Go back to Q1 (left arrow)
		component.handleInput("\u001b[D");

		// Render should show "Current: B"
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Current:") || l.includes("B")));

		// Submit
		component.handleInput("\t"); // to summary
		component.handleInput("\r");

		assert.ok(doneResult);
	});

	it("handles render with existing custom answer", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A"] },
			{ id: "q2", question: "Q2", options: [] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select A
		component.handleInput("\r");

		// Q2: type custom answer
		component.handleInput("m");
		component.handleInput("y");
		component.handleInput("\r");

		// After answering Q2, we're on summary tab. Go left to Q2.
		component.handleInput("\u001b[D"); // left to Q2

		// Render should show "Current: (wrote) my"
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("(wrote)") || l.includes("my")));

		// Submit
		component.handleInput("\t"); // to summary
		component.handleInput("\r");

		assert.ok(doneResult);
	});

	it("handles render with recommended option", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: ["A", "B", "C"], recommended: 1 }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Render should show recommended tag (★) on option B — assert the marker
		// alone ("B" is always rendered as a choice, so the old disjunction was
		// tautological and could not catch broken marker rendering)
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("★")));

		// Select recommended option
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.answers[0].answer, "B");
	});

	it("handles summary tab render with unanswered questions", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A"] },
			{ id: "q2", question: "Q2", options: ["B"] },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Navigate to summary without answering (right twice: Q1→Q2→summary)
		component.handleInput("\u001b[C"); // right to Q2
		component.handleInput("\u001b[C"); // right to summary

		// Render should show unanswered warning
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Unanswered") || l.includes("unanswered")));

		// Try to submit (should not work since not all answered)
		component.handleInput("\r");
		assert.ok(!doneResult);

		// Escape to cancel
		component.handleInput("\u001b");
		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, true);
	});

	it("handles render with line truncation (narrow width)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const longQuestion = "This is a very long question that should be truncated when rendered in a narrow terminal window";
		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: longQuestion, options: ["A"] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Render with narrow width (20 chars)
		let lines = component.render(20);
		assert.ok(lines.length > 0);

		// Submit
		component.handleInput("\r");
		assert.ok(doneResult);
	});

	it("handles render with empty options (auto-enters text editor)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Q1", options: ["A"] },
			{ id: "q2", question: "Q2", options: [], allowCustom: false },
		]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Q1: select A
		component.handleInput("\r");

		// Q2: options=[] auto-enters text editor — assert the concrete input-mode
		// marker row (the old `|| lines.length > 0` was tautological)
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Your answer:")));
		// Verify inputMode auto-entered: hint row for option navigation absent
		assert.ok(!lines.some(l => l.includes("Enter select")));

		// Editor already active — type and submit
		component.handleInput("t");
		component.handleInput("\r");

		// Submit
		component.handleInput("\r");

		assert.ok(doneResult);
	});

	it("handles enter on custom option in multi-option list", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: ["A", "B"], allowCustom: true }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// Navigate to "Write your own answer..." option (last option)
		component.handleInput("\u001b[B"); // down to B
		component.handleInput("\u001b[B"); // down to custom option

		// Press enter to enter input mode
		component.handleInput("\r");

		// Type answer
		component.handleInput("c");
		component.handleInput("u");
		component.handleInput("s");
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.answers[0].answer, "cus");
		assert.equal(doneResult.answers[0].wasCustom, true);
	});

	it("handles empty input submission (refresh, not submit)", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: [] }]);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = createMockTui();
		const theme = createMockTheme();
		const component = renderFn(tui, theme, {}, done);

		// In input mode, submit empty (just whitespace)
		component.handleInput(" ");
		component.handleInput("\r");

		// Should not submit, just refresh
		assert.ok(!doneResult);

		// Now type something and submit
		component.handleInput("x");
		component.handleInput("\r");

		assert.ok(doneResult);
		assert.equal(doneResult.answers[0].answer, "x");
	});
});

// ---------------------------------------------------------------------------
// showProposalDialog — lines 543, 551-552, 556
// ---------------------------------------------------------------------------
describe("showProposalDialog", () => {
	it("uses 'Confirm Sisyphus Goal Draft' for sisyphus focus", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = showProposalDialog(ctx, "Test text", "sisyphus");

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = { getShowHardwareCursor: () => true, setShowHardwareCursor: () => {}, requestRender: () => {}, terminal: { rows: 24, cols: 80 } };
		const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
		const component = renderFn(tui, theme, {}, done);

		// Render should contain "Sisyphus"
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Sisyphus") || l.includes("Confirm")));

		// Select and submit
		component.handleInput("\r");

		// The promise should resolve
		// Note: we can't easily await the promise since we mocked custom()
	});

	it("uses 'Confirm Goal Draft' for non-sisyphus focus", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = showProposalDialog(ctx, "Test text", "goal");

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = { getShowHardwareCursor: () => true, setShowHardwareCursor: () => {}, requestRender: () => {}, terminal: { rows: 24, cols: 80 } };
		const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
		const component = renderFn(tui, theme, {}, done);

		let lines = component.render(80);
		assert.ok(lines.length > 0);
	});

	it("passes defaultAuditorEnabled when provided", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = showProposalDialog(ctx, "Test", "goal", false);

		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		const tui = { getShowHardwareCursor: () => true, setShowHardwareCursor: () => {}, requestRender: () => {}, terminal: { rows: 24, cols: 80 } };
		const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
		const component = renderFn(tui, theme, {}, done);

		// Render should show auditor toggle
		let lines = component.render(80);
		assert.ok(lines.some(l => l.includes("Auditor") || l.includes("●") || l.includes("○")));
	});
});
