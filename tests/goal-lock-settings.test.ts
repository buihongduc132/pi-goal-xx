/**
 * RED tests for add-goal-focus-locking — Unit C: GoalSettings leaseMs/heartbeatMs
 * and session id generation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoalSettings, type GoalSettings } from "../extensions/goal-settings.ts";

describe("GoalSettings leaseMs / heartbeatMs defaults", () => {
	it("leaseMs defaults to 180000 (3 min)", () => {
		const settings = parseGoalSettings({});
		assert.equal((settings as GoalSettings & { leaseMs?: number }).leaseMs, 180_000);
	});

	it("heartbeatMs defaults to 60000 (60s)", () => {
		const settings = parseGoalSettings({});
		assert.equal((settings as GoalSettings & { heartbeatMs?: number }).heartbeatMs, 60_000);
	});

	it("custom values honored", () => {
		const settings = parseGoalSettings({ leaseMs: 30000, heartbeatMs: 10000 });
		assert.equal((settings as GoalSettings & { leaseMs?: number }).leaseMs, 30_000);
		assert.equal((settings as GoalSettings & { heartbeatMs?: number }).heartbeatMs, 10_000);
	});
});
