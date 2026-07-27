/**
 * goal-resolve-session-focus-no-autofocus — RED tests for resolveSessionFocus
 * auto-focus bug with 2+ goals.
 *
 * ROOT CAUSE: resolveSessionFocus in goal-pool.ts auto-focuses via focusEntry
 * even when 2+ goals exist. This happens at session_start via loadState.
 *
 * The previous fix (45b0831) removed the "Auto-focused" notification from
 * focusGoalCommand and chooseOpenGoal, but resolveSessionFocus still silently
 * auto-focuses when there's a focusEntry in the session branch.
 *
 * User requirement (verbatim): "2 goals, and it is AUTO focus; I am in TUI,
 * and even in NON-TUI, it MUST NOT auto focus like that, if so then how the
 * HELL can we selecting the GOAL?"
 *
 * REQUIRED BEHAVIOR:
 * - resolveSessionFocus with 2+ open goals: MUST return null (no auto-focus)
 * - resolveSessionFocus with 1 open goal: MAY auto-focus (no ambiguity)
 * - resolveSessionFocus with focusEntry + 2+ goals: MUST return null
 * - resolveSessionFocus with legacyGoal + 2+ goals: MUST return null
 *
 * These tests FAIL on current code (resolveSessionFocus still auto-focuses).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionFocus } from "../extensions/goal-pool.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(id: string, status: "active" | "paused" = "active"): GoalRecord {
	return {
		version: 3,
		id,
		status,
		autoContinue: true,
		sisyphus: false,
		objective: `Objective: ${id}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		usage: { tokensUsed: 0, activeSeconds: 0 },
		activePath: `.pi/goals/active_goal_${id}.md`,
	} as GoalRecord;
}

describe("RED — resolveSessionFocus must NOT auto-focus with 2+ goals", () => {
	it("BUG: focusEntry with 2+ open goals auto-focuses instead of returning null", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111"));
		pool.set("goal-bbbb-2222", makeGoal("goal-bbbb-2222"));

		const focusEntry = {
			version: 1,
			focusedGoalId: "goal-aaaa-1111",
			reason: "selected" as const,
		};

		const result = resolveSessionFocus({
			pool,
			focusEntry,
			autoFocusReason: "resume",
		});

		// MUST return null when 2+ goals exist, even with focusEntry
		assert.equal(result, null, `resolveSessionFocus must return null with 2+ goals, got ${result}`);
	});

	it("BUG: legacyGoal with 2+ open goals auto-focuses instead of returning null", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111"));
		pool.set("goal-bbbb-2222", makeGoal("goal-bbbb-2222"));

		const legacyGoal = makeGoal("goal-aaaa-1111");

		const result = resolveSessionFocus({
			pool,
			legacyGoal,
			autoFocusReason: "resume",
		});

		// MUST return null when 2+ goals exist, even with legacyGoal
		assert.equal(result, null, `resolveSessionFocus must return null with 2+ goals, got ${result}`);
	});

	it("BUG: focusEntry + legacyGoal with 2+ open goals auto-focuses", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111"));
		pool.set("goal-bbbb-2222", makeGoal("goal-bbbb-2222"));

		const focusEntry = {
			version: 1,
			focusedGoalId: "goal-aaaa-1111",
			reason: "selected" as const,
		};
		const legacyGoal = makeGoal("goal-aaaa-1111");

		const result = resolveSessionFocus({
			pool,
			focusEntry,
			legacyGoal,
			autoFocusReason: "resume",
		});

		// MUST return null when 2+ goals exist
		assert.equal(result, null, `resolveSessionFocus must return null with 2+ goals, got ${result}`);
	});

	it("BUG: autoFocusReason=resume with 2+ goals auto-focuses", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111"));
		pool.set("goal-bbbb-2222", makeGoal("goal-bbbb-2222"));

		const result = resolveSessionFocus({
			pool,
			autoFocusReason: "resume",
		});

		// MUST return null when 2+ goals exist, even with autoFocusReason=resume
		assert.equal(result, null, `resolveSessionFocus must return null with 2+ goals, got ${result}`);
	});

	it("BUG: autoFocusReason=startup with 2+ goals auto-focuses", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111"));
		pool.set("goal-bbbb-2222", makeGoal("goal-bbbb-2222"));

		const result = resolveSessionFocus({
			pool,
			autoFocusReason: "startup",
		});

		// MUST return null when 2+ goals exist
		assert.equal(result, null, `resolveSessionFocus must return null with 2+ goals, got ${result}`);
	});
});

describe("regression guard — resolveSessionFocus with 1 goal still works", () => {
	it("single goal: auto-focus is OK (no ambiguity)", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("solo-goal-eeee", makeGoal("solo-goal-eeee"));

		const result = resolveSessionFocus({
			pool,
			autoFocusReason: "resume",
		});

		// Single goal: auto-focus is OK
		assert.equal(result, "solo-goal-eeee", "single goal should auto-focus");
	});

	it("single goal with focusEntry: auto-focus is OK", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("solo-goal-eeee", makeGoal("solo-goal-eeee"));

		const focusEntry = {
			version: 1,
			focusedGoalId: "solo-goal-eeee",
			reason: "selected" as const,
		};

		const result = resolveSessionFocus({
			pool,
			focusEntry,
			autoFocusReason: "resume",
		});

		assert.equal(result, "solo-goal-eeee", "single goal with focusEntry should auto-focus");
	});

	it("empty pool: returns null (no goals to focus)", () => {
		const pool = new Map<string, GoalRecord>();

		const result = resolveSessionFocus({
			pool,
			autoFocusReason: "resume",
		});

		assert.equal(result, null, "empty pool should return null");
	});

	it("focusEntry pointing to completed goal: returns null", () => {
		const pool = new Map<string, GoalRecord>();
		pool.set("goal-aaaa-1111", makeGoal("goal-aaaa-1111", "complete"));

		const focusEntry = {
			version: 1,
			focusedGoalId: "goal-aaaa-1111",
			reason: "selected" as const,
		};

		const result = resolveSessionFocus({
			pool,
			focusEntry,
			autoFocusReason: "resume",
		});

		assert.equal(result, null, "completed goal should not be focused");
	});
});
