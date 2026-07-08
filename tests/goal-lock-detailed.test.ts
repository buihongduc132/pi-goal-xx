/**
 * RED PHASE tests for goal-display-liveness OpenSpec change.
 *
 * Tests the new discriminated-return lock primitives:
 * - `readLockDetailed` — distinguishes ENOENT (missing) from error (EACCES/corrupt)
 * - `refreshLease` — returns `{ refreshed, lostLock? }` instead of void
 * - `reapOrphanedLocks` — best-effort cleanup of lock files for non-active goals
 *
 * These tests are expected to FAIL until the GREEN phase implements the features.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type GoalFocusLock,
	type LockOwner,
	lockDir,
	lockPath,
	writeLockAtomic,
	acquireLock,
	readLock,
	readLockDetailed,
	refreshLease,
	reapOrphanedLocks,
} from "../extensions/goal-lock.ts";

const LEASE_MS = 180_000;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-detailed-"));
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function mkLock(over: Partial<GoalFocusLock> = {}): GoalFocusLock {
	const now = Date.now();
	return {
		goalId: "g1",
		owner: { sessionId: "s1", pid: process.pid },
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + LEASE_MS).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
		...over,
	};
}

// ── readLockDetailed ─────────────────────────────────────────────────────────

describe("readLockDetailed", () => {
	it("returns { status: 'found', lock } for a valid lock file", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(lock));
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "found");
		if (result.status === "found") {
			assert.deepEqual(result.lock.owner.sessionId, "s1");
			assert.equal(result.lock.goalId, "g1");
		}
	});

	it("returns { status: 'missing' } for ENOENT (no lock file)", () => {
		const cwd = tmpCwd();
		// Do NOT create the .locks dir or the lock file
		const result = readLockDetailed(cwd, "nonexistent");
		assert.equal(result.status, "missing");
	});

	it("returns { status: 'error' } for corrupt JSON", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt json");
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("returns { status: 'error' } for invalid shape (valid JSON, wrong fields)", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		// Valid JSON but missing required fields (no goalId, no owner)
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify({ foo: "bar" }));
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("returns { status: 'error' } for EACCES (permission denied)", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		const lock = mkLock();
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(lock));
		// Remove read permission
		try {
			fs.chmodSync(lockPath(cwd, "g1"), 0o000);
			// Skip if running as root (root bypasses chmod)
			if (process.getuid && process.getuid() === 0) {
				// root can read anything, so this test is meaningless
				return;
			}
			const result = readLockDetailed(cwd, "g1");
			assert.equal(result.status, "error");
		} finally {
			fs.chmodSync(lockPath(cwd, "g1"), 0o644);
		}
	});
});

// ── readLockDetailed consistency with legacy readLock ────────────────────────

describe("readLockDetailed / readLock consistency", () => {
	it("found → readLock returns the lock", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(lock));
		const detailed = readLockDetailed(cwd, "g1");
		const legacy = readLock(cwd, "g1");
		assert.equal(detailed.status, "found");
		assert.notEqual(legacy, null);
	});

	it("missing → readLock returns null", () => {
		const cwd = tmpCwd();
		const detailed = readLockDetailed(cwd, "g1");
		const legacy = readLock(cwd, "g1");
		assert.equal(detailed.status, "missing");
		assert.equal(legacy, null);
	});

	it("error → readLock returns null", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt");
		const detailed = readLockDetailed(cwd, "g1");
		const legacy = readLock(cwd, "g1");
		assert.equal(detailed.status, "error");
		assert.equal(legacy, null);
	});
});

// ── refreshLease return type ─────────────────────────────────────────────────

describe("refreshLease return value", () => {
	it("returns { refreshed: true } when lease extended by self", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.deepEqual(result, { refreshed: true });
	});

	it("returns { refreshed: false, lostLock: true } on owner mismatch", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		const other: LockOwner = { sessionId: "other", pid: process.pid };
		acquireLock(cwd, "g1", other, LEASE_MS);
		// self tries to refresh a lock owned by other
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, true);
	});

	it("returns { refreshed: false, lostLock: true } when lock is missing", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		// No lock file at all
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, true);
	});

	it("returns { refreshed: false } (no lostLock) on read error — fail-open", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		// Corrupt the lock file so read fails with invalid shape → error
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt");
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, undefined, "lostLock must be undefined on read error (fail-open)");
	});
});

// ── reapOrphanedLocks ────────────────────────────────────────────────────────

describe("reapOrphanedLocks", () => {
	it("reaps orphaned lock for a completed goal (not in activeGoalIds)", () => {
		const cwd = tmpCwd();
		const lock = mkLock({ goalId: "completed-goal" });
		writeLockAtomic(cwd, "completed-goal", lock);
		assert.ok(fs.existsSync(lockPath(cwd, "completed-goal")));
		reapOrphanedLocks(cwd, new Set(["other-active-goal"]));
		assert.ok(!fs.existsSync(lockPath(cwd, "completed-goal")), "orphaned lock should be reaped");
	});

	it("reaps orphaned lock for a deleted goal (not in activeGoalIds)", () => {
		const cwd = tmpCwd();
		const lock = mkLock({ goalId: "deleted-goal" });
		writeLockAtomic(cwd, "deleted-goal", lock);
		reapOrphanedLocks(cwd, new Set());
		assert.ok(!fs.existsSync(lockPath(cwd, "deleted-goal")), "deleted goal's lock should be reaped");
	});

	it("does NOT reap lock for an active goal (in activeGoalIds)", () => {
		const cwd = tmpCwd();
		const lock = mkLock({ goalId: "active-goal" });
		writeLockAtomic(cwd, "active-goal", lock);
		reapOrphanedLocks(cwd, new Set(["active-goal"]));
		assert.ok(fs.existsSync(lockPath(cwd, "active-goal")), "active goal's lock must NOT be reaped");
	});

	it("is a no-op when .locks/ dir is missing (no throw)", () => {
		const cwd = tmpCwd();
		// Do NOT create the .locks dir
		assert.doesNotThrow(() => {
			reapOrphanedLocks(cwd, new Set());
		});
	});

	it("does NOT touch .tmp files", () => {
		const cwd = tmpCwd();
		const tmpFile = path.join(lockDir(cwd), ".123.999.tmp");
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(tmpFile, "tmp data");
		reapOrphanedLocks(cwd, new Set());
		assert.ok(fs.existsSync(tmpFile), ".tmp files must not be touched");
	});
});
