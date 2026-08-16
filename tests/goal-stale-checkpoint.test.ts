/**
 * B3 — stale-checkpoint misclassification for the SAME goal id.
 *
 * Live repro (2026-08-15, goals msts41bc-hcv1qd / msuagmre-wj1rxf): queued
 * checkpoints for the goal the session was actively running were repeatedly
 * neutralized as "[GOAL STALE goalId=X]" because staleness was inferred from
 * state drift (status/autoContinue race after pause, or a forked session
 * holding no focus) instead of goal identity.
 *
 * Contract: a queued checkpoint is stale iff its goalId does NOT identify a
 * goal this session may act on (focused goal id, or adoptable from the disk
 * pool). Same goal id → actionable, regardless of status/autoContinue/hash.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	cleanupTimers,
	invokeTool,
	invokeCommand,
	createGoalViaCommand,
} from "./_harness.ts";

let _lastPi: ReturnType<typeof createMockPi> | null = null;
let _lastCwd: string | null = null;

function tmpWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-b3-stale-"));
}

async function setup(cwd: string) {
	const pi = createMockPi({ cwd });
	_lastPi = pi;
	_lastCwd = cwd;
	goalExtension(pi as any);
	const ctx = createMockCtx(pi, { cwd });
	await emit(pi, "session_start", { reason: "new" }, ctx);
	return { pi, ctx };
}

/** Goal id from get_goal details ({version, goal:{id,...}}). */
async function goalIdOf(pi: ReturnType<typeof createMockPi>, ctx: ReturnType<typeof createMockCtx>): Promise<string> {
	const res = (await invokeTool(pi, ctx, "get_goal", {})) as { details?: { goal?: { id?: string } } };
	const id = res?.details?.goal?.id;
	assert.ok(typeof id === "string", "get_goal must expose the focused goal id");
	return id as string;
}

async function fireBeforeAgentStart(
	pi: ReturnType<typeof createMockPi>,
	ctx: ReturnType<typeof createMockCtx>,
	prompt: string,
): Promise<{ aborted: boolean; systemPrompt?: string }> {
	const list = pi.handlers.get("before_agent_start") ?? [];
	assert.ok(list.length > 0, "before_agent_start handler must be registered");
	let aborted = false;
	const ctxWithAbort = { ...ctx, abort: () => { aborted = true; } } as typeof ctx;
	const result = await Promise.resolve((list[list.length - 1] as any)({ prompt, systemPrompt: "" }, ctxWithAbort));
	return { aborted, systemPrompt: (result as { systemPrompt?: string } | undefined | void)?.systemPrompt };
}

afterEach(async () => {
	if (_lastPi && _lastCwd) {
		await cleanupTimers(_lastPi, _lastCwd);
	}
});

describe("B3 — stale-checkpoint compares goal identity only", () => {
	it("same goal paused mid-queue: continuation is NOT stale (no abort, no stale prompt)", async () => {
		const cwd = tmpWorkspace();
		const { pi, ctx } = await setup(cwd);
		await createGoalViaCommand(pi, ctx, "B3 paused-goal goal");
		const goalId = await goalIdOf(pi, ctx);

		// Pause AFTER a continuation is conceptually queued: status=paused,
		// autoContinue=false. Identity still matches → not stale.
		await invokeCommand(pi, ctx, "goal-pause", "");

		const res = await fireBeforeAgentStart(pi, ctx, `[GOAL CONTINUATION goalId=${goalId}]\nContinue.`);
		assert.equal(res.aborted, false, "same-goal continuation must not abort the turn");
		assert.ok(!res.systemPrompt || !/GOAL STALE/.test(res.systemPrompt), "same-goal continuation must not inject a stale system prompt");
	});

	it("forked session with no focus: same-goal continuation adopts from disk pool, NOT stale", async () => {
		const cwd = tmpWorkspace();
		// Session 1 creates + focuses the goal (writes goal file to disk).
		const s1 = await setup(cwd);
		await createGoalViaCommand(s1.pi, s1.ctx, "B3 fork goal");
		const goalId = await goalIdOf(s1.pi, s1.ctx);
		await cleanupTimers(s1.pi, s1.ctx);

		// Session 2: same cwd (goal file visible on disk), fresh session with
		// NO focus entries → state.goal null. This is the fork/repro case.
		const { pi, ctx } = await setup(cwd);
		const res = await fireBeforeAgentStart(pi, ctx, `[GOAL CONTINUATION goalId=${goalId}]\nContinue.`);
		assert.equal(res.aborted, false, "fork continuation for an active disk goal must not abort");
		assert.ok(!res.systemPrompt || !/GOAL STALE/.test(res.systemPrompt), "fork continuation must not inject a stale system prompt");
	});

	it("truly different goal id: continuation IS stale (guard still works)", async () => {
		const cwd = tmpWorkspace();
		const { pi, ctx } = await setup(cwd);
		await createGoalViaCommand(pi, ctx, "B3 other goal");
		const res = await fireBeforeAgentStart(pi, ctx, `[GOAL CONTINUATION goalId=definitely-other-goal]\nContinue.`);
		// Either aborted or stale prompt injected — the guard must fire.
		const staleFired = res.aborted || (typeof res.systemPrompt === "string" && /GOAL STALE/.test(res.systemPrompt));
		assert.equal(staleFired, true, "different-goal checkpoint must still be treated as stale");
	});

	it("context rewrite: same-goal event entries are never rewritten to stale", async () => {
		const cwd = tmpWorkspace();
		const { pi, ctx } = await setup(cwd);
		await createGoalViaCommand(pi, ctx, "B3 context goal");
		const goalId = await goalIdOf(pi, ctx);

		const mkEntry = (i: number) => ({
			role: "custom",
			customType: "goal_event",
			content: `[GOAL CHECKPOINT goalId=${goalId}] entry ${i}`,
			details: { kind: "checkpoint", goalId },
			display: false,
		});
		const messages = [mkEntry(0), mkEntry(1)]; // older duplicate + newest

		const list = pi.handlers.get("context") ?? [];
		assert.ok(list.length > 0, "context handler must be registered");
		const result = await Promise.resolve((list[list.length - 1] as any)({ messages }, ctx));
		const out = (result as { messages?: Array<{ content?: string }> } | undefined)?.messages ?? messages;
		for (const msg of out) {
			assert.ok(
				!(typeof msg.content === "string" && /GOAL STALE/.test(msg.content)),
				`same-goal entries must not be rewritten to stale (got: ${String(msg.content).slice(0, 80)})`,
			);
		}
	});
});
