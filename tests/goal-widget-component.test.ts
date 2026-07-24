import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalWidgetComponent } from "../extensions/widgets/goal-widget.ts";

describe("GoalWidgetComponent", () => {
	const mockTui: any = {
		requestRender: () => {},
	};
	const mockTheme: any = {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
	};

	it("renders without a goal", () => {
		const comp = new GoalWidgetComponent({
			theme: mockTheme,
			tui: mockTui,
			getGoal: () => null,
			getOpenGoalCount: () => 1,
		});
		
		comp.update();
		comp.invalidate();
		const lines = comp.render(80);
		assert.ok(lines.length > 0);
	});

	it("renders with a goal and debug mode", () => {
		const comp = new GoalWidgetComponent({
			theme: mockTheme,
			tui: mockTui,
			getGoal: () => ({
				id: "g1",
				objective: "test objective",
				status: "active",
				sisyphus: false,
				autoContinue: true,
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				usage: { tokensUsed: 10, activeSeconds: 20 },
				pauseReason: "stuck",
				pauseSuggestedAction: "help",
				stopReason: "agent",
				activePath: ".pi/g1",
				archivedPath: ".pi/archive",
				verificationContract: "must work",
				taskList: {
					tasks: [
						{ id: "t1", title: "task 1", status: "complete", subtasks: [] },
						{ id: "t2", title: "task 2", status: "pending", subtasks: [] }
					]
				}
			}),
			getOpenGoalCount: () => 1,
			getDebugMode: () => true,
		});

		const lines = comp.render(80);
		assert.ok(lines.length > 0);
		assert.ok(lines.some(l => l.includes("[DEBUG MODE]")));
		assert.ok(lines.some(l => l.includes("g1")));
	});
	
	it("renders with no goal in debug mode", () => {
		const comp = new GoalWidgetComponent({
			theme: mockTheme,
			tui: mockTui,
			getGoal: () => null,
			getOpenGoalCount: () => 0,
			getDebugMode: () => true,
		});
		const lines = comp.render(80);
		assert.ok(lines.some(l => l.includes("(no goal)")));
	});

	it("renders a paused goal with stopReason=agent", () => {
		const comp = new GoalWidgetComponent({
			theme: mockTheme,
			tui: mockTui,
			getGoal: () => ({
				id: "g2",
				objective: "paused objective",
				status: "paused",
				sisyphus: false,
				autoContinue: true,
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				usage: { tokensUsed: 0, activeSeconds: 0 },
				pauseReason: "I got stuck",
				pauseSuggestedAction: "Please help",
				stopReason: "agent"
			}),
			getOpenGoalCount: () => 1,
		});
		const lines = comp.render(80);
		assert.ok(lines.some(l => l.includes("blocker")));
		assert.ok(lines.some(l => l.includes("I got stuck")));
	});
});
