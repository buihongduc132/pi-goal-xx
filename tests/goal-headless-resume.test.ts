/**
 * Feature (c) — non-TUI paused-goal auto-resume at session_start.
 *
 * Contract (flow/requirements/2026-07-25_goal-launch-env.md R3.1):
 *   - print mode (hasUI=false): paused goal auto-resumes to active.
 *   - PI_GOAL_AUTO_RESUME=0: stays paused (opt-out).
 *   - PI_GOAL_AUTO_RESUME=1: forces auto-resume even in TUI.
 *   - TUI (hasUI=true, isInteractiveTui): prompts (existing behavior preserved).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	cleanupTimers,
	flushContinuation,
	countContinuations,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-hr-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	delete process.env.PI_GOAL_AUTO_RESUME;
	delete process.env.PI_GOAL_FILE;
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	delete process.env.PI_GOAL_AUTO_RESUME;
	delete process.env.PI_GOAL_FILE;
	try { fs.chmodSync(path.join(cwd, ".pi", "goals", ".locks"), 0o755); } catch {}
	fs.rmSync(cwd, { recursive: true, force: true });
});

/** Write a paused goal into the pool. autoContinue=false so normalize does not auto-promote. */
function writePausedGoal(id: string, autoContinue = false): void {
	const objective = `Objective: ${id}. Success criteria: done.`;
	const record = {
		version: 3,
		id,
		status: "paused",
		autoContinue,
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		activePath: `.pi/goals/active_goal_20260101_${id}.md`,
	};
	const content = `${JSON.stringify(record, null, 2)}\n\n# Goal\n\n${objective}\n`;
	fs.writeFileSync(path.join(cwd, ".pi", "goals", `active_goal_20260101_${id}.md`), content);
}

function freshPi(opts: { hasUI?: boolean; mode?: string } = {}) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-focus", data: { goalId: undefined } }] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

/** Read the persisted status of a goal from disk (the source of truth after setGoal). */
function statusOnDisk(id: string): string | undefined {
	const pool = readActiveGoalPool({ cwd });
	// readActiveGoalPool filters out complete goals; for paused/active it returns them.
	return pool.get(id)?.status;
}

describe("Feature (c) — non-TUI paused-goal auto-resume", () => {
	it("print mode (hasUI=false): paused goal auto-resumed → continuation fires", async () => {
		writePausedGoal("paused-1");
		const { pi, ctx } = freshPi({ hasUI: false });
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 1, "paused goal MUST auto-resume + run in non-TUI");
	});

	it("PI_GOAL_AUTO_RESUME=0: paused goal stays paused (opt-out)", async () => {
		writePausedGoal("paused-2");
		process.env.PI_GOAL_AUTO_RESUME = "0";
		const { pi, ctx } = freshPi({ hasUI: false });
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "PI_GOAL_AUTO_RESUME=0 MUST block auto-resume");
	});

	it("PI_GOAL_AUTO_RESUME=1 in TUI: forces auto-resume (no prompt)", async () => {
		writePausedGoal("paused-3");
		process.env.PI_GOAL_AUTO_RESUME = "1";
		const { pi, ctx } = freshPi({ hasUI: true, mode: "interactive" });
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 1, "PI_GOAL_AUTO_RESUME=1 MUST force-resume even in TUI");
	});

	it("TUI interactive (no env): prompts (existing behavior) — declines → no resume", async () => {
		writePausedGoal("paused-4");
		const { pi, ctx } = freshPi({ hasUI: true, mode: "interactive" });
		// ctx.ui.confirm returns false by default in the mock → decline.
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "declined TUI prompt MUST NOT resume");
	});

	it("TUI interactive (no env): prompts — confirms → resume + run", async () => {
		writePausedGoal("paused-5");
		const local = createMockPi({ cwd });
		const ctx = createMockCtx(local, {
			cwd,
			hasUI: true,
			mode: "interactive",
			sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-focus", data: { goalId: undefined } }] as any[] } as any,
		});
		// Push a confirm=true so the TUI prompt resolves to "resume".
		(local.ui as any).confirmAnswers.push(true);
		goalExtension(local);
		pi = local;
		await emit(local, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		assert.equal(countContinuations(local), 1, "confirmed TUI prompt MUST resume + run");
	});
});
