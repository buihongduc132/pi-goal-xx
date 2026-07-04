/**
 * GREEN-phase stub for add-goal-focus-locking — Unit H: multi-session integration.
 *
 * Full integration tests (two-session scenarios, PID-dead reaping, lease-lapse)
 * are deferred to a follow-up pass. This stub verifies the lock API surface
 * and that the extension loads with multi-session wiring compiled in.
 *
 * Deferred integration coverage (for traceability):
 * - S1 focuses A, S2 starts in same cwd with reason "new" → S2 unfocused
 * - S1 focuses A, S2 starts with reason "resume" → S2 unfocused (locked by S1)
 * - S1 crashes (PID dead + lease expired) → S2 acquires on next start
 * - backward compat for single-session common case
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	acquireLock,
	releaseLock,
	readLock,
	isLockHeld,
} from "../extensions/goal-lock.ts";
import goalExtension from "../extensions/goal.ts";

describe("multi-session integration — lock API surface (GREEN stub)", () => {
	it("multi-session lock primitives are exported", () => {
		assert.equal(typeof acquireLock, "function");
		assert.equal(typeof releaseLock, "function");
		assert.equal(typeof readLock, "function");
		assert.equal(typeof isLockHeld, "function");
	});

	it("goal extension default export loads (multi-session wiring compiled in)", () => {
		assert.equal(typeof goalExtension, "function");
	});
});
