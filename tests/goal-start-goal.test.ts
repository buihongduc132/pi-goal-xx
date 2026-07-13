import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";

/**
 * Dedicated tests for the start_goal tool: registration, lifecycle, and the
 * subagent-hiding contract (start_goal must never appear in the active tool set).
 *
 * The harness captures setActiveTools snapshots so we can assert that start_goal
 * is never surfaced to the LLM (and therefore never leaks to subagents, which
 * inherit tools via pi.getActiveTools()).
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
}

function makeHarness(): Harness {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const activeToolSnapshots: string[][] = [];
	const pi = new Proxy({} as any, {
		get(_t, prop) {
			if (prop === "registerTool") return (def: any) => { tools.set(def.name, def); return def; };
			if (prop === "registerCommand") return (name: string, def: any) => { commands.set(name, def); };
			if (prop === "on") return (event: string, cb: (...a: any[]) => unknown) => { handlers.set(event, cb); return () => {}; };
			if (prop === "getActiveTools") return () => [];
			if (prop === "setActiveTools") return (names: string[]) => { activeToolSnapshots.push([...names]); };
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-startgoal-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

let h: Harness;
before(() => { h = makeHarness(); });

describe("start_goal tool — registration", () => {
	it("is registered in the tool registry", () => {
		assert.ok(h.tools.has("start_goal"), "start_goal must be registered");
	});
});

describe("start_goal tool — subagent hiding contract", () => {
	// CRITICAL: start_goal must NEVER appear in the active tool set. If it did,
	// it would be visible to the LLM AND leak to subagents (goal-auditor inherits
	// tools via pi.getActiveTools()). These assertions run AFTER start_goal.execute()
	// (in the lifecycle describe below) which triggers syncGoalTools() → setActiveTools().
	// We assert against real captured snapshots, not an empty list.
	it("start_goal does NOT appear in any setActiveTools snapshot after execute", async () => {
		const cwd = tmpCwd();
		// Record the snapshot count before — lifecycle tests above may have added some.
		const beforeCount = h.activeToolSnapshots.length;
		await h.tools.get("start_goal")!.execute(
			"t", { objective: "Objective: hiding test. Success criteria: hidden." },
			undefined, undefined, makeCtx(cwd),
		);
		// Verify that execute actually triggered syncGoalTools (captured new snapshots).
		const afterCount = h.activeToolSnapshots.length;
		assert.ok(afterCount > beforeCount,
			`start_goal.execute should have triggered setActiveTools via syncGoalTools (before=${beforeCount}, after=${afterCount})`);
		// Now check every NEW snapshot captured by this execute call.
		for (let i = beforeCount; i < afterCount; i++) {
			const snapshot = h.activeToolSnapshots[i]!;
			assert.ok(
				!snapshot.includes("start_goal"),
				`start_goal must never be in setActiveTools snapshot #${i}, but found in: ${snapshot.join(", ")}`,
			);
		}
	});

	it("create_goal also does NOT appear in any setActiveTools snapshot after execute", async () => {
		const cwd = tmpCwd();
		const beforeCount = h.activeToolSnapshots.length;
		// create_goal.execute triggers syncGoalTools internally (via regTool wrapping).
		await h.tools.get("create_goal")!.execute(
			"t", { objective: "trigger sync" },
			undefined, undefined, makeCtx(cwd),
		);
		const afterCount = h.activeToolSnapshots.length;
		// Even if create_goal doesn't trigger setActiveTools itself, any snapshots
		// captured during this test must not contain create_goal.
		for (let i = beforeCount; i < afterCount; i++) {
			const snapshot = h.activeToolSnapshots[i]!;
			assert.ok(
				!snapshot.includes("create_goal"),
				`create_goal must never be in setActiveTools snapshot #${i}, but found in: ${snapshot.join(", ")}`,
			);
		}
	});
});

describe("start_goal tool — lifecycle", () => {
	it("creates a goal and reflects it in get_goal", async () => {
		const cwd = tmpCwd();
		const res = await h.tools.get("start_goal")!.execute(
			"t", { objective: "Objective: build the thing. Success criteria: built." },
			undefined, undefined, makeCtx(cwd),
		);
		assert.ok(res.content[0]?.text !== undefined);
		const get = await h.tools.get("get_goal")!.execute("t", {}, undefined, undefined, makeCtx(cwd));
		assert.match(get.content[0].text, /build the thing/i);
	});

	it("writes a goal .md file under .pi/goals", async () => {
		const cwd = tmpCwd();
		await h.tools.get("start_goal")!.execute(
			"t", { objective: "Objective: file test. Success criteria: file exists." },
			undefined, undefined, makeCtx(cwd),
		);
		const dir = path.join(cwd, ".pi", "goals");
		assert.ok(fs.existsSync(dir), "goals dir should exist");
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		assert.ok(files.length > 0, "active goal .md should exist");
	});

	it("sisyphus=true creates a sisyphus goal", async () => {
		const cwd = tmpCwd();
		await h.tools.get("start_goal")!.execute(
			"t", { objective: "Objective: sisyphus build. Success criteria: steps done.", sisyphus: true },
			undefined, undefined, makeCtx(cwd),
		);
		const get = await h.tools.get("get_goal")!.execute("t", {}, undefined, undefined, makeCtx(cwd));
		assert.match(get.content[0].text, /sisyphus/i);
	});

	it("empty objective is handled gracefully (no throw)", async () => {
		const cwd = tmpCwd();
		await assert.doesNotReject(async () => {
			await h.tools.get("start_goal")!.execute(
				"t", { objective: "" },
				undefined, undefined, makeCtx(cwd),
			);
		});
	});

	it("objective over 50KB is rejected", async () => {
		const cwd = tmpCwd();
		const huge = "x".repeat(60_000);
		const res = await h.tools.get("start_goal")!.execute(
			"t", { objective: huge },
			undefined, undefined, makeCtx(cwd),
		);
		assert.match(res.content[0].text, /exceed|limit|50|too long/i);
		// Verify no goal was created
		const dir = path.join(cwd, ".pi", "goals");
		const goalFiles = fs.existsSync(dir)
			? fs.readdirSync(dir).filter((f) => f.startsWith("active_goal_") || f.startsWith("goal_"))
			: [];
		assert.equal(goalFiles.length, 0, "no goal should be created for oversized objective");
	});

	it("renderCall does not throw", () => {
		const tool = h.tools.get("start_goal")!;
		assert.doesNotThrow(() => tool.renderCall({ objective: "test obj" }, identityTheme));
	});

	it("renderResult does not throw", () => {
		const tool = h.tools.get("start_goal")!;
		assert.doesNotThrow(() => tool.renderResult(
			{ content: [{ type: "text", text: "result" }], details: undefined },
			{}, identityTheme,
		));
	});
});
