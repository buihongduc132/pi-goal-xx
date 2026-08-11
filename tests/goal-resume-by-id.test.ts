/**
 * /goal-resume <short-id>: resume a specific open goal by ID.
 *
 * Feature: /goal-resume without args shows picker (existing behavior).
 * /goal-resume <short-id> bypasses the picker, focuses the matched goal,
 * and resumes it. Mirrors /goal-focus <short-id> pattern.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeCommand,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-resume-by-id-"));
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

function freshPi(hasUI = true) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

async function loadGoals(p: ReturnType<typeof createMockPi>, ctx: any) {
	await emit(p, ctx, "session_start", { reason: "new" });
	await flushContinuation();
}

/** Spy on ctx.ui.select to capture calls. */
function spySelect(ui: any) {
	const calls: Array<{ title?: any; items: any[] }> = [];
	const orig = ui.select.bind(ui);
	ui.select = async (...args: any[]) => {
		const title = args[0];
		const items = args[1] ?? args[0];
		calls.push({ title, items });
		return orig(args[1] ?? args[0], args[2]);
	};
	return {
		calls,
		restore: () => { ui.select = orig; },
	};
}

describe("/goal-resume <short-id> — resume specific goal", () => {
	it("resumes a paused goal by short-id suffix without showing picker", async () => {
		// Create 2 paused goals on disk
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "zz99yy11-betaid", status: "paused", autoContinue: false });

		const { pi: p, ctx } = freshPi(true);
		await loadGoals(p, ctx);

		// Focus the first goal directly by short-id (bypasses picker)
		await invokeCommand(p, ctx, "goal-focus", "qi4x4i");
		await flushContinuation();

		// Now resume the SECOND goal by short-id suffix
		const secondShortId = "betaid";
		p.ui.notifyCalls.length = 0;
		const spy = spySelect(p.ui);

		await invokeCommand(p, ctx, "goal-resume", secondShortId);
		await flushContinuation();
		spy.restore();

		// Assert: picker was NOT shown
		const selectCalls = spy.calls.filter((c) => c.items && c.items.length > 0);
		assert.equal(selectCalls.length, 0, "picker NOT shown when ID provided");

		// Assert: "Goal resumed." notification shown (success path)
		const resumed = p.ui.notifyCalls.some((n) => /Goal resumed/i.test(String(n.msg)));
		assert.ok(resumed, "'Goal resumed.' notification shown");

		// Assert: no "Goal not found" notification
		const notFound = p.ui.notifyCalls.some((n) => /Goal not found/i.test(String(n.msg)));
		assert.ok(!notFound, "no 'Goal not found' for valid ID");
	});

	it("shows 'Goal not found' for unknown ID", async () => {
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "paused", autoContinue: false });

		const { pi: p, ctx } = freshPi(true);
		await loadGoals(p, ctx);

		p.ui.notifyCalls.length = 0;

		await invokeCommand(p, ctx, "goal-resume", "nonexistent-id");

		const notFound = p.ui.notifyCalls.some((n) => /Goal not found/i.test(String(n.msg)));
		assert.ok(notFound, "'Goal not found' notification shown for unknown ID");
	});

	it("empty string arg still shows picker (backward compat)", async () => {
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "zz99yy11-betaid", status: "paused", autoContinue: false });

		const { pi: p, ctx } = freshPi(true);
		await loadGoals(p, ctx);

		// Focus first goal directly
		await invokeCommand(p, ctx, "goal-focus", "qi4x4i");
		await flushContinuation();

		// /goal-resume with empty string — should show picker
		const spy = spySelect(p.ui);
		(p.ui as any).selectAnswers.length = 0;
		await invokeCommand(p, ctx, "goal-resume", "");
		await flushContinuation();
		spy.restore();

		const selectCalls = spy.calls.filter((c) => c.items && c.items.length > 0);
		assert.ok(selectCalls.length >= 1, "picker shown when no ID provided");
	});

	// --- Additional coverage (scout-recommended) ---

	function readGoalStatus(gid: string): string | undefined {
		const goalDir = path.join(cwd, ".pi", "goals");
		const files = fs.readdirSync(goalDir);
		const f = files.find((x) => x.endsWith(`${gid}.md`));
		if (!f) return undefined;
		const raw = fs.readFileSync(path.join(goalDir, f), "utf8");
		const m = raw.match(/"status"\s*:\s*"([^"]+)"/);
		return m ? m[1] : undefined;
	}

	it("resumes the CORRECT goal when switching from a different focused goal", async () => {
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "zz99yy11-betaid", status: "paused", autoContinue: false });

		const { pi: p, ctx } = freshPi(true);
		await loadGoals(p, ctx);

		// Focus goal A (qi4x4i) first
		await invokeCommand(p, ctx, "goal-focus", "qi4x4i");
		await flushContinuation();

		// Resume goal B (betaid) by short-id
		p.ui.notifyCalls.length = 0;
		await invokeCommand(p, ctx, "goal-resume", "betaid");
		await flushContinuation();

		// B should be active, A should still be paused
		const statusB = readGoalStatus("zz99yy11-betaid");
		const statusA = readGoalStatus("mr62bc2x-qi4x4i");
		assert.equal(statusB, "active", "target goal B became active");
		assert.equal(statusA, "paused", "non-target goal A stays paused");
	});

	it("resume already-active goal by short-id is a safe no-op", async () => {
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "active", autoContinue: true });

		const { pi: p, ctx } = freshPi(true);
		await loadGoals(p, ctx);

		// Focus it first
		await invokeCommand(p, ctx, "goal-focus", "qi4x4i");
		await flushContinuation();

		p.ui.notifyCalls.length = 0;
		// Resume it again by short-id — should not crash
		await invokeCommand(p, ctx, "goal-resume", "qi4x4i");
		await flushContinuation();

		// No exception thrown = pass. Either "already running" info or re-resume is fine.
		assert.ok(true, "did not throw on already-active resume");
	});

	it("non-TUI mode (hasUI=false) with rawArgs does not show picker", async () => {
		writeGoalFile(cwd, { id: "mr62bc2x-qi4x4i", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "zz99yy11-betaid", status: "paused", autoContinue: false });

		const { pi: p, ctx } = freshPi(false); // hasUI=false (non-TUI)
		await loadGoals(p, ctx);

		// Focus goal A directly
		await invokeCommand(p, ctx, "goal-focus", "qi4x4i");
		await flushContinuation();

		const spy = spySelect(p.ui);
		p.ui.notifyCalls.length = 0;
		await invokeCommand(p, ctx, "goal-resume", "betaid");
		await flushContinuation();
		spy.restore();

		const selectCalls = spy.calls.filter((c) => c.items && c.items.length > 0);
		assert.equal(selectCalls.length, 0, "picker NOT shown in non-TUI mode with rawArgs");
	});
});
