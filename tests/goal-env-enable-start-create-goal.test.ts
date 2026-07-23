import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";

/**
 * RED test (TDD step 2) — PI_GOAL_ENABLE_START_GOAL / PI_GOAL_ENABLE_CREATE_GOAL
 * env vars make start_goal / create_goal tools CALLABLE-WHILE-HIDDEN.
 *
 * Contract under test (from goal mruclxo8-zl33gu, locked decisions LD1 + LD2):
 *   - Default (env unset): tool is HIDDEN from active set (current behavior).
 *     → hidden && !callable. (Old contract — still required for backward compat.)
 *   - PI_GOAL_ENABLE_START_GOAL=1: tool IS present in active set (callable).
 *     → quiet-prose (no promptSnippet) + callable.
 *   - PI_GOAL_ENABLE_CREATE_GOAL=1: same for create_goal.
 *
 * This test FAILS on current code (active.delete always runs) → drives GREEN
 * implementation in extensions/goal.ts syncGoalTools() + settings loading.
 *
 * Related: tests/goal-start-goal.test.ts:96 codifies the OLD "must NEVER appear
 * in setActiveTools snapshot" contract. That assertion will be flipped to a
 * conditional (env=1 → MUST appear) in a follow-up GREEN commit.
 */

interface CapturedTool {
	name: string;
	execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) => Promise<any>;
	renderCall: (args: any, theme: any) => unknown;
	renderResult: (result: any, opts: any, theme: any) => unknown;
}
interface CapturedCommand {
	handler: (rawArgs: string, ctx: any) => any;
}

interface Harness {
	tools: Map<string, CapturedTool>;
	commands: Map<string, CapturedCommand>;
	handlers: Map<string, (...args: any[]) => unknown>;
	activeToolSnapshots: string[][];
	getActiveToolsReturn: () => string[];
}

function makeHarness(initialTools: string[] = []): Harness {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const activeToolSnapshots: string[][] = [];
	// Mutable backing array so tests can swap behavior mid-suite.
	let activeReturn = [...initialTools];
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
	return {
		tools,
		commands,
		handlers,
		activeToolSnapshots,
		getActiveToolsReturn: () => [...activeReturn],
	};
}

const identityTheme = new Proxy({} as any, {
	get(_t, prop: string) {
		if (prop === "bold") return (s: any) => s;
		return (s: any) => s;
	},
});

function makeCtx(cwd: string): any {
	return {
		cwd,
		hasUI: false,
		model: { provider: "p", id: "m" },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
		ui: { notify() {}, setStatus() {}, custom: async () => ({}) },
		sendMessage: () => {},
	};
}

function tmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-envgoal-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

const ENV_KEYS = ["PI_GOAL_ENABLE_START_GOAL", "PI_GOAL_ENABLE_CREATE_GOAL"] as const;
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
	// Clear goal tools env vars before each test — explicit set per-test.
	for (const k of ENV_KEYS) delete process.env[k];
});

/**
 * Trigger syncGoalTools via turn_start handler (sets cachedCwd, then calls
 * syncGoalTools which reads settings via loadGoalSettings(cachedCwd)).
 */
async function triggerSync(cwd: string): Promise<void> {
	const handler = h.handlers.get("turn_start");
	if (!handler) throw new Error("turn_start handler not registered");
	await handler({}, makeCtx(cwd));
}

describe("PI_GOAL_ENABLE_START_GOAL env var — callable-while-hidden", () => {
	it("DEFAULT (env unset): start_goal NOT in active set — preserves old contract", async () => {
		const cwd = tmpCwd();
		const before = h.activeToolSnapshots.length;
		await triggerSync(cwd);
		assert.ok(h.activeToolSnapshots.length > before, "turn_start should have triggered setActiveTools");
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			!lastSnap.includes("start_goal"),
			`DEFAULT: start_goal must NOT be in active set. Got: ${lastSnap.join(", ")}`,
		);
	});

	it("PI_GOAL_ENABLE_START_GOAL=true: start_goal IS in active set (callable)", async () => {
		process.env.PI_GOAL_ENABLE_START_GOAL = "true";
		const cwd = tmpCwd();
		const before = h.activeToolSnapshots.length;
		await triggerSync(cwd);
		assert.ok(h.activeToolSnapshots.length > before, "turn_start should have triggered setActiveTools");
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			lastSnap.includes("start_goal"),
			`ENABLED: start_goal MUST be in active set when PI_GOAL_ENABLE_START_GOAL=1. Got: ${lastSnap.join(", ")}`,
		);
	});

	it("PI_GOAL_ENABLE_START_GOAL=false: start_goal NOT in active set (explicit off)", async () => {
		process.env.PI_GOAL_ENABLE_START_GOAL = "false";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			!lastSnap.includes("start_goal"),
			`EXPLICIT OFF: start_goal must NOT be in active set when PI_GOAL_ENABLE_START_GOAL=0. Got: ${lastSnap.join(", ")}`,
		);
	});

	it("PI_GOAL_ENABLE_START_GOAL=true does NOT alter create_goal visibility (separate variable)", async () => {
		process.env.PI_GOAL_ENABLE_START_GOAL = "true";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			!lastSnap.includes("create_goal"),
			`SEPARATE VARS: enabling start_goal must NOT also enable create_goal. Got: ${lastSnap.join(", ")}`,
		);
	});
});

describe("PI_GOAL_ENABLE_CREATE_GOAL env var — callable-while-hidden", () => {
	it("DEFAULT (env unset): create_goal NOT in active set — preserves old contract", async () => {
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			!lastSnap.includes("create_goal"),
			`DEFAULT: create_goal must NOT be in active set. Got: ${lastSnap.join(", ")}`,
		);
	});

	it("PI_GOAL_ENABLE_CREATE_GOAL=true: create_goal IS in active set (callable)", async () => {
		process.env.PI_GOAL_ENABLE_CREATE_GOAL = "true";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			lastSnap.includes("create_goal"),
			`ENABLED: create_goal MUST be in active set when PI_GOAL_ENABLE_CREATE_GOAL=1. Got: ${lastSnap.join(", ")}`,
		);
	});

	it("create_goal has NO promptSnippet — callable-while-hidden (quiet-prose)", () => {
		// R2: when enabled, create_goal must NOT advertise in prose.
		// The promptSnippet is omitted from the definition (same pattern as
		// start_goal) so even when in the active set, it stays quiet.
		const def = h.tools.get("create_goal");
		assert.ok(def, "create_goal must be registered");
		assert.ok(
			!def?.promptSnippet,
			"create_goal must NOT have a promptSnippet (callable-while-hidden). Got: " + def?.promptSnippet,
		);
	});

	it("PI_GOAL_ENABLE_CREATE_GOAL=true does NOT alter start_goal visibility (separate variable)", async () => {
		process.env.PI_GOAL_ENABLE_CREATE_GOAL = "true";
		const cwd = tmpCwd();
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			!lastSnap.includes("start_goal"),
			`SEPARATE VARS: enabling create_goal must NOT also enable start_goal. Got: ${lastSnap.join(", ")}`,
		);
	});
});

describe("create_goal execute when PI_GOAL_ENABLE_CREATE_GOAL=1 — Q1 decision (b) functional", () => {
	it("create_goal with valid objective CREATES a goal (no REJECT)", async () => {
		process.env.PI_GOAL_ENABLE_CREATE_GOAL = "true";
		const cwd = tmpCwd();
		// First sync to populate cachedCwd + active set.
		await triggerSync(cwd);
		const res = await h.tools.get("create_goal")!.execute(
			"t", { objective: "Objective: create_goal functional test. Success criteria: goal persisted." },
			undefined, undefined, makeCtx(cwd),
		);
		const text: string = res.content[0]?.text ?? "";
		assert.ok(
			!/REJECTED/i.test(text),
			`create_goal when enabled MUST create a goal (Q1 decision b). Got REJECT: ${text.slice(0, 200)}`,
		);
		// Verify goal was persisted to disk.
		const dir = path.join(cwd, ".pi", "goals");
		const files = fs.existsSync(dir)
			? fs.readdirSync(dir).filter((f) => f.startsWith("active_goal_") || f.startsWith("goal_"))
			: [];
		assert.ok(files.length > 0, "create_goal when enabled MUST persist a goal .md file");
	});
});

describe("settings file fallback — enableStartGoal/enableCreateGoal without env vars", () => {
	// Worst-first: tests the exact user bug — env vars set in shell but NOT
	// propagated to pi process. Settings file is the persistent fallback.
	it("settings file enableStartGoal=true: start_goal IS in active set (no env var needed)", async () => {
		const cwd = tmpCwd();
		// Write settings file (NOT env var) — simulates the deployed config.
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ enableStartGoal: true }),
		);
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			lastSnap.includes("start_goal"),
			`SETTINGS FILE: start_goal MUST be in active set when settings.enableStartGoal=true (no env var). Got: ${lastSnap.join(", ")}`,
		);
	});

	it("settings file enableCreateGoal=true: create_goal IS in active set (no env var needed)", async () => {
		const cwd = tmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ enableCreateGoal: true }),
		);
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(
			lastSnap.includes("create_goal"),
			`SETTINGS FILE: create_goal MUST be in active set when settings.enableCreateGoal=true (no env var). Got: ${lastSnap.join(", ")}`,
		);
	});

	it("settings file BOTH keys: BOTH tools in active set", async () => {
		const cwd = tmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ enableStartGoal: true, enableCreateGoal: true }),
		);
		await triggerSync(cwd);
		const lastSnap = h.activeToolSnapshots[h.activeToolSnapshots.length - 1]!;
		assert.ok(lastSnap.includes("start_goal"), "BOTH: start_goal missing");
		assert.ok(lastSnap.includes("create_goal"), "BOTH: create_goal missing");
	});
});
