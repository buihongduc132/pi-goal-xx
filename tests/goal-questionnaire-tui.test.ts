import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGoalQuestionnaire, showProposalDialog } from "../extensions/goal-questionnaire.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("runGoalQuestionnaire TUI", () => {
	it("returns gracefully in headless mode", async () => {
		const ctx = { mode: "headless", hasUI: false, ui: {} } as unknown as ExtensionContext;
		const res = await runGoalQuestionnaire(ctx, [{ id: "q1", question: "Q1", options: [] }]);
		assert.equal(res.cancelled, true);
	});

	it("renders and handles input in interactive mode", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any, opts: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = runGoalQuestionnaire(ctx, [
			{ id: "q1", question: "Question 1", options: ["Opt 1", "Opt 2"] },
			{ id: "q2", question: "Question 2", options: ["Opt A", "Opt B"], allowCustom: false }
		], { defaultEnabled: true });

		assert.ok(renderFn);
		
		let doneResult: any = null;
		const done = (res: any) => { doneResult = res; };
		
		let renderRequested = false;
		const tui = {
			getShowHardwareCursor: () => true,
			setShowHardwareCursor: () => {},
			requestRender: () => { renderRequested = true; }
		};
		const theme = {
			fg: (_color: string, s: string) => s,
			bg: (_color: string, s: string) => s,
			bold: (s: string) => s,
		};

		const component = renderFn(tui, theme, {}, done);
		
		// Initial render
		let lines = component.render(80);
		assert.ok(lines.length > 0);
		
		// Navigate options
		component.handleInput("\u001b[B"); // down
		component.handleInput("\u001b[A"); // up
		
		// Toggle auditor
		component.handleInput("a");
		
		// Navigate tabs to test tab key bindings
		component.handleInput("\u001b[C"); // right -> tab is now 1 (q2)
		component.handleInput("\t"); // tab -> tab is now 2 (summary)
		component.handleInput("\u001b[Z"); // shift+tab -> tab is now 1 (q2)
		component.handleInput("\u001b[D"); // left -> tab is now 0 (q1)
		
		// Enter on q1 to select option 1
		component.handleInput("\r");
		
		// Now on q2. Select option A
		component.handleInput("\r");
		
		// Submit on summary tab
		component.handleInput("\r");
		
		assert.ok(doneResult);
		assert.equal(doneResult.cancelled, false);
	});
	
	it("showProposalDialog handles interactive input", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any, opts: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const promise = showProposalDialog(ctx, "Test draft text\n─── Section ───\n│   [x] Task 1\n=== Goal ===\n┌─ border", "goal");
		
		const done = (res: any) => { };
		const tui = { getShowHardwareCursor: () => true, setShowHardwareCursor: () => {}, requestRender: () => {} };
		const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s };

		const component = renderFn(tui, theme, {}, done);
		component.render(80);
		
		// Down then enter
		component.handleInput("\u001b[B"); // down
		component.handleInput("\r"); // enter
	});
});
