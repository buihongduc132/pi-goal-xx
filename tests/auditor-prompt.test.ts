import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadAuditorPrompt,
	resolveAuditorPromptMode,
	globalAuditorPromptPath,
	localAuditorPromptPath,
} from "../extensions/auditor-prompt.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

const DEFAULT_PROMPT = "DEFAULT-HARDCODED-PROMPT";

interface Sandbox {
	cwd: string;
	home: string;
	writeGlobal(text: string): void;
	writeLocal(text: string): void;
	removeGlobal(): void;
	removeLocal(): void;
}

function makeSandbox(): Sandbox {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-prompt-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-prompt-home-"));
	fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	return {
		cwd,
		home,
		writeGlobal(text) {
			fs.writeFileSync(globalAuditorPromptPath(home), text, "utf8");
		},
		writeLocal(text) {
			fs.writeFileSync(localAuditorPromptPath(cwd), text, "utf8");
		},
		removeGlobal() {
			try { fs.unlinkSync(globalAuditorPromptPath(home)); } catch {}
		},
		removeLocal() {
			try { fs.unlinkSync(localAuditorPromptPath(cwd)); } catch {}
		},
	};
}

let sb: Sandbox;

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => {
	try { fs.rmSync(sb.cwd, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(sb.home, { recursive: true, force: true }); } catch {}
});

describe("resolveAuditorPromptMode", () => {
	it("defaults to global-local", () => {
		assert.equal(resolveAuditorPromptMode(undefined), "global-local");
		assert.equal(resolveAuditorPromptMode({}), "global-local");
	});
	it("returns explicit mode", () => {
		assert.equal(resolveAuditorPromptMode({ auditorPromptMode: "local" }), "local");
		assert.equal(resolveAuditorPromptMode({ auditorPromptMode: "global-local-merge" }), "global-local-merge");
	});
});

describe("loadAuditorPrompt — inline override", () => {
	it("inline takes precedence over all file modes", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadAuditorPrompt({ auditorPrompt: "INLINE", auditorPromptMode: "local" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "inline");
		assert.equal(r.prompt, "INLINE");
	});
	it("inline ignores blank strings", () => {
		const r = loadAuditorPrompt({ auditorPrompt: "   " }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "default");
		assert.equal(r.prompt, DEFAULT_PROMPT);
	});
});

describe("loadAuditorPrompt — global-local (default)", () => {
	it("local overrides global when present", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});
	it("falls back to global when no local", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});
	it("falls back to default when neither exists", () => {
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "default");
		assert.equal(r.prompt, DEFAULT_PROMPT);
	});
});

describe("loadAuditorPrompt — local mode", () => {
	it("uses only local when present", () => {
		sb.writeGlobal("GLOBAL"); // should be ignored
		sb.writeLocal("LOCAL");
		const r = loadAuditorPrompt({ auditorPromptMode: "local" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});
	it("falls back to default when no local (global ignored)", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadAuditorPrompt({ auditorPromptMode: "local" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "default");
		assert.equal(r.prompt, DEFAULT_PROMPT);
	});
	it("does not read global file in local mode (deletion after init is safe)", () => {
		// Write global, run load once to populate any caching, then remove global.
		// In local mode the global file is NEVER consulted, so removing it has no effect.
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r1 = loadAuditorPrompt({ auditorPromptMode: "local" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r1.prompt, "LOCAL");
		sb.removeGlobal();
		const r2 = loadAuditorPrompt({ auditorPromptMode: "local" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r2.prompt, "LOCAL");
	});
});

describe("loadAuditorPrompt — global-local-merge mode", () => {
	it("merges global + local with blank line", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = loadAuditorPrompt({ auditorPromptMode: "global-local-merge" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "merged");
		assert.equal(r.prompt, "GLOBAL\n\nLOCAL");
	});
	it("uses global only when no local", () => {
		sb.writeGlobal("GLOBAL");
		const r = loadAuditorPrompt({ auditorPromptMode: "global-local-merge" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});
	it("uses local only when no global", () => {
		sb.writeLocal("LOCAL");
		const r = loadAuditorPrompt({ auditorPromptMode: "global-local-merge" }, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});
});

describe("loadAuditorPrompt — empty file handling", () => {
	it("empty local file treated as missing", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("   \n  \n");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});
});

describe("path helpers", () => {
	it("globalAuditorPromptPath uses home/.pi", () => {
		assert.equal(globalAuditorPromptPath("/home/user"), path.join("/home/user", ".pi", "auditor-prompt.md"));
	});
	it("localAuditorPromptPath uses cwd/.pi", () => {
		assert.equal(localAuditorPromptPath("/proj"), path.join("/proj", ".pi", "auditor-prompt.md"));
	});
});

// Use GoalSettings type to keep the import.
((): GoalSettings => ({}))();
