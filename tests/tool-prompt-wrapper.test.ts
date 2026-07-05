/**
 * RED→GREEN tests for tool-prompt wrapping (group 4, D3).
 *
 * Spec: openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 * Design D3: tool prompts resolve at load via defineTool wrapper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { wrapToolDefinition } from "../extensions/tool-prompt-wrapper.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

interface ToolLike {
	name: string;
	promptSnippet: string;
	promptGuidelines?: string[];
}

function tmpCwdWithToolPrompt(toolKey: string, body: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-tool-"));
	const dir = path.join(cwd, ".pi/pi-goal-xx/prompts/");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${toolKey}.md`), body, "utf8");
	return cwd;
}

describe("wrapToolDefinition — default (no config)", () => {
	it("returns the tool unchanged when no prompts config", () => {
		const tool: ToolLike = { name: "get-goal", promptSnippet: "orig snippet", promptGuidelines: ["g1"] };
		const out = wrapToolDefinition(tool, undefined, "/nonexistent");
		assert.equal(out.promptSnippet, "orig snippet");
		assert.deepEqual(out.promptGuidelines, ["g1"]);
	});
});

describe("wrapToolDefinition — append mode", () => {
	it("appends resolved block to promptSnippet", () => {
		const cwd = tmpCwdWithToolPrompt("tool-get-goal", "EXTRA-TOOL-RULE");
		const settings = { prompts: { "tool-get-goal": { mode: "append" } } } as GoalSettings;
		const tool: ToolLike = { name: "get-goal", promptSnippet: "orig", promptGuidelines: [] };
		const out = wrapToolDefinition(tool, settings, cwd);
		assert.ok(out.promptSnippet.includes("orig"));
		assert.ok(out.promptSnippet.includes("EXTRA-TOOL-RULE"));
	});

	it("appends to promptGuidelines too", () => {
		const cwd = tmpCwdWithToolPrompt("tool-create-goal", "GL-RULE");
		const settings = { prompts: { "tool-create-goal": { mode: "append" } } } as GoalSettings;
		const tool: ToolLike = { name: "create-goal", promptSnippet: "s", promptGuidelines: ["base"] };
		const out = wrapToolDefinition(tool, settings, cwd);
		assert.ok(out.promptGuidelines!.some((g) => g.includes("GL-RULE")));
	});
});

describe("wrapToolDefinition — override mode", () => {
	it("replaces promptSnippet entirely", () => {
		const settings = { prompts: { "tool-get-goal": { mode: "override", inline: "OVERRIDE-SNIPPET" } } } as GoalSettings;
		const tool: ToolLike = { name: "get-goal", promptSnippet: "orig", promptGuidelines: [] };
		const out = wrapToolDefinition(tool, settings, "/nonexistent");
		assert.equal(out.promptSnippet, "OVERRIDE-SNIPPET");
	});

	it("override with no inline + file → file body", () => {
		const cwd = tmpCwdWithToolPrompt("tool-get-goal", "FILE-OVERRIDE-BODY");
		const settings = { prompts: { "tool-get-goal": { mode: "override" } } } as GoalSettings;
		const tool: ToolLike = { name: "get-goal", promptSnippet: "orig", promptGuidelines: [] };
		const out = wrapToolDefinition(tool, settings, cwd);
		assert.equal(out.promptSnippet, "FILE-OVERRIDE-BODY");
	});
});

describe("wrapToolDefinition — off mode", () => {
	it("leaves tool unchanged even if files exist", () => {
		const cwd = tmpCwdWithToolPrompt("tool-get-goal", "IGNORED");
		const settings = { prompts: { "tool-get-goal": { mode: "off" } } } as GoalSettings;
		const tool: ToolLike = { name: "get-goal", promptSnippet: "orig", promptGuidelines: [] };
		const out = wrapToolDefinition(tool, settings, cwd);
		assert.equal(out.promptSnippet, "orig");
		assert.ok(!out.promptSnippet.includes("IGNORED"));
	});
});
