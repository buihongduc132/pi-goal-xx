/**
 * Shared test helpers for goal tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";

/**
 * Singleton empty temp dir for PI_CODING_AGENT_DIR isolation.
 * Makes globalGoalSettingsPath resolve to an absent file → no global merge.
 * Memoized at module level; OS tmp reaped on reboot.
 */
const _isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-test-isolated-"));

/**
 * Return an env object that isolates settings loading from the real ~/.pi config.
 * Use this when tests assert defaults/empty/undefined for settings fields.
 */
export function isolatedSettingsEnv(): Record<string, string> {
	return { PI_CODING_AGENT_DIR: _isolatedAgentDir };
}

/**
 * Build a minimal valid GoalRecord, merged with the given overrides.
 * Uses a fixed timestamp seed so ids are stable across a test run.
 */
export function mkGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	const base = createGoal({ objective: "do stuff", autoContinue: false, sisyphus: false }, 1_700_000_000_000);
	return { ...base, ...over };
}
