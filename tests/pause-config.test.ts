import assert from "node:assert";
import { describe, it } from "node:test";
import {
	parseGoalSettings,
	loadGoalSettings,
	resolvePauseConfigFromEnv,
	PI_GOAL_PAUSE_ESCAPE_ENV,
	PI_GOAL_PAUSE_COMMAND_ENV,
	PI_GOAL_PAUSE_ABORT_ENV,
	type PauseConfig,
} from "../extensions/goal-settings.ts";

describe("pause config", () => {
	describe("parseGoalSettings", () => {
		it("accepts pauseConfig with escape/command/abort", () => {
			const s = parseGoalSettings({
				pauseConfig: { escape: false, command: true, abort: false },
			});
			assert.deepStrictEqual(s.pauseConfig, { escape: false, command: true, abort: false });
		});

		it("rejects unknown pauseConfig keys", () => {
			assert.throws(() => parseGoalSettings({ pauseConfig: { unknown: true } as Record<string, unknown> }), /Unknown pauseConfig key/);
		});

		it("returns undefined pauseConfig when absent", () => {
			const s = parseGoalSettings({});
			assert.strictEqual(s.pauseConfig, undefined);
		});
	});

	describe("resolvePauseConfigFromEnv", () => {
		it("defaults to escape=true, command=true, abort=false", () => {
			const cfg = resolvePauseConfigFromEnv({});
			assert.deepStrictEqual(cfg, { escape: true, command: true, abort: false });
		});

		it("env overrides file config", () => {
			const env: NodeJS.ProcessEnv = {
				[PI_GOAL_PAUSE_ESCAPE_ENV]: "false",
				[PI_GOAL_PAUSE_COMMAND_ENV]: "0",
				[PI_GOAL_PAUSE_ABORT_ENV]: "true",
			};
			const file: PauseConfig = { escape: true, command: true, abort: false };
			const cfg = resolvePauseConfigFromEnv(env, file);
			assert.deepStrictEqual(cfg, { escape: false, command: false, abort: true });
		});

		it("file config used when env unset", () => {
			const file: PauseConfig = { escape: false, command: true, abort: true };
			const cfg = resolvePauseConfigFromEnv({}, file);
			assert.deepStrictEqual(cfg, { escape: false, command: true, abort: true });
		});
	});

	describe("loadGoalSettings pauseConfig", () => {
		it("loads pauseConfig from file", () => {
			const fixturePath = `${process.cwd()}/tests/fixtures/pause-config-escape-off.json`;
			const s = loadGoalSettings("/dev/null/should-not-exist", {
				PI_GOAL_SETTINGS_FILE: fixturePath,
			});
			assert.deepStrictEqual(s.pauseConfig, { escape: false, command: true, abort: false });
		});
	});
});
