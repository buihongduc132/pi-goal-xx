/**
 * add-goal-focus-locking — Unit H: multi-session integration (tasks 7.5–7.8).
 *
 * Two-session scenarios. NOTE: SELF_SESSION_ID is generated once per PROCESS
 * (module-level), so in production each pi session is a distinct process with a
 * distinct id. Within one test process all goalExtension instances share it, so
 * to simulate a SECOND session ("S1") holding a lock we plant a foreign-owner
 * lock on disk. S2 (the session under test) then sees it as "held by another
 * live session" and the lock gate / reap-on-acquire logic engages.
 *
 *  - 7.5: S2 reason='new' → unfocused (reason gate; independent of locks).
 *  - 7.6: goal-A locked by a live S1 → S2 reason='resume' unfocused (lock gate).
 *  - 7.7: S1 crashed (dead PID + expired lease) → S2 reaps + acquires.
 *  - 7.8: backward-compat single-session resume → focus + auto-run.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	readLock,
	isLockHeld,
	type LockOwner,
} from "../extensions/goal-lock.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	countContinuations,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

// "S1" — a distinct process/session. pid = this process (alive) so isPidAlive
// returns true, making a fresh-lease plant look LIVE.
const S1: LockOwner = { sessionId: "session-one-distinct", pid: process.pid };
const DEAD_PID = 999999; // non-existent PID → isPidAlive returns false (ESRCH)

let cwd: string;
let sessionsToCleanup: Array<{ pi: ReturnType<typeof createMockPi> }>;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-multi-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	sessionsToCleanup = [];
});

afterEach(async () => {
	for (const s of sessionsToCleanup) {
		try { await cleanupTimers(s.pi, cwd); } catch {}
	}
	sessionsToCleanup = [];
	restoreGoalEnv(envSnap);
	fs.rmSync(cwd, { recursive: true, force: true });
});

function newSession(hasUI = true) {
	const pi = createMockPi({ cwd });
	const ctx = createMockCtx(pi, {
		cwd,
		hasUI,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(pi);
	sessionsToCleanup.push({ pi });
	return { pi, ctx };
}

/** Plant a live lock owned by `owner` (fresh lease, alive PID). */
function plantLiveLock(goalId: string, owner: LockOwner) {
	writeLock(goalId, owner, Date.now() + 180_000);
}

/** Plant a stale lock (expired lease; owner may have a dead PID). */
function plantStaleLock(goalId: string, owner: LockOwner) {
	writeLock(goalId, owner, Date.now() - 1_000);
}

function writeLock(goalId: string, owner: LockOwner, expiresAtMs: number) {
	const dir = path.join(cwd, ".pi", "goals", ".locks");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${goalId}.lock`), JSON.stringify({
		goalId,
		owner,
		acquiredAt: new Date(Date.now() - 60_000).toISOString(),
		expiresAt: new Date(expiresAtMs).toISOString(),
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
	}));
}

async function isUnfocused(pi: ReturnType<typeof createMockPi>, ctx: any): Promise<boolean> {
	const result = await invokeTool(pi, ctx, "get_goal", {});
	const text = (result as any)?.content?.[0]?.text ?? "";
	return !text || text.includes("No goal") || text.includes("No active goal") || text.includes("unfocused");
}

describe("Unit H — multi-session integration (tasks 7.5–7.8)", () => {
	it("7.5: S1 focuses A, S2 starts reason='new' → S2 unfocused", async () => {
		writeGoalFile(cwd, { id: "goal-A", autoContinue: true });
		plantLiveLock("goal-A", S1); // S1 owns A.

		const s2 = newSession();
		await emit(s2.pi, s2.ctx, "session_start", { reason: "new" });
		await flushContinuation();

		assert.ok(await isUnfocused(s2.pi, s2.ctx), "S2 unfocused on reason='new' (LD3)");
		assert.equal(countContinuations(s2.pi), 0, "S2 does not auto-run");
		// S1 still owns A.
		assert.equal(readLock(cwd, "goal-A")?.owner.sessionId, S1.sessionId);
	});

	it("7.6: S1 focuses A, S2 starts reason='resume' → S2 unfocused (locked by S1)", async () => {
		writeGoalFile(cwd, { id: "goal-A", autoContinue: true });
		plantLiveLock("goal-A", S1);

		const s2 = newSession();
		await emit(s2.pi, s2.ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		assert.ok(await isUnfocused(s2.pi, s2.ctx), "S2 unfocused — goal-A locked by live S1");
		assert.equal(countContinuations(s2.pi), 0, "S2 does not auto-run (lock gate)");
		// S1 keeps the lock.
		assert.equal(readLock(cwd, "goal-A")?.owner.sessionId, S1.sessionId, "S1 retains lock");
	});

	it("7.7: S1 crashes (PID dead + lease expired) → S2 acquires on next start", async () => {
		writeGoalFile(cwd, { id: "goal-A", autoContinue: true });
		// S1 was alive but crashed: dead PID + expired lease.
		plantStaleLock("goal-A", { sessionId: "s1-crashed", pid: DEAD_PID });
		const stale = readLock(cwd, "goal-A");
		assert.ok(stale && !isLockHeld(stale), "S1 lock is stale");

		const s2 = newSession();
		await emit(s2.pi, s2.ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		assert.ok(!await isUnfocused(s2.pi, s2.ctx), "S2 focused after reaping S1's stale lock");
		const lock = readLock(cwd, "goal-A");
		assert.ok(lock && isLockHeld(lock), "S2 holds a live lock");
		assert.notEqual(lock!.owner.sessionId, "s1-crashed", "stale lock was reaped + overwritten");
	});

	it("7.8: backward-compat single-session resume → focus + auto-run", async () => {
		writeGoalFile(cwd, { id: "solo-goal", autoContinue: true });
		// No foreign lock — the common single-session case.

		const s = newSession();
		await emit(s.pi, s.ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		assert.ok(!await isUnfocused(s.pi, s.ctx), "single session focuses its sole open goal");
		const lock = readLock(cwd, "solo-goal");
		assert.ok(lock && isLockHeld(lock), "lock acquired");
		assert.ok(countContinuations(s.pi) >= 1, "auto-run fires (backward-compat)");
	});
});
