/**
 * Additional branch-coverage tests for goal-lock.ts.
 * Targets uncovered branches in readLockDetailed, isLockHeld, writeLockExclusive,
 * acquireLock retry paths, reapStaleLock, and refreshLease.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type GoalFocusLock,
	type LockOwner,
	lockDir,
	lockPath,
	readLock,
	readLockDetailed,
	isLockHeld,
	isLockStale,
	writeLockAtomic,
	writeLockExclusive,
	acquireLock,
	releaseLock,
	reapStaleLock,
	refreshLease,
	reapOrphanedLocks,
} from "../extensions/goal-lock.ts";

const LEASE_MS = 180_000;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-cov-"));
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

// ── readLockDetailed: non-object JSON values ───────────────────────────────

describe("readLockDetailed — non-object JSON", () => {
	it("returns error for JSON null", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "null");
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("returns error for JSON number", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "42");
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("returns error for JSON string", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), '"hello"');
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("returns error for JSON array", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "[1,2,3]");
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("normalizes missing startTimeMs to null", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		const lock = mkLock();
		// Write lock WITHOUT startTimeMs
		const { startTimeMs, ...ownerWithout } = lock.owner as any;
		const lockWithoutStartTime = { ...lock, owner: ownerWithout };
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(lockWithoutStartTime));
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "found");
		if (result.status === "found") {
			assert.equal(result.lock.owner.startTimeMs, null);
		}
	});
});

// ── isLockHeld: edge cases ─────────────────────────────────────────────────

describe("isLockHeld — edge cases", () => {
	it("returns false for NaN expiresAt (invalid date)", () => {
		const lock = mkLock({ expiresAt: "not-a-date" });
		assert.equal(isLockHeld(lock), false);
	});

	it("returns false for empty string expiresAt", () => {
		const lock = mkLock({ expiresAt: "" });
		assert.equal(isLockHeld(lock), false);
	});

	it("isLockStale returns true for NaN expiresAt", () => {
		const lock = mkLock({ expiresAt: "not-a-date" });
		assert.equal(isLockStale(lock), true);
	});
});

// ── writeLockExclusive ─────────────────────────────────────────────────────

describe("writeLockExclusive", () => {
	it("returns true on successful write", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		const result = writeLockExclusive(cwd, "g1", lock);
		assert.equal(result, true);
	});

	it("returns false on EEXIST (lock already exists)", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		writeLockExclusive(cwd, "g1", lock);
		// Second write should fail with EEXIST
		const result = writeLockExclusive(cwd, "g1", lock);
		assert.equal(result, false);
	});
});

// ── acquireLock — corrupt lock reap and retry paths ────────────────────────

describe("acquireLock — corrupt lock reap", () => {
	it("reaps corrupt lock file and acquires", () => {
		const cwd = tmpCwd();
		// Write a corrupt lock file
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt");
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, true);
	});

	it("returns ok: false on initial read when lock freshly held by other (no retry path taken)", () => {
		const cwd = tmpCwd();
		// Pre-write a held lock owned by other
		const other: LockOwner = { sessionId: "other", pid: process.pid };
		acquireLock(cwd, "g1", other, LEASE_MS);
		// Now self tries to acquire — first readLock sees a fresh other-held lock
		// and returns { ok: false, heldByOther } before writeLockExclusive is
		// ever attempted (the EEXIST re-read branch stays uncovered here).
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, false);
		assert.equal(result.heldByOther?.owner.sessionId, "other");
	});
});

// ── reapStaleLock — not-stale and TOCTOU paths ─────────────────────────────

describe("reapStaleLock — not-stale", () => {
	it("does NOT reap a fresh lock (not stale)", () => {
		const cwd = tmpCwd();
		const lock = mkLock({ owner: { sessionId: "alive", pid: process.pid } });
		writeLockAtomic(cwd, "g1", lock);
		reapStaleLock(cwd, "g1");
		// Lock should still exist (not stale — PID alive + fresh lease)
		assert.ok(readLock(cwd, "g1"), "fresh lock must survive reapStaleLock");
	});

	it("no-op when lock does not exist", () => {
		const cwd = tmpCwd();
		assert.doesNotThrow(() => {
			reapStaleLock(cwd, "nonexistent");
		});
	});
});

// ── releaseLock — forced release ───────────────────────────────────────────

describe("releaseLock — forced release", () => {
	it("deletes lock without self (forced release)", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		// Release without self — forced
		releaseLock(cwd, "g1");
		assert.equal(readLock(cwd, "g1"), null);
	});

	it("no-op when lock does not exist (no throw)", () => {
		const cwd = tmpCwd();
		assert.doesNotThrow(() => {
			releaseLock(cwd, "nonexistent");
		});
	});
});

// ── refreshLease — lostLock paths ──────────────────────────────────────────

describe("refreshLease — lostLock", () => {
	it("returns lostLock when lock is missing", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, true);
	});

	it("returns lostLock when owned by other session", () => {
		const cwd = tmpCwd();
		const other: LockOwner = { sessionId: "other", pid: process.pid };
		acquireLock(cwd, "g1", other, LEASE_MS);
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, true);
	});

	it("returns refreshed: false (no lostLock) on corrupt lock", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		// Corrupt the lock
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt");
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, undefined);
	});
});

// ── reapOrphanedLocks — edge cases ─────────────────────────────────────────

describe("reapOrphanedLocks — edge cases", () => {
	it("no-op when .locks dir does not exist", () => {
		const cwd = tmpCwd();
		assert.doesNotThrow(() => {
			reapOrphanedLocks(cwd, new Set());
		});
	});

	it("reaps multiple orphaned locks", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "orphan1", mkLock({ goalId: "orphan1" }));
		writeLockAtomic(cwd, "orphan2", mkLock({ goalId: "orphan2" }));
		writeLockAtomic(cwd, "active1", mkLock({ goalId: "active1" }));
		reapOrphanedLocks(cwd, new Set(["active1"]));
		assert.equal(readLock(cwd, "orphan1"), null);
		assert.equal(readLock(cwd, "orphan2"), null);
		assert.ok(readLock(cwd, "active1"));
	});
});
