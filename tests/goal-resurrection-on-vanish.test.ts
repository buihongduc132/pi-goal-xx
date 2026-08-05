/**
 * RED regression tests for focus loss when the focused goal file vanishes.
 *
 * These tests describe required resurrection behavior before it exists:
 * an active in-memory goal with activePath survives an ENOENT-style deletion.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { goalTraceLogPath } from "../extensions/goal-trace.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	cleanupTimers,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
	writeGoalFile,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-vanish-red-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	fs.rmSync(cwd, { recursive: true, force: true });
});

function freshPi() {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

function readTraceAt(dir: string): Record<string, unknown>[] {
	const tracePath = goalTraceLogPath(dir);
	if (!fs.existsSync(tracePath)) return [];
	return fs.readFileSync(tracePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readTrace(): Record<string, unknown>[] {
	return readTraceAt(cwd);
}

describe("goal resurrection RED — vanished focused goal", () => {
	it("requires resurrection when activePath exists but disk pool becomes empty", async () => {
		// ARRANGE: load one active goal, establishing in-memory focus and activePath.
		const goalId = "vanish-active-001";
		const goalPath = writeGoalFile(cwd, { id: goalId, status: "active", autoContinue: false });
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		const before = await invokeTool(pi, ctx, "get_goal", {});
		assert.match(String((before as any)?.content?.[0]?.text ?? ""), /vanish-active-001/);

		// ACT: simulate worktree switch / accidental rm by removing focused file.
		fs.unlinkSync(goalPath);
		await emit(pi, ctx, "tool_execution_end", { toolName: "read" });

		// ASSERT: required behavior is focus resurrection, currently RED.
		const after = await invokeTool(pi, ctx, "get_goal", {});
		const text = String((after as any)?.content?.[0]?.text ?? "");
		assert.match(text, /vanish-active-001/);
		assert.ok(fs.existsSync(goalPath), "missing active goal file must be recreated");
		assert.ok(readTrace().some((entry) => entry.step === "reconcile.goal_restored_from_memory"));
	});

	it("requires resurrection after switching to a cwd with no goal pool", async () => {
		// ARRANGE: focus a persisted goal in cwd A.
		const goalId = "vanish-cross-cwd-001";
		writeGoalFile(cwd, { id: goalId, status: "active", autoContinue: false });
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		const before = await invokeTool(pi, ctx, "get_goal", {});
		assert.match(String((before as any)?.content?.[0]?.text ?? ""), /vanish-cross-cwd-001/);
		const cwdA = cwd;
		const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-vanish-cwd-b-"));
		fs.mkdirSync(path.join(cwdB, ".pi", "goals"), { recursive: true });

		// ACT: switch context cwd to a worktree with an empty goal pool.
		ctx.cwd = cwdB;
		const after = await invokeTool(pi, ctx, "get_goal", {});

		// ASSERT: focus and mirror file must survive cwd drift; current code is RED.
		assert.match(String((after as any)?.content?.[0]?.text ?? ""), /vanish-cross-cwd-001/);
		assert.ok(fs.readdirSync(path.join(cwdB, ".pi", "goals")).some((name) => name.includes(goalId)));
		assert.ok(readTraceAt(cwdB).some((entry) => entry.step === "reconcile.goal_restored_from_memory" && entry.originCwd === cwdA));
		fs.rmSync(cwdB, { recursive: true, force: true });
	});

	it("surfaces read errors instead of treating ENOTDIR as resurrection-eligible absence", async () => {
		// ARRANGE: focus an active goal, then replace the goals directory with a file.
		const goalId = "vanish-read-error-001";
		const goalPath = writeGoalFile(cwd, { id: goalId, status: "active", autoContinue: false });
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		const before = await invokeTool(pi, ctx, "get_goal", {});
		assert.match(String((before as any)?.content?.[0]?.text ?? ""), /vanish-read-error-001/);
		fs.unlinkSync(goalPath);
		fs.rmSync(path.join(cwd, ".pi", "goals"), { recursive: true, force: true });
		fs.writeFileSync(path.join(cwd, ".pi", "goals"), "not a directory");

		// ACT: reconcile against a non-directory goal store.
		await invokeTool(pi, ctx, "get_goal", {});

		// ASSERT: error must be observable, not silently converted to resurrection.
		assert.ok(readTrace().some((entry) => entry.level === "error" && entry.step === "reconcile.goal_read_error"));
	});

	it("records deliberate tombstone deletion as blocked, not accidental absence", async () => {
		// ARRANGE: focus a goal, remove its file, and add deliberate-delete marker.
		const goalId = "vanish-tombstone-001";
		const goalPath = writeGoalFile(cwd, { id: goalId, status: "active", autoContinue: false });
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		const before = await invokeTool(pi, ctx, "get_goal", {});
		assert.match(String((before as any)?.content?.[0]?.text ?? ""), /vanish-tombstone-001/);
		fs.unlinkSync(goalPath);
		fs.mkdirSync(path.join(cwd, ".pi", "goals", ".tombstones"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "goals", ".tombstones", goalId), "deleted\n");

		// ACT: reconcile after deliberate deletion.
		const result = await invokeTool(pi, ctx, "get_goal", {});

		// ASSERT: no zombie goal; blocked decision is traceable.
		assert.match(String((result as any)?.content?.[0]?.text ?? ""), /No goal|unfocused/i);
		assert.ok(readTrace().some((entry) => entry.step === "reconcile.goal_resurrection_blocked_tombstone"));
	});

	it("never inherits a vanished focused goal in a worker session", async () => {
		// ARRANGE: leader-focus memory exists before worker boundary is enabled.
		const goalId = "vanish-worker-001";
		const goalPath = writeGoalFile(cwd, { id: goalId, status: "active", autoContinue: false });
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		const before = await invokeTool(pi, ctx, "get_goal", {});
		assert.match(String((before as any)?.content?.[0]?.text ?? ""), /vanish-worker-001/);
		fs.unlinkSync(goalPath);
		process.env.PI_TEAMS_WORKER = "1";

		// ACT: worker reconciles an empty pool.
		const result = await invokeTool(pi, ctx, "get_goal", {});

		// ASSERT: worker stays unfocused and cannot resurrect leader memory.
		assert.match(String((result as any)?.content?.[0]?.text ?? ""), /No goal|unfocused/i);
		assert.equal(readTrace().some((entry) => entry.step === "reconcile.goal_restored_from_memory"), false);
	});
});
