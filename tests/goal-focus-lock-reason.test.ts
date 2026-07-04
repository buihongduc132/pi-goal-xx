/**
 * RED tests for add-goal-focus-locking — Unit D: resolveSessionFocus reason gating.
 *
 * These tests assert NEW behavior (auto-focus restricted to reason: "resume" only,
 * locked-by-other blocks auto-focus) that the current resolveSessionFocus does NOT
 * implement. All should FAIL until GREEN phase.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	goalPoolFromGoals,
	resolveSessionFocus,
} from "../extensions/goal-pool.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { acquireLock } from "../extensions/goal-lock.ts";

function mkGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	const base = createGoal({ objective: "do stuff", autoContinue: false, sisyphus: false }, 1_700_000_000_000);
	return { ...base, ...over };
}

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-reason-test-"));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const SELF = { sessionId: "self", pid: process.pid };

describe("resolveSessionFocus reason gating (LD3: resume only)", () => {
	it("resume + 1 open + unlocked → focuses", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: "resume", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, "solo");
	});

	it("reload + 1 open → does NOT auto-focus (LD3 literal — reload excluded)", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: "reload", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null, "reload must NOT auto-focus under default (LD3 'resume only' verbatim)");
	});

	it("new + 1 open → does NOT auto-focus", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: "new", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null);
	});

	it("startup + 1 open → does NOT auto-focus", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: "startup", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null);
	});

	it("fork + 1 open → does NOT auto-focus", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: "fork", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null);
	});

	it("null (tree nav) + 1 open → does NOT auto-focus", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		const result = resolveSessionFocus({ pool, autoFocusReason: null, cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null);
	});
});

describe("resolveSessionFocus — locked by other blocks auto-focus", () => {
	it("resume + 1 open + locked-by-other → unfocused", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		const cwd = tmpCwd();
		// another session holds the lock
		acquireLock(cwd, "solo", { sessionId: "other", pid: process.pid }, 180_000);
		const result = resolveSessionFocus({ pool, autoFocusReason: "resume", cwd, selfSessionId: SELF.sessionId });
		assert.equal(result, null, "must not auto-focus a goal locked by another live session");
	});
});

describe("resolveSessionFocus — explicit branch entry wins at resolution", () => {
	it("branch focus entry + locked by other → STILL focuses (explicit intent)", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "active" })]);
		const cwd = tmpCwd();
		acquireLock(cwd, "a", { sessionId: "other", pid: process.pid }, 180_000);
		const result = resolveSessionFocus({
			pool,
			autoFocusReason: "resume",
			cwd,
			selfSessionId: SELF.sessionId,
			focusEntry: { version: 1, focusedGoalId: "a", reason: "selected" },
		});
		assert.equal(result, "a", "explicit branch entry wins over lock at resolution time");
	});
});
