/**
 * RED PHASE — toolInstructions settings schema (tasks 1.7).
 *
 * Spec: openspec/changes/add-prompt-tool-instruction-config/specs/prompt-config-resolution/spec.md
 * Design: openspec/changes/add-prompt-tool-instruction-config/design.md (D1)
 *
 * Contract under test (GREEN implements):
 *  - New top-level `toolInstructions?: Record<string, PromptConfig>` in GoalSettings.
 *  - Added to ALLOWED_SETTINGS_KEYS.
 *  - Validated via asToolInstructionsBlock (each entry via asPromptConfig).
 *  - Unknown nested keys rejected. Invalid mode rejected.
 *  - Empty object {} → toolInstructions is undefined (no-op).
 *  - Round-trip: save → load → identical (scenario S5).
 *  - Any non-empty string key accepted (no tool-name allowlist).
 *
 * Today these FAIL: toolInstructions is not in ALLOWED_SETTINGS_KEYS, so
 * parseGoalSettings throws "Unknown key" for it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseGoalSettings,
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	type GoalSettings,
} from "../extensions/goal-settings.ts";
import { isolatedSettingsEnv } from "./_test-helpers.ts";

// ---------------------------------------------------------------------------
// 1. parseGoalSettings — toolInstructions block
// ---------------------------------------------------------------------------

describe("parseGoalSettings — toolInstructions block", () => {
	it("parses valid toolInstructions with inline + mode", () => {
		const s = parseGoalSettings({
			toolInstructions: {
				pause_goal: { mode: "local", inline: "Use intercom instead." },
			},
		});
		assert.ok(s.toolInstructions, "toolInstructions should be present");
		assert.equal(s.toolInstructions!.pause_goal?.mode, "local");
		assert.equal(s.toolInstructions!.pause_goal?.inline, "Use intercom instead.");
	});

	it("rejects invalid mode in toolInstructions entry", () => {
		// GREEN error mentions the invalid MODE specifically; the RED "Unknown key"
		// error must NOT satisfy this (no "mode" in the top-level key rejection).
		assert.throws(
			() => parseGoalSettings({
				toolInstructions: {
					pause_goal: { mode: "invalid_mode" },
				},
			}),
			/Invalid.*mode/i,
		);
	});

	it("rejects unknown nested key in toolInstructions entry", () => {
		// GREEN error mentions a NESTED key; the RED "Unknown key" rejection is a
		// top-level key error and must NOT satisfy this (no "nested" in it).
		assert.throws(
			() => parseGoalSettings({
				toolInstructions: {
					pause_goal: { mode: "local", bogus: "x" },
				},
			}),
			/nested/i,
		);
	});

	it("empty object {} → toolInstructions is undefined (no-op)", () => {
		const s = parseGoalSettings({ toolInstructions: {} });
		assert.equal(s.toolInstructions, undefined);
	});

	it("accepts unknown tool name (no allowlist — future-proof)", () => {
		const s = parseGoalSettings({
			toolInstructions: {
				future_tool: { inline: "some replacement" },
			},
		});
		assert.ok(s.toolInstructions, "toolInstructions should be present");
		assert.equal(s.toolInstructions!.future_tool?.inline, "some replacement");
	});

	it("parses multiple tool entries", () => {
		const s = parseGoalSettings({
			toolInstructions: {
				pause_goal: { mode: "local" },
				abort_goal: { inline: "Use intercom." },
				complete_goal: { mode: "global-local" },
			},
		});
		assert.ok(s.toolInstructions);
		assert.equal(s.toolInstructions!.pause_goal?.mode, "local");
		assert.equal(s.toolInstructions!.abort_goal?.inline, "Use intercom.");
		assert.equal(s.toolInstructions!.complete_goal?.mode, "global-local");
	});
});

// ---------------------------------------------------------------------------
// 2. loadGoalSettings — toolInstructions pass-through
// ---------------------------------------------------------------------------

describe("loadGoalSettings — toolInstructions pass-through", () => {
	it("loads toolInstructions from file config", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ti-"));
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({
				toolInstructions: {
					pause_goal: { mode: "local" },
				},
			}),
		);
		const s = loadGoalSettingsFileConfig(tmp, isolatedSettingsEnv());
		assert.ok(s.toolInstructions);
		assert.equal(s.toolInstructions!.pause_goal?.mode, "local");
	});

	it("loadGoalSettings passes through toolInstructions", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ti2-"));
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({
				toolInstructions: {
					abort_goal: { inline: "Call intercom." },
				},
			}),
		);
		const s = loadGoalSettings(tmp, isolatedSettingsEnv());
		assert.ok(s.toolInstructions);
		assert.equal(s.toolInstructions!.abort_goal?.inline, "Call intercom.");
	});
});

// ---------------------------------------------------------------------------
// 3. saveGoalSettingsFileConfig — round-trip (scenario S5)
// ---------------------------------------------------------------------------

describe("saveGoalSettingsFileConfig — toolInstructions round-trip (S5)", () => {
	it("round-trips toolInstructions through save → load", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ti3-"));
		const original: GoalSettings = {
			toolInstructions: {
				pause_goal: { mode: "local" },
				goal_question: { inline: "Use intercom." },
			},
		};
		saveGoalSettingsFileConfig(tmp, original);
		const loaded = loadGoalSettingsFileConfig(tmp, isolatedSettingsEnv());
		assert.ok(loaded.toolInstructions);
		assert.equal(loaded.toolInstructions!.pause_goal?.mode, "local");
		assert.equal(loaded.toolInstructions!.goal_question?.inline, "Use intercom.");
	});

	it("persists toolInstructions to the JSON file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ti4-"));
		saveGoalSettingsFileConfig(tmp, {
			toolInstructions: {
				pause_goal: { mode: "local" },
			},
		});
		const raw = JSON.parse(
			fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"),
		);
		assert.ok(raw.toolInstructions);
		assert.equal(raw.toolInstructions.pause_goal.mode, "local");
	});
});
