import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseGoalSettings,
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	goalSettingsPath,
	isAuditorEnabledByDefault,
	type GoalSettings,
	type AuditorSubscription,
} from "../extensions/goal-settings.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("parseGoalSettings — basic keys", () => {
	it("returns empty for non-object input", () => {
		assert.deepEqual(parseGoalSettings(null), {});
		assert.deepEqual(parseGoalSettings(undefined), {});
		assert.deepEqual(parseGoalSettings([]), {});
		assert.deepEqual(parseGoalSettings("string"), {});
		assert.deepEqual(parseGoalSettings(42), {});
	});

	it("returns empty for empty object", () => {
		assert.deepEqual(parseGoalSettings({}), {});
	});

	it("parses booleans", () => {
		const s = parseGoalSettings({ disableTasks: true, disableContracts: false });
		assert.equal(s.disableTasks, true);
		assert.equal(s.disableContracts, false);
	});

	it("parses booleans from string form", () => {
		const s = parseGoalSettings({ disableTasks: "true", disableContracts: "false" });
		assert.equal(s.disableTasks, true);
		assert.equal(s.disableContracts, false);
	});

	it("parses subtaskDepth as int", () => {
		assert.equal(parseGoalSettings({ subtaskDepth: 5 }).subtaskDepth, 5);
		assert.equal(parseGoalSettings({ subtaskDepth: "3" }).subtaskDepth, 3);
		assert.equal(parseGoalSettings({ subtaskDepth: 0 }).subtaskDepth, undefined);
		assert.equal(parseGoalSettings({ subtaskDepth: -1 }).subtaskDepth, undefined);
		assert.equal(parseGoalSettings({ subtaskDepth: 1.5 }).subtaskDepth, undefined);
	});

	it("parses provider/model/thinkingLevel strings", () => {
		const s = parseGoalSettings({ provider: "openai", model: "gpt-4", thinkingLevel: "high" });
		assert.equal(s.provider, "openai");
		assert.equal(s.model, "gpt-4");
		assert.equal(s.thinkingLevel, "high");
	});

	it("accepts thinking_level snake_case alias", () => {
		assert.equal(parseGoalSettings({ thinking_level: "medium" }).thinkingLevel, "medium");
	});

	it("rejects invalid thinkingLevel", () => {
		assert.equal(parseGoalSettings({ thinkingLevel: "bogus" }).thinkingLevel, undefined);
	});

	it("parses disabled flag", () => {
		assert.equal(parseGoalSettings({ disabled: true }).disabled, true);
		assert.equal(parseGoalSettings({ disabled: "true" }).disabled, true);
		assert.equal(parseGoalSettings({ disabled: false }).disabled, undefined);
	});
});

describe("parseGoalSettings — additionalProperties:false", () => {
	it("throws on unknown key", () => {
		assert.throws(() => parseGoalSettings({ bogusKey: 1 }), /Unknown pi-goal-xx-settings/);
	});

	it("throws listing all unknown keys", () => {
		assert.throws(() => parseGoalSettings({ a: 1, b: 2 }), /a, b|b, a/);
	});

	it("accepts all known keys without throwing", () => {
		const s = parseGoalSettings({
			disableTasks: true,
			disableContracts: true,
			subtaskDepth: 2,
			provider: "p",
			model: "m",
			thinkingLevel: "low",
			thinking_level: "high", // alias — thinkingLevel takes precedence
			disabled: true,
			disabledTools: ["a"],
			auditorSubscriptions: [{ event: "pause", mode: "async" }],
		});
		assert.equal(s.disableTasks, true);
		assert.equal(s.thinkingLevel, "low");
		assert.deepEqual(s.disabledTools, ["a"]);
	});
});

describe("parseGoalSettings — disabledTools (NEW FEATURE)", () => {
	it("parses string array", () => {
		const s = parseGoalSettings({ disabledTools: ["goal_question", "pause_goal"] });
		assert.deepEqual(s.disabledTools, ["goal_question", "pause_goal"]);
	});

	it("parses comma-separated string", () => {
		const s = parseGoalSettings({ disabledTools: "goal_question, pause_goal" });
		assert.deepEqual(s.disabledTools, ["goal_question", "pause_goal"]);
	});

	it("parses whitespace-separated string", () => {
		const s = parseGoalSettings({ disabledTools: "a b c" });
		assert.deepEqual(s.disabledTools, ["a", "b", "c"]);
	});

	it("drops empty strings from array", () => {
		const s = parseGoalSettings({ disabledTools: ["a", "", "  ", "b"] });
		assert.deepEqual(s.disabledTools, ["a", "b"]);
	});

	it("returns undefined for empty array", () => {
		assert.equal(parseGoalSettings({ disabledTools: [] }).disabledTools, undefined);
	});

	it("returns undefined for empty string", () => {
		assert.equal(parseGoalSettings({ disabledTools: "" }).disabledTools, undefined);
	});

	it("returns undefined for non-array non-string", () => {
		assert.equal(parseGoalSettings({ disabledTools: 42 }).disabledTools, undefined);
		assert.equal(parseGoalSettings({ disabledTools: { a: 1 } }).disabledTools, undefined);
	});

	it("allows arbitrary tool names (no validation)", () => {
		const s = parseGoalSettings({ disabledTools: ["any_random_string", "complete_goal"] });
		assert.deepEqual(s.disabledTools, ["any_random_string", "complete_goal"]);
	});
});

describe("parseGoalSettings — auditorSubscriptions (NEW FEATURE)", () => {
	it("parses valid subscription list", () => {
		const s = parseGoalSettings({
			auditorSubscriptions: [
				{ event: "pause", mode: "async" },
				{ event: "abort", mode: "async" },
			],
		});
		assert.deepEqual(s.auditorSubscriptions, [
			{ event: "pause", mode: "async" },
			{ event: "abort", mode: "async" },
		]);
	});

	it("allows arbitrary event strings", () => {
		const s = parseGoalSettings({
			auditorSubscriptions: [{ event: "any_custom_event", mode: "async" }],
		});
		assert.deepEqual(s.auditorSubscriptions, [{ event: "any_custom_event", mode: "async" }]);
	});

	it("drops entries with empty event", () => {
		const s = parseGoalSettings({
			auditorSubscriptions: [
				{ event: "", mode: "async" },
				{ event: "valid", mode: "async" },
			],
		});
		assert.deepEqual(s.auditorSubscriptions, [{ event: "valid", mode: "async" }]);
	});

	it("drops entries with mode != async", () => {
		const s = parseGoalSettings({
			auditorSubscriptions: [
				{ event: "sync_event", mode: "sync" },
				{ event: "valid", mode: "async" },
			],
		});
		assert.deepEqual(s.auditorSubscriptions, [{ event: "valid", mode: "async" }]);
	});

	it("drops non-object entries", () => {
		const s = parseGoalSettings({
			auditorSubscriptions: ["string", 42, null, { event: "valid", mode: "async" }],
		});
		assert.deepEqual(s.auditorSubscriptions, [{ event: "valid", mode: "async" }]);
	});

	it("returns undefined for empty result", () => {
		assert.equal(parseGoalSettings({ auditorSubscriptions: [] }).auditorSubscriptions, undefined);
	});

	it("returns undefined for non-array", () => {
		assert.equal(parseGoalSettings({ auditorSubscriptions: "pause" }).auditorSubscriptions, undefined);
	});
});

describe("goalSettingsPath", () => {
	it("defaults to .pi/pi-goal-xx-settings.json", () => {
		const p = goalSettingsPath("/cwd", {});
		assert.equal(p, path.join("/cwd", ".pi", "pi-goal-xx-settings.json"));
	});

	it("uses PI_GOAL_SETTINGS_FILE env override (relative)", () => {
		const p = goalSettingsPath("/cwd", { PI_GOAL_SETTINGS_FILE: "custom.json" });
		assert.equal(p, path.join("/cwd", "custom.json"));
	});

	it("uses PI_GOAL_SETTINGS_FILE env override (absolute)", () => {
		const p = goalSettingsPath("/cwd", { PI_GOAL_SETTINGS_FILE: "/abs/custom.json" });
		assert.equal(p, "/abs/custom.json");
	});

	it("ignores empty env override", () => {
		const p = goalSettingsPath("/cwd", { PI_GOAL_SETTINGS_FILE: "" });
		assert.equal(p, path.join("/cwd", ".pi", "pi-goal-xx-settings.json"));
	});
});

describe("loadGoalSettingsFileConfig", () => {
	it("returns {} when file missing", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		assert.deepEqual(loadGoalSettingsFileConfig(tmp, {}), {});
	});

	it("returns {} for malformed JSON", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "{ not json");
		assert.deepEqual(loadGoalSettingsFileConfig(tmp, {}), {});
	});

	it("loads valid file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ disableTasks: true, disabledTools: ["x"] }),
		);
		const s = loadGoalSettingsFileConfig(tmp, {});
		assert.equal(s.disableTasks, true);
		assert.deepEqual(s.disabledTools, ["x"]);
	});
});

describe("loadGoalSettings — env overrides", () => {
	it("PI_GOAL_DISABLE_TASKS overrides file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ disableTasks: false }),
		);
		const s = loadGoalSettings(tmp, { PI_GOAL_DISABLE_TASKS: "true" });
		assert.equal(s.disableTasks, true);
	});

	it("PI_GOAL_DISABLE_CONTRACTS overrides file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		const s = loadGoalSettings(tmp, { PI_GOAL_DISABLE_CONTRACTS: "true" });
		assert.equal(s.disableContracts, true);
	});

	it("PI_GOAL_DISABLED_TOOLS provides disabledTools (NEW)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		const s = loadGoalSettings(tmp, { PI_GOAL_DISABLED_TOOLS: "a,b,c" });
		assert.deepEqual(s.disabledTools, ["a", "b", "c"]);
	});

	it("defaults subtaskDepth to 1", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		const s = loadGoalSettings(tmp, {});
		assert.equal(s.subtaskDepth, 1);
	});
});

describe("saveGoalSettingsFileConfig", () => {
	it("persists non-default values", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		const clean = saveGoalSettingsFileConfig(tmp, {
			provider: "p",
			model: "m",
			disableTasks: true,
			disabledTools: ["x", "y"],
			auditorSubscriptions: [{ event: "pause", mode: "async" }],
		});
		assert.equal(clean.provider, "p");
		assert.deepEqual(clean.disabledTools, ["x", "y"]);
		const raw = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"));
		assert.deepEqual(raw.disabledTools, ["x", "y"]);
		assert.deepEqual(raw.auditorSubscriptions, [{ event: "pause", mode: "async" }]);
	});

	it("round-trips via load", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-"));
		const original: GoalSettings = {
			disableContracts: true,
			subtaskDepth: 3,
			disabledTools: ["a"],
			auditorSubscriptions: [{ event: "e", mode: "async" } as AuditorSubscription],
		};
		saveGoalSettingsFileConfig(tmp, original);
		const loaded = loadGoalSettingsFileConfig(tmp, {});
		assert.equal(loaded.disableContracts, true);
		assert.equal(loaded.subtaskDepth, 3);
		assert.deepEqual(loaded.disabledTools, ["a"]);
		assert.deepEqual(loaded.auditorSubscriptions, [{ event: "e", mode: "async" }]);
	});
});

describe("isAuditorEnabledByDefault", () => {
	it("true when disabled undefined", () => {
		assert.equal(isAuditorEnabledByDefault({}), true);
	});
	it("false when disabled true", () => {
		assert.equal(isAuditorEnabledByDefault({ disabled: true }), false);
	});
});
