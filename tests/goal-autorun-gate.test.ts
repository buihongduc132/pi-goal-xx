/**
 * RED tests for add-goal-focus-locking — Unit E: auto-run chokepoint at
 * queueContinuation + acquire-at-transition.
 *
 * These use the extension harness pattern (like goal-extension.test.ts) to load
 * the extension and capture handlers. They import from goal-lock.ts to set up
 * lock state. Since goal-lock.ts doesn't exist yet, all tests RED via import error.
 *
 * GREEN phase will implement:
 * - chokepoint guard at top of queueContinuation (no self-lock → no continuation)
 * - acquireLock after loadState in session_start before queueContinuation
 * - acquireLock in handleGoalResume (self-heal after pause+lapse)
 * - releaseLock+acquireLock in setFocusedGoalId
 * - acquireLock in replaceGoal
 * - state.goal setter instrumentation for setGoal(null) release
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireLock, releaseLock, readLock } from "../extensions/goal-lock.ts";
import goalExtension from "../extensions/goal.ts";

describe("auto-run chokepoint (TODO: harness tests — RED stub)", () => {
	it("RED stub: imports from goal-lock.ts (fails until GREEN)", () => {
		// This test exists to anchor the RED commit. Full harness tests
		// will be written in GREEN phase once goal-lock.ts exists.
		assert.fail("RED: goal-lock.ts not yet implemented");
	});
});
