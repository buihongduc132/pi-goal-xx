/**
 * RED PHASE tests for the unified settings schema (groups 5.1–5.9).
 *
 * Spec: openspec/changes/unified-prompt-config/specs/goal-settings/spec.md
 * Design: openspec/changes/unified-prompt-config/design.md (D7)
 *
 * These tests assert the NEW schema blocks that GREEN will implement:
 *   - prompts: Record<string, PromptConfig>
 *   - promptsDir, hooksDir, contractsDir
 *   - commandHooks: { enabled, [cmd]: CommandHookConfig }
 *   - contractTemplates: boolean
 *   - legacy auditorPrompt/auditorPromptMode alias → prompts.auditor
 *   - PI_GOAL_DISABLE_CONTRACT_TEMPLATES env override
 *
 * additionalProperties:false must be preserved (unknown keys rejected).
 *
 * Today these FAIL: the new keys are not yet in ALLOWED_SETTINGS_KEYS, so
 * parseGoalSettings throws "Unknown key" for prompts/commandHooks/etc.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PromptConfig, PromptMode } from "../extensions/prompt-resolver.ts";
import {
	parseGoalSettings,
	loadGoalSettingsFileConfig,
	loadGoalSettings,
	saveGoalSettingsFileConfig,
	goalSettingsPath,
} from "../extensions/goal-settings.ts";

/** Write a settings JSON file in a fresh tmpdir and return the cwd. */
function writeSettings(json: Record<string, unknown>, env?: Record<string, string>): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-settings-"));
	const configPath = path.join(cwd, ".pi", "pi-goal-xx-settings.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(json), "utf8");
	if (env) {
		// loadGoalSettings reads process.env; we pass env explicitly to the fns that accept it.
		(process.env as Record<string, string>) = { ...process.env, ...env };
	}
	return cwd;
}

// ---------------------------------------------------------------------------
// 1. prompts block round-trips
// ---------------------------------------------------------------------------

test("prompts block round-trips through parse and save", () => {
	const cwd = writeSettings({
		prompts: { "goal-running": { mode: "append", inline: "X" } },
	});
	const parsed = loadGoalSettingsFileConfig(cwd);
	const prompts = parsed.prompts as Record<string, PromptConfig> | undefined;
	assert.ok(prompts, "prompts block should be present");
	const gr = prompts!["goal-running"];
	assert.equal(gr.mode, "append");
	assert.equal(gr.inline, "X");

	// save round-trip
	saveGoalSettingsFileConfig(cwd, parsed);
	const reparsed = loadGoalSettingsFileConfig(cwd);
	const rprompts = reparsed.prompts as Record<string, PromptConfig> | undefined;
	assert.ok(rprompts);
	assert.equal(rprompts!["goal-running"].mode, "append");
	assert.equal(rprompts!["goal-running"].inline, "X");
});

// ---------------------------------------------------------------------------
// 2. Unknown prompt key rejected
// ---------------------------------------------------------------------------

test("unknown prompt key rejected (additionalProperties:false inside prompts)", () => {
	assert.throws(
		() => parseGoalSettings({ prompts: { "unknown-key": { mode: "append" } } }),
		/unknown-key|prompt/i,
		"unknown prompt key should be rejected",
	);
});

// ---------------------------------------------------------------------------
// 3. promptsDir round-trips
// ---------------------------------------------------------------------------

test("promptsDir round-trips through parse and save", () => {
	const cwd = writeSettings({ promptsDir: "/etc/pi/prompts" });
	const parsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(parsed.promptsDir, "/etc/pi/prompts");
	saveGoalSettingsFileConfig(cwd, parsed);
	const reparsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(reparsed.promptsDir, "/etc/pi/prompts");
});

// ---------------------------------------------------------------------------
// 4. commandHooks block
// ---------------------------------------------------------------------------

test("commandHooks.enabled defaults to false when omitted", () => {
	const cwd = writeSettings({ commandHooks: { goals: { mode: "append" } } });
	const parsed = loadGoalSettingsFileConfig(cwd);
	const ch = parsed.commandHooks as { enabled?: boolean } | undefined;
	assert.ok(ch, "commandHooks block present");
	assert.equal(ch!.enabled, false, "enabled must default to false");
});

test("commandHooks enabled=true round-trips", () => {
	const cwd = writeSettings({
		commandHooks: { enabled: true, goals: { mode: "override" } },
	});
	const parsed = loadGoalSettingsFileConfig(cwd);
	const ch = parsed.commandHooks as { enabled?: boolean; goals?: { mode?: string } };
	assert.equal(ch.enabled, true);
	assert.equal(ch.goals?.mode, "override");
	saveGoalSettingsFileConfig(cwd, parsed);
	const reparsed = loadGoalSettingsFileConfig(cwd);
	const rch = reparsed.commandHooks as { enabled?: boolean };
	assert.equal(rch.enabled, true);
});

// ---------------------------------------------------------------------------
// 5. contractTemplates boolean
// ---------------------------------------------------------------------------

test("contractTemplates defaults to true when absent", () => {
	const cwd = writeSettings({});
	const parsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(parsed.contractTemplates, true, "default should be true (enabled)");
});

test("contractTemplates=false round-trips", () => {
	const cwd = writeSettings({ contractTemplates: false });
	const parsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(parsed.contractTemplates, false);
	saveGoalSettingsFileConfig(cwd, parsed);
	const reparsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(reparsed.contractTemplates, false);
});

// ---------------------------------------------------------------------------
// 6. contractsDir round-trips
// ---------------------------------------------------------------------------

test("contractsDir round-trips", () => {
	const cwd = writeSettings({ contractsDir: "./legal/contracts" });
	const parsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(parsed.contractsDir, "./legal/contracts");
});

// ---------------------------------------------------------------------------
// 7. hooksDir round-trips
// ---------------------------------------------------------------------------

test("hooksDir round-trips", () => {
	const cwd = writeSettings({ hooksDir: ".pi/pi-goal-xx/hooks/" });
	const parsed = loadGoalSettingsFileConfig(cwd);
	assert.equal(parsed.hooksDir, ".pi/pi-goal-xx/hooks/");
});

// ---------------------------------------------------------------------------
// 8. Legacy auditor alias → prompts.auditor
// ---------------------------------------------------------------------------

test("legacy auditorPrompt + auditorPromptMode map to prompts.auditor (no prompts block)", () => {
	const cwd = writeSettings({
		auditorPrompt: "AUDIT-OVERRIDE-X",
		auditorPromptMode: "local",
	});
	const parsed = loadGoalSettingsFileConfig(cwd);
	const prompts = parsed.prompts as Record<string, PromptConfig> | undefined;
	assert.ok(prompts, "prompts block should be synthesized from legacy keys");
	const aud = prompts!.auditor;
	assert.ok(aud, "prompts.auditor should exist after alias mapping");
	assert.equal(aud.inline, "AUDIT-OVERRIDE-X");
	assert.equal(aud.mode, "local");
});

test("legacy alias resolves behaviorally via resolvePrompt", async () => {
	const { resolvePrompt } = await import("../extensions/prompt-resolver.ts");
	const cwd = writeSettings({
		auditorPrompt: "LEGACY-INLINE",
		auditorPromptMode: "local",
	});
	const parsed = loadGoalSettingsFileConfig(cwd);
	const audCfg = (parsed.prompts as Record<string, PromptConfig>).auditor;
	const r = resolvePrompt("auditor", audCfg, cwd, "DEFAULT", { home: os.tmpdir() });
	assert.equal(r.final, "DEFAULT\n\nLEGACY-INLINE");
});

// ---------------------------------------------------------------------------
// 9. PI_GOAL_DISABLE_CONTRACT_TEMPLATES env override
// ---------------------------------------------------------------------------

test("PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true disables templates even if file says true", () => {
	const cwd = writeSettings({ contractTemplates: true });
	const parsed = loadGoalSettings(cwd, {
		...process.env,
		PI_GOAL_DISABLE_CONTRACT_TEMPLATES: "true",
	} as NodeJS.ProcessEnv);
	assert.equal(parsed.contractTemplates, false, "env override must force false");
});

test("PI_GOAL_DISABLE_CONTRACT_TEMPLATES unset leaves contractTemplates=true", () => {
	const cwd = writeSettings({});
	const parsed = loadGoalSettings(cwd, {
		...process.env,
		PI_GOAL_DISABLE_CONTRACT_TEMPLATES: undefined,
	} as NodeJS.ProcessEnv);
	assert.equal(parsed.contractTemplates, true);
});

// ---------------------------------------------------------------------------
// 10. REGRESSION (passes today): unknown top-level key rejected
// ---------------------------------------------------------------------------

test("unknown top-level key rejected (additionalProperties:false preserved)", () => {
	assert.throws(
		() => parseGoalSettings({ bogus: 1 }),
		/bogus/i,
	);
});

// ---------------------------------------------------------------------------
// 11. Nested shape validation
// ---------------------------------------------------------------------------

test("prompts.<key>.mode invalid value rejected", () => {
	assert.throws(
		() => parseGoalSettings({ prompts: { "goal-running": { mode: "invalid-mode" } } }),
		/invalid-mode|mode/i,
	);
});

test("prompts.<key> with unknown nested key rejected", () => {
	assert.throws(
		() => parseGoalSettings({ prompts: { "goal-running": { bogus: 1 } } }),
		/bogus|prompt/i,
	);
});

test("prompts.<key>.mode accepts all 6 unified modes", () => {
	const modes: PromptMode[] = [
		"override",
		"append",
		"global-local",
		"local",
		"global-local-merge",
		"off",
	];
	for (const mode of modes) {
		const parsed = parseGoalSettings({
			prompts: { "goal-running": { mode } },
		});
		const gr = (parsed.prompts as Record<string, PromptConfig>)["goal-running"];
		assert.equal(gr.mode, mode, `mode ${mode} should be accepted`);
	}
});

// ---------------------------------------------------------------------------
// 12. Precedence: prompts.auditor wins over legacy auditorPrompt
// ---------------------------------------------------------------------------

test("prompts.auditor takes precedence over legacy auditorPrompt when both present", () => {
	const parsed = parseGoalSettings({
		auditorPrompt: "LEGACY-SHOULD-LOSE",
		auditorPromptMode: "local",
		prompts: { auditor: { inline: "NEW-WINS", mode: "override" } },
	});
	const aud = (parsed.prompts as Record<string, PromptConfig>).auditor;
	assert.equal(aud.inline, "NEW-WINS", "prompts.auditor should win");
	assert.equal(aud.mode, "override");
});

// Keep type imports live for tsc.
((): PromptConfig => ({ mode: "override", inline: "x" }))();
((): PromptMode => "off")();
