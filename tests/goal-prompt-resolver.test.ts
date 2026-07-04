import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadGoalPrompt,
	resolveGoalPromptMode,
	globalGoalPromptPath,
	localGoalPromptPath,
	customGoalPromptBlock,
} from "../extensions/goal-prompt-resolver.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

interface Sandbox {
	cwd: string;
	home: string;
	writeGlobal(text: string): void;
	writeLocal(text: string): void;
}

function makeSandbox(): { cwd: string; home: string; writeGlobal: (t: string) => void; writeLocal: (t: string) => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gprompt-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gprompt-home-"));
	fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	return {
		cwd,
		home,
		writeGlobal(text) { fs.writeFileSync(globalGoalPromptPath(home), text, "utf8"); },
		writeLocal(text) { fs.writeFileSync(localGoalPromptPath(cwd), text, "utf8"); },
	};
}

let sb: ReturnType<typeof makeSandbox>;

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => {
	try { fs.rmSync(sb.cwd, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(sb.home, { recursive: true, force: true }); } catch {}
});

describe("resolveGoalPromptMode", () => {
	it("defaults to global-local", () => {
		assert.equal(resolveGoalPromptMode(undefined), "global-local");
		assert.equal(resolveGoalPromptMode({}), "global-local");
	});
	it("returns explicit mode", () => {
		assert.equal(resolveGoalPromptMode({ goalPromptMode: "local" }), "local");
		assert.equal(resolveGoalPromptMode({ goalPromptMode: "global-local-merge" }), "global-local-merge");
	});
});

describe("loadGoalPrompt — inline override", () => {
	it("inline takes precedence over all file modes", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadGoalPrompt({ goalPrompt: "INLINE", goalPromptMode: "local" }, sb.cwd, sb.home);
		assert.equal(r.source, "inline");
		assert.equal(r.prompt, "INLINE");
	});
	it("inline ignores blank strings", () => {
		const r = loadGoalPrompt({ goalPrompt: "   " }, sb.cwd, sb.home);
		assert.equal(r.source, "none");
		assert.equal(r.prompt, "");
	});
});

describe("loadGoalPrompt — local mode", () => {
	it("local mode never reads global", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadGoalPrompt({ goalPromptMode: "local" }, sb.cwd, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});
	it("local mode with no local file yields none", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadGoalPrompt({ goalPromptMode: "local" }, sb.cwd, sb.home);
		assert.equal(r.source, "none");
		assert.equal(r.prompt, "");
	});
});

describe("loadGoalPrompt — global-local (default)", () => {
	it("local overrides global when present", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadGoalPrompt(undefined, sb.cwd, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});
	it("falls back to global when local missing", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadGoalPrompt(undefined, sb.cwd, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});
	it("none when both missing", () => {
		const r = loadGoalPrompt(undefined, sb.cwd, sb.home);
		assert.equal(r.source, "none");
		assert.equal(r.prompt, "");
	});
});

describe("loadGoalPrompt — global-local-merge", () => {
	it("merges global + local with blank line separator", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadGoalPrompt({ goalPromptMode: "global-local-merge" }, sb.cwd, sb.home);
		assert.equal(r.source, "merged");
		assert.equal(r.prompt, "GLOBAL\n\nLOCAL");
	});
	it("global-only when local missing", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadGoalPrompt({ goalPromptMode: "global-local-merge" }, sb.cwd, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});
});

describe("loadGoalPrompt — blank/whitespace handling", () => {
	it("blank file treated as missing", () => {
		sb.writeLocal("   \n\n  ");
		const r = loadGoalPrompt(undefined, sb.cwd, sb.home);
		assert.equal(r.source, "none");
	});
});

describe("customGoalPromptBlock", () => {
	it("returns empty string when nothing configured", () => {
		assert.equal(customGoalPromptBlock(undefined, sb.cwd, sb.home), "");
	});
	it("wraps prompt in tagged block with source label", () => {
		sb.writeLocal("RULES-HERE");
		const block = customGoalPromptBlock(undefined, sb.cwd, sb.home);
		assert.ok(block.includes("[PI GOAL CUSTOM PROMPT source=local]"), `missing source label: ${block}`);
		assert.ok(block.includes("<goal_custom_prompt>"));
		assert.ok(block.includes("</goal_custom_prompt>"));
		assert.ok(block.includes("RULES-HERE"));
	});
	it("inline source label reflects inline origin", () => {
		const block = customGoalPromptBlock({ goalPrompt: "INLINE-TEXT" }, sb.cwd, sb.home);
		assert.ok(block.includes("[PI GOAL CUSTOM PROMPT source=inline]"));
		assert.ok(block.includes("INLINE-TEXT"));
	});
});
