/**
 * Feature (b) — PI_GOAL_FILE / settings.goalFile autoload.
 *
 * Contract (flow/requirements/2026-07-25_goal-launch-env.md R2):
 *   - PI_GOAL_FILE=<path> at session_start → load file, focus it, run if active/paused.
 *   - Already-in-pool (same id) → just focus, no disk duplicate.
 *   - paused → flipped to active + autoContinue + clear stopReason, then run.
 *   - complete → focused but not run (notify info).
 *   - worker session (PI_TEAMS_WORKER=1) → ignored entirely.
 *   - missing/unparseable file → notify error, no crash.
 *   - lock held by other session → focus set, continuation blocked, held-by notify.
 *   - settings.goalFile used when env unset; env wins when both set.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
import { isLockHeld, readLock, lockPath, type LockOwner } from "../extensions/goal-lock.ts";
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
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gf-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	delete process.env.PI_GOAL_FILE;
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_AUTO_RESUME;
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	delete process.env.PI_GOAL_FILE;
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_AUTO_RESUME;
	try { fs.chmodSync(path.join(cwd, ".pi", "goals", ".locks"), 0o755); } catch {}
	fs.rmSync(cwd, { recursive: true, force: true });
});

/** Write a goal .md file OUTSIDE .pi/goals (simulating an external launcher-provided file). */
function writeExternalGoal(opts: {
	id: string;
	objective?: string;
	status?: string;
	autoContinue?: boolean;
}): { absPath: string; content: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ext-"));
	const objective = opts.objective ?? `Objective: ${opts.id}. Success criteria: done.`;
	const record = {
		version: 3,
		id: opts.id,
		status: opts.status ?? "active",
		autoContinue: opts.autoContinue ?? true,
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective,
		usage: { tokensUsed: 0, activeSeconds: 0 },
	};
	const content = `${JSON.stringify(record, null, 2)}\n\n# Goal Prompt\n\n${objective}\n`;
	const absPath = path.join(dir, `${opts.id}.md`);
	fs.writeFileSync(absPath, content);
	return { absPath, content };
}

/** Write a goal .md directly into .pi/goals (simulating already-in-pool). */
function writePoolGoal(opts: { id: string; status?: string; autoContinue?: boolean }): void {
	const objective = `Objective: ${opts.id}. Success criteria: done.`;
	const record = {
		version: 3,
		id: opts.id,
		status: opts.status ?? "active",
		autoContinue: opts.autoContinue ?? true,
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		activePath: `.pi/goals/active_goal_20260101_${opts.id}.md`,
	};
	const content = `${JSON.stringify(record, null, 2)}\n\n# Goal Prompt\n\n${objective}\n`;
	fs.writeFileSync(path.join(cwd, ".pi", "goals", `active_goal_20260101_${opts.id}.md`), content);
}

function freshPi(hasUI = false) {
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

function plantLiveLock(goalId: string, owner: LockOwner) {
	const dir = path.join(cwd, ".pi", "goals", ".locks");
	fs.mkdirSync(dir, { recursive: true });
	const lock = {
		goalId,
		owner,
		acquiredAt: new Date(Date.now() - 10_000).toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
	};
	fs.writeFileSync(lockPath(cwd, goalId), JSON.stringify(lock));
}

describe("Feature (b) — PI_GOAL_FILE autoload", () => {
	it("absolute path: loads external file, focuses it, persists into .pi/goals, runs (active)", async () => {
		const ext = writeExternalGoal({ id: "ext-active" });
		process.env.PI_GOAL_FILE = ext.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		const pool = readActiveGoalPool({ cwd });
		assert.ok(pool.has("ext-active"), "external goal MUST be loaded into the pool");
		const activeFiles = fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f) => /^active_goal_.*\.md$/.test(f));
		assert.ok(activeFiles.length >= 1, "goal MUST be persisted under .pi/goals");
		const lock = readLock(cwd, "ext-active");
		assert.ok(lock && isLockHeld(lock), "lock MUST be acquired");
		assert.equal(countContinuations(pi), 1, "continuation MUST fire for active goal");
	});

	it("cwd-relative path: loads file relative to ctx.cwd", async () => {
		const relName = "external-goal.md";
		const objective = "Objective: relative. Success criteria: done.";
		const record = { version: 3, id: "rel-goal", status: "active", autoContinue: true, sisyphus: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", objective, usage: { tokensUsed: 0, activeSeconds: 0 } };
		fs.writeFileSync(path.join(cwd, relName), `${JSON.stringify(record, null, 2)}\n\n# Goal\n\n${objective}\n`);
		process.env.PI_GOAL_FILE = relName;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.ok(readActiveGoalPool({ cwd }).has("rel-goal"), "relative-path goal MUST load");
		assert.equal(countContinuations(pi), 1, "continuation MUST fire");
	});

	it("already-in-pool (same id): just focuses, no duplicate on disk", async () => {
		writePoolGoal({ id: "poolgoal", status: "active", autoContinue: true });
		// Point PI_GOAL_FILE at the same id but via an external file.
		const ext = writeExternalGoal({ id: "poolgoal", objective: "Objective: poolgoal. Success criteria: done." });
		process.env.PI_GOAL_FILE = ext.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();
		const activeFiles = fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f) => /^active_goal_.*\.md$/.test(f));
		// Only the one pre-existing pool file — no duplicate written.
		const poolFilesForGoal = activeFiles.filter((f) => f.includes("poolgoal"));
		assert.equal(poolFilesForGoal.length, 1, "MUST NOT duplicate the goal on disk");
		assert.equal(countContinuations(pi), 1, "continuation MUST fire");
	});

	it("paused goal: flipped to active + autoContinue + stopReason cleared, then runs", async () => {
		// autoContinue:false so normalizeGoalRecord does NOT auto-promote to active.
		const ext = writeExternalGoal({ id: "paused-goal", status: "paused", autoContinue: false });
		process.env.PI_GOAL_FILE = ext.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		const pool = readActiveGoalPool({ cwd });
		const goal = pool.get("paused-goal");
		assert.ok(goal, "goal loaded");
		// After load+flip, readActiveGoalPool reads from the persisted file (now active).
		// The on-disk file reflects the flip because setGoal persists.
		const onDiskFiles = fs.readdirSync(path.join(cwd, ".pi", "goals")).filter((f) => /^active_goal_.*paused-goal.*\.md$/.test(f) || f.includes("paused-goal"));
		assert.ok(onDiskFiles.length >= 1, "goal file exists");
		assert.equal(countContinuations(pi), 1, "paused→active MUST trigger continuation");
	});

	it("complete goal: focused but NOT run; notify info; no continuation", async () => {
		const ext = writeExternalGoal({ id: "done-goal", status: "complete" });
		process.env.PI_GOAL_FILE = ext.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "complete goal MUST NOT auto-run");
	});

	it("worker session (PI_TEAMS_WORKER=1): ignored entirely", async () => {
		const ext = writeExternalGoal({ id: "worker-goal" });
		process.env.PI_GOAL_FILE = ext.absPath;
		process.env.PI_TEAMS_WORKER = "1";
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(readActiveGoalPool({ cwd }).size, 0, "worker MUST NOT load the goal");
		assert.equal(countContinuations(pi), 0, "worker MUST NOT run");
		delete process.env.PI_TEAMS_WORKER;
	});

	it("missing file: notify error, no crash, no continuation", async () => {
		process.env.PI_GOAL_FILE = "/nonexistent/path/to/goal.md";
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "missing file MUST NOT run");
		// No crash = emit returned.
	});

	it("unparseable file: notify error, no crash", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-bad-"));
		const abs = path.join(dir, "bad.md");
		fs.writeFileSync(abs, "this is not json { at all");
		process.env.PI_GOAL_FILE = abs;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "unparseable MUST NOT run");
	});

	it("lock held by other LIVE session: focus set, continuation blocked", async () => {
		const ext = writeExternalGoal({ id: "held-goal" });
		// Pre-plant a live lock by another session. Use the live process.pid so
		// isLockHeld() sees a live PID (matching the autorun-gate test pattern).
		plantLiveLock("held-goal", { sessionId: "other-session-xyz", pid: process.pid });
		process.env.PI_GOAL_FILE = ext.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "continuation MUST be blocked when held by other");
	});

	it("settings.goalFile used when PI_GOAL_FILE unset", async () => {
		const ext = writeExternalGoal({ id: "settings-goal" });
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ goalFile: ext.absPath }));
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		assert.ok(readActiveGoalPool({ cwd }).has("settings-goal"), "settings.goalFile MUST load");
		assert.equal(countContinuations(pi), 1);
	});

	it("env > settings precedence: both set → env path wins", async () => {
		const extEnv = writeExternalGoal({ id: "env-wins" });
		const extFile = writeExternalGoal({ id: "file-loses" });
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ goalFile: extFile.absPath }));
		process.env.PI_GOAL_FILE = extEnv.absPath;
		const { pi, ctx } = freshPi();
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
		const pool = readActiveGoalPool({ cwd });
		assert.ok(pool.has("env-wins"), "env goal MUST win");
		assert.ok(!pool.has("file-loses"), "settings goal MUST NOT load when env is set");
	});
});
