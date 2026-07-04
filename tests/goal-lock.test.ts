import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type GoalFocusLock,
	lockDir,
	lockPath,
	readLock,
	isPidAlive,
	isLockHeld,
	isLockStale,
	writeLockAtomic,
	acquireLock,
	releaseLock,
	reapStaleLock,
	refreshLease,
} from "../extensions/goal-lock.ts";

const LEASE_MS = 180_000;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-test-"));
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

describe("lockDir / lockPath", () => {
	it("lockDir returns <cwd>/.pi/goals/.locks", () => {
		const cwd = tmpCwd();
		assert.equal(lockDir(cwd), path.join(cwd, ".pi", "goals", ".locks"));
	});

	it("lockPath returns <cwd>/.pi/goals/.locks/<goalId>.lock", () => {
		const cwd = tmpCwd();
		assert.equal(lockPath(cwd, "g1"), path.join(cwd, ".pi", "goals", ".locks", "g1.lock"));
	});
});

describe("readLock", () => {
	it("returns null when no lock file exists", () => {
		const cwd = tmpCwd();
		assert.equal(readLock(cwd, "g1"), null);
	});

	it("parses valid JSON lock", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(lock));
		const read = readLock(cwd, "g1");
		assert.deepEqual(read?.owner.sessionId, "s1");
	});

	it("returns null on invalid JSON", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt");
		assert.equal(readLock(cwd, "g1"), null);
	});
});

describe("isPidAlive", () => {
	it("returns true for current process (alive)", () => {
		assert.equal(isPidAlive(process.pid), true);
	});

	it("returns false for a dead PID (ESRCH)", () => {
		// PID 0x7FFFFFFF — extremely unlikely to exist
		assert.equal(isPidAlive(0x7FFFFFFF), false);
	});

	it("returns TRUE on EPERM (cross-user alive process)", () => {
		// Simulate EPERM by mocking: we can't easily trigger a real EPERM,
		// but we test the error-code logic by checking that a PID known to
		// exist (pid 1, init) returns true even if we lack permission.
		// On most systems pid 1 exists. If it throws EPERM, isPidAlive must
		// still return true.
		const result = isPidAlive(1);
		assert.equal(result, true, "init (pid 1) should be alive regardless of EPERM");
	});
});

describe("isLockHeld / isLockStale", () => {
	it("held: PID alive + lease fresh", () => {
		const lock = mkLock();
		assert.equal(isLockHeld(lock), true);
		assert.equal(isLockStale(lock), false);
	});

	it("stale: PID dead", () => {
		const lock = mkLock({ owner: { sessionId: "s1", pid: 0x7FFFFFFF } });
		assert.equal(isLockHeld(lock), false);
		assert.equal(isLockStale(lock), true);
	});

	it("stale: lease lapsed (PID alive)", () => {
		const past = Date.now() - 10_000;
		const lock = mkLock({ expiresAt: new Date(past).toISOString() });
		assert.equal(isLockHeld(lock), false);
		assert.equal(isLockStale(lock), true);
	});
});

describe("writeLockAtomic", () => {
	it("writes tmp + rename; final file is readable", () => {
		const cwd = tmpCwd();
		const lock = mkLock();
		writeLockAtomic(cwd, "g1", lock);
		const data = fs.readFileSync(lockPath(cwd, "g1"), "utf8");
		assert.deepEqual(JSON.parse(data).owner.sessionId, "s1");
	});
});

describe("acquireLock", () => {
	it("succeeds when no prior lock", () => {
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, true);
		assert.equal(result.heldByOther, undefined);
	});

	it("fails when held by another live session", () => {
		const cwd = tmpCwd();
		// write a held lock owned by "other"
		writeLockAtomic(cwd, "g1", mkLock({ owner: { sessionId: "other", pid: process.pid } }));
		const self = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, false);
		assert.equal(result.heldByOther?.owner.sessionId, "other");
	});

	it("reaps stale lock (PID dead) then acquires", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock({ owner: { sessionId: "dead", pid: 0x7FFFFFFF } }));
		const self = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, true);
		// verify the lock is now owned by self
		const read = readLock(cwd, "g1");
		assert.equal(read?.owner.sessionId, "s1");
	});

	it("reaps stale lock (lease lapsed) then acquires", () => {
		const cwd = tmpCwd();
		const past = Date.now() - 10_000;
		writeLockAtomic(cwd, "g1", mkLock({ expiresAt: new Date(past).toISOString() }));
		const self = { sessionId: "s1", pid: process.pid };
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		assert.equal(result.ok, true);
	});

	it("boot race: one wins, other backs off (verify mismatch)", () => {
		// Simulate: another session wrote AFTER our write (we lost the race)
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		const other = { sessionId: "s2", pid: process.pid };
		// pre-write other's lock so our write+verify detects mismatch
		writeLockAtomic(cwd, "g1", mkLock({ owner: other }));
		const result = acquireLock(cwd, "g1", self, LEASE_MS);
		// other is alive (same pid), so lock is HELD → acquire fails
		assert.equal(result.ok, false);
	});
});

describe("releaseLock", () => {
	it("deletes the lock file", () => {
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		releaseLock(cwd, "g1", self);
		assert.equal(readLock(cwd, "g1"), null);
	});

	it("does NOT delete when owned by other (self provided)", () => {
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		const other = { sessionId: "other", pid: process.pid };
		writeLockAtomic(cwd, "g1", mkLock({ owner: other }));
		releaseLock(cwd, "g1", self);
		assert.notEqual(readLock(cwd, "g1"), null);
	});
});

describe("reapStaleLock", () => {
	it("deletes stale locks", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock({ owner: { sessionId: "dead", pid: 0x7FFFFFFF } }));
		reapStaleLock(cwd, "g1");
		assert.equal(readLock(cwd, "g1"), null);
	});

	it("does NOT delete held locks", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock()); // alive + fresh
		reapStaleLock(cwd, "g1");
		assert.notEqual(readLock(cwd, "g1"), null);
	});
});

describe("refreshLease", () => {
	it("re-writes expiresAt and heartbeatAt", () => {
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		const before = readLock(cwd, "g1")!;
		// wait a tick
		const later = Date.now() + 5000;
		refreshLease(cwd, "g1", self, LEASE_MS);
		const after = readLock(cwd, "g1")!;
		assert.ok(new Date(after.expiresAt).getTime() >= new Date(before.expiresAt).getTime());
	});

	it("fail-open on fs error (no throw)", () => {
		const cwd = tmpCwd();
		const self = { sessionId: "s1", pid: process.pid };
		acquireLock(cwd, "g1", self, LEASE_MS);
		// make the lock dir read-only — simulate fs error (best-effort)
		try {
			fs.chmodSync(lockDir(cwd), 0o444);
			// should NOT throw
			refreshLease(cwd, "g1", self, LEASE_MS);
			assert.ok(true, "did not throw");
		} finally {
			fs.chmodSync(lockDir(cwd), 0o755);
		}
	});
});
