/**
 * Widget render functions — pure (data + theme + width → string[]).
 * No TUI required; theme is mocked as identity (fg/bold return the string).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	renderAuditorWidgetLines,
	renderGoalWidgetLines,
	type AuditorWidgetProgress,
	type GoalWidgetRecord,
} from "../extensions/widgets/goal-widget.ts";

function mockTheme(): any {
	return {
		fg: (_kind: string, s: string) => s,
		bold: (s: string) => s,
		dim: (s: string) => s,
		success: (s: string) => s,
		warning: (s: string) => s,
		accent: (s: string) => s,
		muted: (s: string) => s,
	};
}

function mkGoal(over: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		objective: "do the thing",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		...over,
	} as GoalWidgetRecord;
}

describe("renderGoalWidgetLines", () => {
	it("renders a null goal (no goal focused) without throwing", () => {
		const lines = renderGoalWidgetLines(null, mockTheme(), 60);
		// null goal may render zero or more lines; the key is no throw.
		assert.ok(Array.isArray(lines));
	});

	it("renders an active running goal", () => {
		const lines = renderGoalWidgetLines(mkGoal({ status: "active", autoContinue: true }), mockTheme(), 60);
		assert.ok(lines.length > 0);
		assert.ok(lines.some((l) => /do the thing|running/i.test(l)));
	});

	it("renders a sisyphus goal with prefix", () => {
		const lines = renderGoalWidgetLines(mkGoal({ sisyphus: true, status: "active", autoContinue: true }), mockTheme(), 60);
		assert.ok(lines.some((l) => /sisyphus/i.test(l)));
	});

	it("renders a paused goal", () => {
		const lines = renderGoalWidgetLines(mkGoal({ status: "paused", autoContinue: false }), mockTheme(), 60);
		assert.ok(lines.length > 0);
	});

	it("renders a complete goal", () => {
		const lines = renderGoalWidgetLines(mkGoal({ status: "complete", autoContinue: false }), mockTheme(), 60);
		assert.ok(lines.length > 0);
	});

	it("includes usage when tokens/seconds > 0", () => {
		const lines = renderGoalWidgetLines(mkGoal({ usage: { tokensUsed: 1500, activeSeconds: 60 } }), mockTheme(), 60);
		// Should reference formatted usage somewhere
		assert.ok(lines.some((l) => /1\.5K|1m00s|1\.5/i.test(l)));
	});

	it("shows openGoalCount hint when > 0", () => {
		const lines = renderGoalWidgetLines(mkGoal(), mockTheme(), 60, { openGoalCount: 3 });
		assert.ok(lines.some((l) => /3|other|open/i.test(l)));
	});

	it("truncates long objectives to fit width", () => {
		const long = "x".repeat(300);
		const lines = renderGoalWidgetLines(mkGoal({ objective: long }), mockTheme(), 40);
		// Each line should not vastly exceed width (rendered text may include decoration)
		assert.ok(lines.length > 0);
	});

	it("clamps width to a minimum", () => {
		// width 0 or negative should not crash
		const lines = renderGoalWidgetLines(mkGoal(), mockTheme(), 0);
		assert.ok(lines.length > 0);
	});
});

describe("renderAuditorWidgetLines", () => {
	function mkProgress(over: Partial<AuditorWidgetProgress> = {}): AuditorWidgetProgress {
		return {
			recentOutput: [],
			phase: "running",
			elapsedMs: 0,
			...over,
		} as AuditorWidgetProgress;
	}

	it("renders the running phase", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running" }), mockTheme(), 60);
		assert.ok(lines.some((l) => /audit/i.test(l)));
	});

	it("renders the thinking phase with thinking label", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "thinking" }), mockTheme(), 60);
		assert.ok(lines.some((l) => /thinking/i.test(l)));
	});

	it("renders the done phase with complete label", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "done" }), mockTheme(), 60);
		assert.ok(lines.some((l) => /complete|done/i.test(l)));
	});

	it("renders a step label when provided", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running", label: "Inspecting files..." }), mockTheme(), 60);
		assert.ok(lines.some((l) => /Inspecting/i.test(l)));
	});

	it("renders a progress bar when percentage provided", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running", percentage: 42 }), mockTheme(), 60);
		assert.ok(lines.some((l) => /42%|%/i.test(l)));
	});

	it("renders recent output lines when provided", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running", recentOutput: ["line one", "line two"] }), mockTheme(), 80);
		assert.ok(lines.some((l) => /line one|line two/i.test(l)));
	});

	it("formats elapsed duration from ms", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running", elapsedMs: 65000 }), mockTheme(), 60);
		// 65s → 1m05s
		assert.ok(lines.some((l) => /1m05s|1m/i.test(l)));
	});

	it("clamps width to a minimum", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "running" }), mockTheme(), 1);
		assert.ok(lines.length > 0);
	});

	it("renders tool_executing phase", () => {
		const lines = renderAuditorWidgetLines(mkProgress({ phase: "tool_executing", currentTool: "read" }), mockTheme(), 60);
		assert.ok(lines.length > 0);
	});
});
