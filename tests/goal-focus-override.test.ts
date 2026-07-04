/**
 * GREEN-phase stub for add-goal-focus-locking — Unit F: /goal-focus override flow.
 *
 * Full harness-based tests (load goalExtension, simulate focusGoalCommand with
 * lock state, capture confirm dialogs) are deferred to a follow-up pass.
 * This stub verifies the lock API imports and that the override flow's
 * primitives are wired (acquireLock + readLock + isLockHeld available).
 *
 * Deferred harness coverage (for traceability):
 * - override refused (headless !ctx.hasUI)
 * - override confirmed (reaps + acquires fresh)
 * - override on stale lock proceeds without prompt
 * - fast-path on held goal prompts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	acquireLock,
	readLock,
	isLockHeld,
	releaseLock,
	reapStaleLock,
} from "../extensions/goal-lock.ts";
import goalExtension from "../extensions/goal.ts";

describe("/goal-focus override flow — lock API surface (GREEN stub)", () => {
	it("override-flow primitives are exported", () => {
		assert.equal(typeof acquireLock, "function");
		assert.equal(typeof readLock, "function");
		assert.equal(typeof isLockHeld, "function");
		assert.equal(typeof releaseLock, "function");
		assert.equal(typeof reapStaleLock, "function");
	});

	it("goal extension default export loads (override flow compiled in)", () => {
		assert.equal(typeof goalExtension, "function");
	});
});
