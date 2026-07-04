/**
 * add-goal-focus-locking — Unit E: auto-run chokepoint (tasks 4.10–4.16).
 *
 * Real harness-based behavioral tests. Each test loads the goal extension into
 * a fresh mock pi (fresh SELF_SESSION_ID + fresh continuation state), drives it
 * through its public surface (session_start event, /goal-resume command,
 * /goals-set command, pause_goal tool), and asserts on observable behavior:
 *   - whether a continuation fired (pi.sentMessages has a "pi-goal-event")
 *   - on-disk lock state (readLock / lockPath)
 *
 * The chokepoint under test (D6): queueContinuation auto-runs ONLY when this
 * session holds a live focus lock for the focused goal. There is no per-call-site
 * `force` bypass (F1 fix) — callers must have called acquireLock first.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
import {
	acquireLock,
	readLock,
	isLockHeld,
	releaseLock,
	lockPath,
	type LockOwner,
} from "../extensions/goal-lock.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	invokeCommand,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	countContinuations,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

const OTHER: LockOwner = { sessionId: "other-session-xyz", pid: process.pid };

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gate-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	// PI_TEAMS_WORKER may be set in the host env (e.g. team-worker agent). The
	// production isWorkerSession() check makes loadState skip focus entirely;
	// these tests exercise the non-worker path, so force it.
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

/** Read the single active goal id from disk (robust id extraction). */
function soleGoalIdOnDisk(): string {
	const pool = readActiveGoalPool({ cwd });
	const ids = [...pool.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly 1 goal on disk, got ${ids.length}: ${ids.join(",")}`);
	return ids[0]!;
}

/** Write a lock file directly with arbitrary owner + expiry (simulates lapse / other-holder). */
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

describe("Unit E — auto-run chokepoint (tasks 4.10–4.16)", () => {
	it("4.10: session_start resume + 1 open unlocked goal → acquireLock succeeds → continuation QUEUED", async () => {
		writeGoalFile(cwd, { id: "resume-goal", autoContinue: true });
		const { pi, ctx } = freshPi();

		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		const lock = readLock(cwd, "resume-goal");
		assert.ok(lock, "lock file written");
		assert.ok(isLockHeld(lock!), "lock is live");
		assert.equal(countContinuations(pi), 1, "resume-and-continue auto-run fires");
	});

	it("4.10b: session_tree → no acquireLock wired → chokepoint blocks → no continuation (documented)", async () => {
		writeGoalFile(cwd, { id: "tree-goal", autoContinue: true });
		const { pi, ctx } = freshPi();

		await emit(pi, ctx, "session_tree", {});
		await flushContinuation();

		assert.equal(countContinuations(pi), 0, "session_tree never auto-runs");
		const lock = readLock(cwd, "tree-goal");
		assert.equal(lock, null, "session_tree writes no lock");
	});

	it("4.11: session_start reason new/startup/fork → no auto-focus → no continuation", async () => {
		writeGoalFile(cwd, { id: "fresh-goal", autoContinue: true });
		for (const reason of ["new", "startup", "fork"] as const) {
			const { pi, ctx } = freshPi();
			await emit(pi, ctx, "session_start", { reason });
			await flushContinuation();
			assert.equal(countContinuations(pi), 0, `reason='${reason}' must not auto-run`);
			await cleanupTimers(pi, cwd);
		}
		pi = null;
	});

	it("4.12: /goal-resume after pause+lapse (own stale lock) → reaps + reacquires → continuation QUEUED", async () => {
		const { pi, ctx } = freshPi();
		await invokeCommand(pi, ctx, "goals-set", "Objective: self-heal. Success criteria: done.");
		await flushContinuation();
		const goalId = soleGoalIdOnDisk();
		assert.ok(goalId, "goal created");

		// Pause (stops heartbeat; lock remains on disk, lazy-reap).
		await invokeTool(pi, ctx, "pause_goal", { reason: "waiting" });
		// Simulate lease lapse: same owner, expired lease.
		const selfOwner = readLock(cwd, goalId)!.owner;
		plantLock(goalId!, selfOwner, Date.now() - 1_000);
		const staleBefore = readLock(cwd, goalId!);
		assert.ok(staleBefore && !isLockHeld(staleBefore), "lock is stale before resume");

		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();

		const lockAfter = readLock(cwd, goalId);
		assert.ok(lockAfter && isLockHeld(lockAfter), "lock reacquired and live");
		assert.ok(countContinuations(pi) >= 1, "self-heal auto-run fires after /goal-resume");
	});

	it("4.13: /goal-resume after lapse + other-session-acquired → blocked + held-by message", async () => {
		const { pi, ctx } = freshPi();
		await invokeCommand(pi, ctx, "goals-set", "Objective: held by other. Success criteria: done.");
		await flushContinuation();
		const goalId = soleGoalIdOnDisk();
		assert.ok(goalId, "goal created");

		await invokeTool(pi, ctx, "pause_goal", { reason: "waiting" });
		// Another live session acquires while we're paused.
		releaseLock(cwd, goalId);
		acquireLock(cwd, goalId, OTHER, 180_000);
		const held = readLock(cwd, goalId);
		assert.ok(held && held.owner.sessionId === OTHER.sessionId, "other session holds lock");

		pi.ui.notifyCalls.length = 0;
		pi.sentMessages.length = 0;
		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();

		assert.equal(countContinuations(pi), 0, "auto-run blocked when held by other");
		const notified = pi.ui.notifyCalls.some((n) => /held by session/i.test(String(n.msg)));
		assert.ok(notified, "held-by message surfaced");
		const stillHeld = readLock(cwd, goalId);
		assert.ok(stillHeld && stillHeld.owner.sessionId === OTHER.sessionId, "other session keeps lock");
	});

	it("4.14: replaceGoal (new-goal creation) → acquireLock → continuation QUEUED", async () => {
		const { pi, ctx } = freshPi();
		await invokeCommand(pi, ctx, "goals-set", "Objective: brand new. Success criteria: done.");
		await flushContinuation();
		const goalId = soleGoalIdOnDisk();
		assert.ok(goalId, "goal created");
		const lock = readLock(cwd, goalId);
		assert.ok(lock && isLockHeld(lock), "replaceGoal acquired the lock");
		assert.ok(countContinuations(pi) >= 1, "new-goal creation auto-runs");
	});

	it("4.15: focus change A→B → releaseLock(A) + acquireLock(B)", async () => {
		writeGoalFile(cwd, { id: "goal-A", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-B", autoContinue: true });
		const { pi, ctx } = freshPi();

		// Populate goalsById from disk (2 open goals → no auto-focus on any reason).
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "no auto-run at startup with 2 goals");

		// With 2 open goals, /goal-focus opens a selector. Drive it to pick B.
		(pi.ui as any).select = async (_title: string, items: string[]) =>
			items.find((x: string) => x.includes("goal-B")) ?? items[1];

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// After focus change: B acquired by SELF (live).
		const lockB = readLock(cwd, "goal-B");
		assert.ok(lockB, "B lock written by setFocusedGoalId");
		assert.ok(isLockHeld(lockB!), "B lock live");
		// A's lock file should NOT exist for A under SELF (it was never acquired
		// by self; confirmFocusOverride only reaps when locked-by-other-live,
		// and A was unlocked). The key invariant: only B is locked now.
		const lockA = readLock(cwd, "goal-A");
		assert.equal(lockA, null, "A is not locked (release+acquire leaves only B)");
	});

	it("4.16: fail-open fs error on acquireLock (.locks read-only) → no continuation (auto-run is NOT fail-open)", async () => {
		writeGoalFile(cwd, { id: "failopen-goal", autoContinue: true });
		const locksDir = path.join(cwd, ".pi", "goals", ".locks");
		fs.mkdirSync(locksDir, { recursive: true });
		fs.chmodSync(locksDir, 0o555);

		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		assert.equal(countContinuations(pi), 0, "auto-run blocked on fs error (not fail-open)");
		const files = fs.readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
		assert.equal(files.length, 0, "no lock file written under read-only .locks");
	});
});
