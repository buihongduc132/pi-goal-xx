/**
 * Shared test helpers for goal tests.
 */
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";

/**
 * Build a minimal valid GoalRecord, merged with the given overrides.
 * Uses a fixed timestamp seed so ids are stable across a test run.
 */
export function mkGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	const base = createGoal({ objective: "do stuff", autoContinue: false, sisyphus: false }, 1_700_000_000_000);
	return { ...base, ...over };
}
