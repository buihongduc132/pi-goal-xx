/**
 * RED tests for goal-active-env settings + focus integration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	loadGoalSettings,
	parseGoalSettings,
} from "../extensions/goal-settings.ts";
import { DEFAULT_ACTIVE_ENV_NAME, DEFAULT_ACTIVE_ENV_TEMPLATE } from "../extensions/goal-env-runtime.ts";

function tempCwd(): { cwd: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-settings-"));
	return {
		cwd,
		cleanup: () => {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("parseGoalSettings: goalActiveEnvName + goalActiveEnvTemplate parse from JSON", () => {
	const got = parseGoalSettings({
		goalActiveEnvName: "MY_GOAL_ACTIVE",
		goalActiveEnvTemplate: "{repo}::{goalId}",
	});
	assert.equal(got.goalActiveEnvName, "MY_GOAL_ACTIVE");
	assert.equal(got.goalActiveEnvTemplate, "{repo}::{goalId}");
});

test("parseGoalSettings: unknown key 'goalActiveEnvBogus' rejected", () => {
	assert.throws(
		() => parseGoalSettings({ goalActiveEnvBogus: "x" }),
		/Unknown pi-goal-xx-settings\.json key/,
	);
});

test("loadGoalSettings: defaults resolve to PI_GOAL_XX_ACTIVE + {repo}-{branch}-{goalId}", () => {
	const { cwd, cleanup } = tempCwd();
	try {
		const s = loadGoalSettings(cwd, {});
		assert.equal(s.goalActiveEnvName, DEFAULT_ACTIVE_ENV_NAME);
		assert.equal(s.goalActiveEnvTemplate, DEFAULT_ACTIVE_ENV_TEMPLATE);
	} finally {
		cleanup();
	}
});

test("loadGoalSettings: env override PI_GOAL_ACTIVE_ENV_NAME", () => {
	const { cwd, cleanup } = tempCwd();
	try {
		const s = loadGoalSettings(cwd, { PI_GOAL_ACTIVE_ENV_NAME: "FOO_BAR" });
		assert.equal(s.goalActiveEnvName, "FOO_BAR");
	} finally {
		cleanup();
	}
});

test("loadGoalSettings: env override PI_GOAL_ACTIVE_ENV_TEMPLATE", () => {
	const { cwd, cleanup } = tempCwd();
	try {
		const s = loadGoalSettings(cwd, { PI_GOAL_ACTIVE_ENV_TEMPLATE: "X-{goalId}" });
		assert.equal(s.goalActiveEnvTemplate, "X-{goalId}");
	} finally {
		cleanup();
	}
});

test("loadGoalSettings: file config for env name + template", () => {
	const { cwd, cleanup } = tempCwd();
	try {
		const cfgPath = path.join(cwd, ".pi", "pi-goal-xx-settings.json");
		fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				goalActiveEnvName: "FILE_NAME",
				goalActiveEnvTemplate: "FILE-{goalId}",
			}),
		);
		const s = loadGoalSettings(cwd, {});
		assert.equal(s.goalActiveEnvName, "FILE_NAME");
		assert.equal(s.goalActiveEnvTemplate, "FILE-{goalId}");
	} finally {
		cleanup();
	}
});
