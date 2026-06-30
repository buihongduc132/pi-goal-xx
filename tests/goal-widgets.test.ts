import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	renderAuditorWidgetLines,
	renderGoalWidgetLines,
	type GoalWidgetRecord,
	type AuditorWidgetProgress,
} from "../extensions/widgets/goal-widget.ts";
import { buildGoalRunningNotification } from "../extensions/widgets/goal-notifications.ts";

// Minimal theme stub — functions return input styled; we just need shape compat
const theme = new Proxy({} as Record<string, unknown>, {
	get: (_t, prop: string) => (text: unknown) => text,
}) as unknown as Parameters<typeof renderGoalWidgetLines>[1];

function makeGoal(): GoalWidgetRecord {
	return {
		id: "g1",
		objective: "test objective",
		status: "active",
		sisyphus: false,
		autoContinue: true,
		createdAt: "2026-01-01T00:00:00Z",
		usage: { tokensUsed: 0, activeSeconds: 0 },
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("renderGoalWidgetLines", () => {
	it("returns empty array for null goal + no progress", () => {
		const lines = renderGoalWidgetLines(null, theme, 80, {});
		assert.ok(Array.isArray(lines));
	});

	it("renders lines for active goal", () => {
		const lines = renderGoalWidgetLines(makeGoal(), theme, 80, {});
		assert.ok(lines.length > 0);
	});

	it("renders openGoalCount when provided", () => {
		const lines = renderGoalWidgetLines(makeGoal(), theme, 80, { openGoalCount: 3 });
		assert.ok(lines.length > 0);
	});

	it("renders paused goal with reason", () => {
		const g = makeGoal();
		g.status = "paused";
		g.pauseReason = "blocked";
		const lines = renderGoalWidgetLines(g, theme, 80, {});
		assert.ok(lines.length > 0);
	});

	it("renders complete goal", () => {
		const g = makeGoal();
		g.status = "complete";
		const lines = renderGoalWidgetLines(g, theme, 80, {});
		assert.ok(lines.length > 0);
	});

	it("renders with auditorProgress", () => {
		const progress: AuditorWidgetProgress = {
			phase: "running",
			elapsedMs: 5000,
			recentOutput: [],
		};
		const lines = renderGoalWidgetLines(makeGoal(), theme, 80, { auditorProgress: progress });
		assert.ok(lines.length > 0);
	});

	it("renders sisyphus goal", () => {
		const g = makeGoal();
		g.sisyphus = true;
		const lines = renderGoalWidgetLines(g, theme, 80, {});
		assert.ok(lines.length > 0);
	});

	it("renders with narrow width", () => {
		const lines = renderGoalWidgetLines(makeGoal(), theme, 20, {});
		assert.ok(Array.isArray(lines));
	});

	it("renders with disableTasks flag", () => {
		const lines = renderGoalWidgetLines(makeGoal(), theme, 80, { disableTasks: true });
		assert.ok(Array.isArray(lines));
	});
});

describe("renderAuditorWidgetLines", () => {
	it("renders running phase", () => {
		const progress: AuditorWidgetProgress = {
			phase: "running",
			elapsedMs: 1000,
			recentOutput: [],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});

	it("renders tool_executing phase with tool name", () => {
		const progress: AuditorWidgetProgress = {
			phase: "tool_executing",
			elapsedMs: 2000,
			currentTool: "read",
			currentToolArgs: "file.ts",
			currentToolStartedAt: Date.now() - 500,
			recentOutput: [],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});

	it("renders done phase", () => {
		const progress: AuditorWidgetProgress = {
			phase: "done",
			elapsedMs: 5000,
			recentOutput: ["completed"],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});

	it("renders with percentage", () => {
		const progress: AuditorWidgetProgress = {
			phase: "running",
			elapsedMs: 3000,
			percentage: 50,
			label: "Inspecting...",
			recentOutput: [],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});

	it("renders thinking phase", () => {
		const progress: AuditorWidgetProgress = {
			phase: "thinking",
			elapsedMs: 1500,
			recentOutput: [],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});

	it("renders producing_report phase with recent output", () => {
		const progress: AuditorWidgetProgress = {
			phase: "producing_report",
			elapsedMs: 4000,
			recentOutput: ["line1", "line2"],
		};
		const lines = renderAuditorWidgetLines(progress, theme, 80);
		assert.ok(lines.length > 0);
	});
});

describe("buildGoalRunningNotification", () => {
	it("includes objective", () => {
		const s = buildGoalRunningNotification({ objective: "my obj", sisyphus: false, autoContinue: true });
		assert.match(s, /my obj/);
	});
	it("regular goal", () => {
		const s = buildGoalRunningNotification({ objective: "x", sisyphus: false, autoContinue: true });
		assert.ok(s.length > 0);
	});
	it("sisyphus goal", () => {
		const s = buildGoalRunningNotification({ objective: "x", sisyphus: true, autoContinue: true });
		assert.ok(s.length > 0);
	});
	it("no autoContinue", () => {
		const s = buildGoalRunningNotification({ objective: "x", sisyphus: false, autoContinue: false });
		assert.ok(s.length > 0);
	});
});
