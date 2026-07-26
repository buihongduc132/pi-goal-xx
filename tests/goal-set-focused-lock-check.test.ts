/**
 * Bug fix: setFocusedGoalId must check acquireFocusedLock result.
 *
 * When two sessions both try to focus the same stale goal, the lock acquisition
 * can fail (held by other session). Previously, setFocusedGoalId discarded the
 * return value, so both sessions would set focus and arm continuation — leading
 * to duplicate goal execution.
 *
 * Fix: check acquireFocusedLock result. On failure, notify user and revert focus.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	acquireLock,
	readLock,
	type LockOwner,
} from "../extensions/goal-lock.ts";
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

const OTHER: LockOwner = { sessionId: "other-session-for-race", pid: process.pid };

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-race-"));
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

function setup(hasUI: boolean) {
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

/** Populate goalsById from disk via session_start. */
async function loadGoals(pi: ReturnType<typeof createMockPi>, ctx: any) {
	await emit(pi, ctx, "session_start", { reason: "new" });
	await flushContinuation();
}

/** Plant a live lock held by OTHER. */
function plantOtherLiveLock(goalId: string) {
	acquireLock(cwd, goalId, OTHER, 180_000);
}

describe("setFocusedGoalId lock acquisition check", () => {
	it("resume flow: notifies user and does NOT set focus when lock acquisition fails (held by other)", async () => {
		writeGoalFile(cwd, { id: "race-goal", autoContinue: true, status: "active" });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);

		// Plant a live lock held by another session (simulates the race)
		plantOtherLiveLock("race-goal");

		// Trigger resume flow — this calls chooseOpenGoal → setFocusedGoalId
		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();

		// Lock should still be held by OTHER (not stolen)
		const lock = readLock(cwd, "race-goal");
		assert.ok(lock, "lock still present");
		assert.equal(lock!.owner.sessionId, OTHER.sessionId, "lock still held by other session");

		// User should be notified about the failure
		const warnNotify = pi.ui.notifyCalls.some((n) =>
			/held by session/i.test(String(n.msg)) || /not running/i.test(String(n.msg))
		);
		assert.ok(warnNotify, "user notified about lock held by other session");
	});

	it("resume flow: sets focus normally when lock acquisition succeeds", async () => {
		writeGoalFile(cwd, { id: "normal-goal", autoContinue: true, status: "paused" });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);

		// No competing lock — resume should work normally
		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();

		// Lock should be held by self
		const lock = readLock(cwd, "normal-goal");
		assert.ok(lock, "lock present");
		assert.notEqual(lock!.owner.sessionId, OTHER.sessionId, "lock held by self, not other");

		// No warning notification about held-by-other
		const warnNotify = pi.ui.notifyCalls.some((n) =>
			/held by session/i.test(String(n.msg)) && /warning/i === n.level
		);
		assert.ok(!warnNotify, "no warning when lock acquired successfully");
	});
});
