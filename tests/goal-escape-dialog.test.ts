import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("showEscapeDialog", () => {
	it("returns 'continue_working' in headless mode", async () => {
		const ctx = {
			mode: "headless",
			hasUI: false,
			ui: {},
		} as unknown as ExtensionContext;
		const result = await showEscapeDialog(ctx, "test objective");
		assert.equal(result, "continue_working");
	});

	it("renders and handles input in interactive mode", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any, opts: any) => {
				renderFn = fn;
				return new Promise(() => {}); // Never resolves normally in this test sync
			},
		};

		const ctx = {
			mode: "interactive",
			hasUI: true,
			ui: mockUi,
		} as unknown as ExtensionContext;

		// Start it (it will block on custom)
		showEscapeDialog(ctx, "test objective");
		
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
			bold: (s: string) => s,
		};

		const component = renderFn(tui, theme, {}, done);
		
		// Cover render()
		const lines = component.render(80);
		assert.ok(lines.length > 0);
		
		// Cover handleInput
		component.handleInput("\u001b[B"); // down
		assert.equal(renderRequested, true);
		
		component.handleInput("\u001b[A"); // up
		
		component.handleInput("\u001b[B"); // down
		
		// Press Enter on the first option (index 0)
		component.handleInput("\r"); 
		assert.equal(doneResult, "complete_without_audit");
		
		// Press Escape
		component.handleInput("\u001b");
		assert.equal(doneResult, "continue_working");
		
		// Select first option
		component.handleInput("\u001b[A"); // up
		component.handleInput("\r");
		assert.equal(doneResult, "continue_working");
		
		if (component.dispose) component.dispose();
		if (component.invalidate) component.invalidate();
	});
});
