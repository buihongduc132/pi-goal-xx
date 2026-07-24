import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { loadGoalSettings } from "../extensions/goal-settings.ts";

/**
 * Feature (a) — PI_GOAL_ENABLE master launch switch.
 *
 * Contract (from flow/requirements/2026-07-25_goal-launch-env.md R1):
 *   - PI_GOAL_ENABLE=true (or "1"): implies enableStartGoal=true AND
 *     enableCreateGoal=true. The inner pi gets the full goal tool surface.
 *   - PI_GOAL_ENABLE_START_GOAL=0 still narrows start_goal OFF even when
 *     PI_GOAL_ENABLE=true (explicit per-tool wins DOWN).
 *   - settings.enable=true is the file-config equivalent.
 *   - start_goal has a promptSnippet (so the model can start a goal from prose
 *     when the tool is active). Host auto-gates snippet by active-set membership.
 *
 * Baseline (PR #40): PI_GOAL_ENABLE_START_GOAL / PI_GOAL_ENABLE_CREATE_GOAL
 * per-tool opt-ins are already merged. This file proves the MASTER switch on
 * top of them.
 */

interface CapturedTool {
	name: string;
	promptSnippet?: string;
	execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) => Promise<any>;
	renderCall: (args: any, theme: any) => unknown;
	renderResult: (result: any, opts: any, theme: any) => unknown;
}
interface Harness {
	tools: Map<string, CapturedTool>;
	commands: Map<string, { handler: (rawArgs: string, ctx: any) => any }>;
	handlers: Map<string, (...args: any[]) => unknown>;
	activeToolSnapshots: string[][];
}

function makeHarness(initialTools: string[] = []): Harness {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, { handler: (rawArgs: string, ctx: any) => any }>();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const activeToolSnapshots: string[][] = [];
	let activeReturn = [...initialTools];
	const identityTheme = new Proxy({} as any, { get: () => (s: string) => s });
	const pi = new Proxy({} as any, {
		get(_t, prop) {
			if (prop === "registerTool") return (def: any) => { tools.set(def.name, def); return def; };
			if (prop === "registerCommand") return (name: string, def: any) => { commands.set(name, def); };
			if (prop === "on") return (event: string, cb: (...a: any[]) => unknown) => { handlers.set(event, cb); return () => {}; };
			if (prop === "getActiveTools") return () => [...activeReturn];
			if (prop === "setActiveTools") return (names: string[]) => { activeToolSnapshots.push([...names]); activeReturn = [...names]; };
			if (prop === "getModel") return () => ({ provider: "p", id: "m" });
			if (prop === "modelRegistry") return { find: () => undefined, getAvailable: () => [] };
			if (prop === "registerSlashCommand") return () => {};
			if (prop === "getTheme") return () => identityTheme;
			return () => {};
		},
	});
	goalExtension(pi);
	return { tools, commands, handlers, activeToolSnapshots };
}

function makeCtx(cwd: string): any {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		model: { provider: "p", id: "m" },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
		ui: { notify() {}, setStatus() {}, custom: async () => ({}) },
		sessionManager: { getBranch: () => [], appendCustom: () => {} },
		sendMessage: () => {},
	};
}

function tmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-master-"));
	fs.mkdirSync(path.join(tmp, ".pi", "goals"), { recursive: true });
	return tmp;
}

const ENV_KEYS = [
	"PI_GOAL_ENABLE",
	"PI_GOAL_ENABLE_START_GOAL",
	"PI_GOAL_ENABLE_CREATE_GOAL",
	"PI_GOAL_AUTO_CONFIRM",
	"PI_CODING_AGENT_DIR",
] as const;
type EnvSnap = Record<string, string | undefined>;

function snapEnv(): EnvSnap {
	const out: EnvSnap = {};
	for (const k of ENV_KEYS) out[k] = process.env[k];
	return out;
}
function restoreEnv(snap: EnvSnap): void {
	for (const k of ENV_KEYS) {
		if (snap[k] === undefined) delete process.env[k];
		else process.env[k] = snap[k];
	}
}

let h: Harness;
let envSnap: EnvSnap;

before(() => {
	envSnap = snapEnv();
	h = makeHarness();
});
after(() => restoreEnv(envSnap));

beforeEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
	// Isolate global config so the global settings file does not leak in.
	process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "pgxx-master-iso-" + Math.random().toString(36).slice(2));
});

/** Trigger syncGoalTools via turn_start handler (sets cachedCwd + syncs). */
async function triggerSync(cwd: string): Promise<void> {
	const handler = h.handlers.get("turn_start");
	if (!handler) throw new Error("turn_start handler not registered");
	await handler({}, makeCtx(cwd));
}

describe("PI_GOAL_ENABLE master switch — settings loader", () => {
	it("PI_GOAL_ENABLE=true → enable=true, enableStartGoal=true, enableCreateGoal=true", () => {
		process.env.PI_GOAL_ENABLE = "true";
		const s = loadGoalSettings(os.tmpdir());
		assert.equal(s.enable, true);
		assert.equal(s.enableStartGoal, true, "enableStartGoal MUST default to master");
		assert.equal(s.enableCreateGoal, true, "enableCreateGoal MUST default to master");
	});

	it("PI_GOAL_ENABLE=1 (digit) → treated as true", () => {
		process.env.PI_GOAL_ENABLE = "1";
		const s = loadGoalSettings(os.tmpdir());
		assert.equal(s.enable, true);
		assert.equal(s.enableStartGoal, true);
		assert.equal(s.enableCreateGoal, true);
	});

	it("PI_GOAL_ENABLE=true + PI_GOAL_ENABLE_START_GOAL=0 → start OFF, create ON (narrow-down)", () => {
		process.env.PI_GOAL_ENABLE = "true";
		process.env.PI_GOAL_ENABLE_START_GOAL = "0";
		const s = loadGoalSettings(os.tmpdir());
		assert.equal(s.enable, true);
		assert.equal(s.enableStartGoal, false, "explicit per-tool =0 MUST narrow down");
		assert.equal(s.enableCreateGoal, true);
	});

	it("PI_GOAL_ENABLE=true + PI_GOAL_ENABLE_CREATE_GOAL=false → create OFF, start ON", () => {
		process.env.PI_GOAL_ENABLE = "true";
		process.env.PI_GOAL_ENABLE_CREATE_GOAL = "false";
		const s = loadGoalSettings(os.tmpdir());
		assert.equal(s.enable, true);
		assert.equal(s.enableStartGoal, true);
		assert.equal(s.enableCreateGoal, false);
	});

	it("PI_GOAL_ENABLE unset → all false (backward compat)", () => {
		const s = loadGoalSettings(os.tmpdir());
		assert.equal(s.enable, false);
		assert.equal(s.enableStartGoal, false);
		assert.equal(s.enableCreateGoal, false);
	});

	it("settings file enable=true → both tools default on (file-config parity)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-"));
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ enable: true }));
		const s = loadGoalSettings(dir);
		assert.equal(s.enable, true);
		assert.equal(s.enableStartGoal, true);
		assert.equal(s.enableCreateGoal, true);
	});

	it("env > settings: PI_GOAL_ENABLE=false overrides settings.enable=true", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-"));
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ enable: true }));
		process.env.PI_GOAL_ENABLE = "false";
		const s = loadGoalSettings(dir);
		assert.equal(s.enable, false);
		assert.equal(s.enableStartGoal, false);
		assert.equal(s.enableCreateGoal, false);
	});
});

describe("PI_GOAL_ENABLE master switch — syncGoalTools active set", () => {
	it("PI_GOAL_ENABLE=true → start_goal AND create_goal present in active snapshot", async () => {
		process.env.PI_GOAL_ENABLE = "true";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const last = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(last.includes("start_goal"), `start_goal MUST be callable when PI_GOAL_ENABLE=true. Got: ${last.join(",")}`);
		assert.ok(last.includes("create_goal"), `create_goal MUST be callable when PI_GOAL_ENABLE=true. Got: ${last.join(",")}`);
	});

	it("PI_GOAL_ENABLE=true + PI_GOAL_ENABLE_START_GOAL=0 → start ABSENT, create present", async () => {
		process.env.PI_GOAL_ENABLE = "true";
		process.env.PI_GOAL_ENABLE_START_GOAL = "0";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const last = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(!last.includes("start_goal"), `start_goal MUST be hidden when explicitly =0. Got: ${last.join(",")}`);
		assert.ok(last.includes("create_goal"), `create_goal MUST still be present. Got: ${last.join(",")}`);
	});

	it("PI_GOAL_ENABLE=true + PI_GOAL_ENABLE_CREATE_GOAL=0 → create ABSENT, start present", async () => {
		process.env.PI_GOAL_ENABLE = "true";
		process.env.PI_GOAL_ENABLE_CREATE_GOAL = "0";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const last = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(last.includes("start_goal"), `start_goal MUST be present. Got: ${last.join(",")}`);
		assert.ok(!last.includes("create_goal"), `create_goal MUST be hidden when explicitly =0. Got: ${last.join(",")}`);
	});

	it("PI_GOAL_ENABLE unset → both tools ABSENT (backward compat)", async () => {
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const last = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(!last.includes("start_goal"), "start_goal must NOT be callable by default");
		assert.ok(!last.includes("create_goal"), "create_goal must NOT be callable by default");
	});
});

describe("PI_GOAL_ENABLE master switch — start_goal promptSnippet (prose cue)", () => {
	it("start_goal tool definition carries a promptSnippet", () => {
		// Snippet is static on the def; host auto-gates by active-set membership.
		// We assert the def HAS the snippet so that when active, the model is
		// prompted to start a goal from prose.
		const startGoal = h.tools.get("start_goal");
		assert.ok(startGoal, "start_goal tool must be registered");
		assert.equal(typeof startGoal!.promptSnippet, "string", "start_goal MUST have a promptSnippet");
		assert.ok(startGoal!.promptSnippet!.length > 20, "promptSnippet must be a meaningful cue");
		assert.match(startGoal!.promptSnippet!, /start_goal|prose|goal/i, "snippet should cue prose-driven start");
	});

	it("create_goal tool definition remains snippet-less (propose_goal_draft is the confirmation path)", () => {
		const createGoal = h.tools.get("create_goal");
		assert.ok(createGoal, "create_goal tool must be registered");
		assert.equal(createGoal!.promptSnippet, undefined, "create_goal MUST stay quiet-prose even when enabled");
	});
});

describe("PI_GOAL_ENABLE master switch — end-to-end start_goal.execute", () => {
	it("PI_GOAL_ENABLE=true: start_goal.execute creates and persists a goal .md", async () => {
		process.env.PI_GOAL_ENABLE = "true";
		const cwd = tmpCwd();
		const ctx = makeCtx(cwd);
		// Prime cachedCwd + pool via turn_start.
		await triggerSync(cwd);
		const startGoal = h.tools.get("start_goal")!;
		const result = await startGoal.execute("id1", { objective: "Test objective for master-enable e2e" }, undefined, undefined, ctx);
		assert.ok(result.content?.[0]?.text, "start_goal must return content");
		const files = fs.readdirSync(path.join(cwd, ".pi", "goals"));
		assert.ok(files.some((f) => /^active_goal_.*\.md$/.test(f)), "a goal .md MUST be persisted under .pi/goals");
	});
});
