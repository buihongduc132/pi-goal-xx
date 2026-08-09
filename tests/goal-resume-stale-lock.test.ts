/**
 * Stale-resume bug: /goal-resume must succeed when the goal file says
 * active+autoContinue but the lock is stale (lease lapsed / PID dead).
 *
 * Bug: validateResumeGoal checks ONLY file status → returns "Goal is already
 * running" even when the lock is stale. The fix is in handleGoalResume: check
 * lock liveness BEFORE the validateResumeGoal gate.
 *
 * Pattern mirrors goal-autorun-gate.test.ts 4.12 (self-heal after pause+lapse)
 * but WITHOUT the pause — the goal stays active+autoContinue while the lock
 * lapses.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
import {
	readLock,
	isLockHeld,
	lockPath,
	type LockOwner,
} from "../extensions/goal-lock.ts";
import {
	createMockPi,
	createMockCtx,
	invokeCommand,
	cleanupTimers,
	flushContinuation,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-stale-resume-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	try { fs.chmodSync(path.join(cwd, ".pi", "goals", ".locks"), 0o755); } catch {}
	fs.rmSync(cwd, { recursive: true, force: true });
});

function freshPi() {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: true,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

function soleGoalIdOnDisk(): string {
	const pool = readActiveGoalPool({ cwd });
	const ids = [...pool.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly 1 goal on disk, got ${ids.length}: ${ids.join(",")}`);
	return ids[0]!;
}

/** Write a lock file directly with arbitrary owner + expiry. */
function plantLock(goalId: string, owner: LockOwner, expiresAtMs: number) {
	const dir = path.join(cwd, ".pi", "goals", ".locks");
	fs.mkdirSync(dir, { recursive: true });
	const lock = {
		goalId,
		owner,
		acquiredAt: new Date(Date.now() - 60_000).toISOString(),
		expiresAt: new Date(expiresAtMs).toISOString(),
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
	};
	fs.writeFileSync(lockPath(cwd, goalId), JSON.stringify(lock));
}

describe("stale-resume bug — /goal-resume when lock is stale but goal is active", () => {
	it("resume succeeds when goal is active+autoContinue but lock lease lapsed (no pause)", async () => {
		const { pi: p, ctx } = freshPi();

		// Create goal → focused in state.goal, lock acquired, auto-run fires.
		await invokeCommand(p, ctx, "goals-set", "Objective: stale-resume repro. Success criteria: done.");
		await flushContinuation();
		const goalId = soleGoalIdOnDisk();
		assert.ok(goalId, "goal created");

		// Goal is active + autoContinue + lock held by self (live).
		const selfOwner = readLock(cwd, goalId)!.owner;
		assert.ok(selfOwner, "self lock exists");
		assert.ok(isLockHeld(readLock(cwd, goalId)!), "lock is live before lapse");

		// Simulate lease lapse WITHOUT pausing: rewrite the lock with an expired
		// lease. The goal file stays active+autoContinue (never paused).
		plantLock(goalId!, selfOwner, Date.now() - 1_000);
		const staleBefore = readLock(cwd, goalId!);
		assert.ok(staleBefore && !isLockHeld(staleBefore), "lock is stale before resume");

		// Clear notification/message state to detect the resume outcome.
		p.ui.notifyCalls.length = 0;
		p.sentMessages.length = 0;

		// /goal-resume — must NOT be blocked with "already running".
		await invokeCommand(p, ctx, "goal-resume", "");
		await flushContinuation();

		// Assert: lock reacquired and live.
		const lockAfter = readLock(cwd, goalId);
		assert.ok(lockAfter && isLockHeld(lockAfter), "lock reacquired and live after resume");

		// Assert: NOT blocked with "already running".
		// Note: countContinuations won't increment because the continuation already
		// fired during goals-set and continuationQueuedFor prevents re-queueing.
		// The bug is about the "already running" block, not re-firing continuations.
		const blocked = p.ui.notifyCalls.some((n) => /already running/i.test(String(n.msg)));
		assert.ok(!blocked, "resume NOT blocked with 'already running' when lock is stale");

		// Assert: "Goal resumed." notification shown (success path).
		const resumed = p.ui.notifyCalls.some((n) => /Goal resumed/i.test(String(n.msg)));
		assert.ok(resumed, "'Goal resumed.' notification shown");
	});

	it("resume succeeds when lock is missing entirely (no lock file)", async () => {
		const { pi: p, ctx } = freshPi();

		await invokeCommand(p, ctx, "goals-set", "Objective: missing-lock repro. Success criteria: done.");
		await flushContinuation();
		const goalId = soleGoalIdOnDisk();
		assert.ok(goalId, "goal created");

		// Delete the lock file entirely (simulates a crash without lock write).
		fs.unlinkSync(lockPath(cwd, goalId!));
		assert.equal(readLock(cwd, goalId!), null, "lock file absent");

		p.ui.notifyCalls.length = 0;
		p.sentMessages.length = 0;

		await invokeCommand(p, ctx, "goal-resume", "");
		await flushContinuation();

		const lockAfter = readLock(cwd, goalId);
		assert.ok(lockAfter && isLockHeld(lockAfter), "lock acquired after resume");

		const blocked = p.ui.notifyCalls.some((n) => /already running/i.test(String(n.msg)));
		assert.ok(!blocked, "resume NOT blocked when lock is missing");

		const resumed = p.ui.notifyCalls.some((n) => /Goal resumed/i.test(String(n.msg)));
		assert.ok(resumed, "'Goal resumed.' notification shown");
	});
});
