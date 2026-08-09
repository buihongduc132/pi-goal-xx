/**
 * Widget liveness display — tests for displayIcon with liveLockHolder signal.
 * RED PHASE: These tests define expected behavior for task 3 of goal-display-liveness.
 * They MUST FAIL until the implementation is added.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	renderGoalWidgetLines,
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

function mkWidgetGoal(over: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		id: "test-goal-abc",
		objective: "do the thing",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		...over,
	} as GoalWidgetRecord;
}

describe("goal-widget liveness display (task 3)", () => {
	describe("active+autoContinue goal with liveLockHolder signal", () => {
		it("liveLockHolder: true → shows running icon (●) and 'running' label", () => {
			const goal = mkWidgetGoal({ status: "active", autoContinue: true, liveLockHolder: true } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(joined.includes("●"), `expected ● icon in: ${joined}`);
			assert.ok(joined.includes("running"), `expected 'running' label in: ${joined}`);
		});

		it("liveLockHolder: false → shows stale icon (⌽) and 'stale' label", () => {
			const goal = mkWidgetGoal({ status: "active", autoContinue: true, liveLockHolder: false } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(joined.includes("⌽"), `expected ⌽ stale icon in: ${joined}`);
			assert.ok(joined.includes("stale"), `expected 'stale' label in: ${joined}`);
		});

		it("liveLockHolder: undefined → shows running icon (legacy fallback)", () => {
			const goal = mkWidgetGoal({ status: "active", autoContinue: true, liveLockHolder: undefined } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(joined.includes("●"), `expected ● icon (legacy) in: ${joined}`);
			assert.ok(joined.includes("running"), `expected 'running' label (legacy) in: ${joined}`);
		});

		it("liveLockHolder omitted → shows running icon (backward compat)", () => {
			const goal = mkWidgetGoal({ status: "active", autoContinue: true });
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(joined.includes("●"), `expected ● icon (backward compat) in: ${joined}`);
			assert.ok(joined.includes("running"), `expected 'running' label (backward compat) in: ${joined}`);
		});
	});

	describe("paused goal — lock signal is irrelevant", () => {
		it("paused + liveLockHolder: false → shows paused icon (not stale)", () => {
			const goal = mkWidgetGoal({ status: "paused", autoContinue: false, liveLockHolder: false } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			// Should show paused icon, NOT stale
			assert.ok(!joined.includes("stale"), `paused goal should not show 'stale': ${joined}`);
			assert.ok(joined.includes("paused"), `expected 'paused' in: ${joined}`);
		});

		it("paused·agent + liveLockHolder: false → shows paused icon (not stale)", () => {
			const goal = mkWidgetGoal({ status: "paused", stopReason: "agent", liveLockHolder: false } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(!joined.includes("stale"), `paused·agent should not show 'stale': ${joined}`);
		});
	});

	describe("complete goal — lock signal is irrelevant", () => {
		it("complete + liveLockHolder: false → shows complete icon (not stale)", () => {
			const goal = mkWidgetGoal({ status: "complete", autoContinue: false, liveLockHolder: false } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(!joined.includes("stale"), `complete goal should not show 'stale': ${joined}`);
		});
	});

	describe("sisyphus goal with liveness", () => {
		it("sisyphus + active + liveLockHolder: true → sisyphus running", () => {
			const goal = mkWidgetGoal({ sisyphus: true, status: "active", autoContinue: true, liveLockHolder: true } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			// Widget heading uses capitalized "Sisyphus"
			assert.ok(/sisyphus/i.test(joined), `expected 'sisyphus' (case-insensitive) in: ${joined}`);
			assert.ok(joined.includes("running"), `expected 'running' in: ${joined}`);
		});

		it("sisyphus + active + liveLockHolder: false → sisyphus stale", () => {
			const goal = mkWidgetGoal({ sisyphus: true, status: "active", autoContinue: true, liveLockHolder: false } as any);
			const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
			const joined = lines.join("\n");
			assert.ok(joined.includes("stale"), `expected 'stale' for sisyphus stale: ${joined}`);
		});
	});
});
