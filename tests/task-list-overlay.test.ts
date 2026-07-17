import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showTaskListOverlay } from "../extensions/widgets/task-list-overlay.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "../extensions/goal-record.ts";

describe("showTaskListOverlay", () => {
	it("returns early in headless mode", async () => {
		const ctx = {
			mode: "headless",
			hasUI: false,
			ui: {},
		} as unknown as ExtensionContext;
		const goalsById = new Map<string, GoalRecord>();
		await showTaskListOverlay(ctx, goalsById, "g1");
		assert.ok(true);
	});

	it("renders and handles input in interactive mode", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any, opts: any) => {
				renderFn = fn;
				return new Promise(() => {});
			},
		};

		const ctx = {
			mode: "interactive",
			hasUI: true,
			ui: mockUi,
		} as unknown as ExtensionContext;

		const goalsById = new Map<string, GoalRecord>();
		goalsById.set("g1", {
			id: "g1",
			objective: "Goal 1 with some tasks",
			status: "active",
			sisyphus: false,
			autoContinue: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: {
				tasks: [
					{ id: "t1", title: "Task 1", status: "complete", subtasks: [] },
					{ id: "t2", title: "Task 2 very long title ".repeat(10), status: "pending", subtasks: [
						{ id: "t2.1", title: "Subtask", status: "skipped", subtasks: [] }
					] },
				]
			}
		});
		goalsById.set("g2", {
			id: "g2",
			objective: "Goal 2",
			status: "paused",
			sisyphus: true,
			autoContinue: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: { tasks: [] }
		});

		showTaskListOverlay(ctx, goalsById, "g1");
		assert.ok(renderFn);

		let doneCalled = false;
		const done = () => { doneCalled = true; };
		
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
		
		// Initial render (only g1)
		let lines = component.render(80);
		assert.ok(lines.length > 0);
		
		// Scroll down
		component.handleInput("\u001b[B"); // down
		component.handleInput("j");
		assert.equal(renderRequested, true);
		
		// Scroll up
		component.handleInput("\u001b[A"); // up
		component.handleInput("k");
		
		// Page down / up
		component.handleInput("\u001b[6~"); // pagedown
		component.handleInput("\u001b[5~"); // pageup
		
		// Home / end
		component.handleInput("\u001b[H"); // home
		component.handleInput("\u001b[F"); // end
		
		// Toggle 'a' for all goals
		component.handleInput("a");
		lines = component.render(80); // Renders g1 and g2
		assert.ok(lines.length > 0);
		
		// Toggle 'a' again
		component.handleInput("a");
		
		// Press Escape
		component.handleInput("\u001b");
		assert.equal(doneCalled, true);
		
		if (component.dispose) component.dispose();
		if (component.invalidate) component.invalidate();
	});

	it("renders empty goals properly", async () => {
		let renderFn: any = null;
		const mockUi = {
			custom: (fn: any, opts: any) => { renderFn = fn; return new Promise(() => {}); },
		};
		const ctx = { mode: "interactive", hasUI: true, ui: mockUi } as unknown as ExtensionContext;
		const goalsById = new Map<string, GoalRecord>();
		
		showTaskListOverlay(ctx, goalsById, null);
		
		const component = renderFn(
			{ getShowHardwareCursor: () => true, setShowHardwareCursor: () => {}, requestRender: () => {} },
			{ fg: (_color: string, s: string) => s, bold: (s: string) => s },
			{},
			() => {}
		);
		const lines = component.render(80);
		assert.ok(lines.some(l => l.includes("No open goals to display.")));
	});
});
