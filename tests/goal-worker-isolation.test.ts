/**
 * Goal worker isolation tests.
 *
 * Verifies that worker sessions (PI_TEAMS_WORKER=1) do NOT inherit goal focus
 * from the leader's branch chain, while leader sessions behave unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	cleanupTimers,
} from "./_harness.ts";

let _lastPi: ReturnType<typeof createMockPi> | null = null;
let _lastCwd: string | null = null;
let _origEnv: string | undefined;

function tmpWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-worker-"));
}

function setupPi(cwd: string): ReturnType<typeof createMockPi> {
	const pi = createMockPi({ cwd });
	_lastPi = pi;
	_lastCwd = cwd;
	return pi;
}

afterEach(async () => {
	if (_lastPi && _lastCwd) {
		await cleanupTimers(_lastPi, _lastCwd);
	}
	// Restore env
	if (_origEnv === undefined) {
		delete process.env.PI_TEAMS_WORKER;
	} else {
		process.env.PI_TEAMS_WORKER = _origEnv;
	}
});

describe("goal worker isolation", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = tmpWorkspace();
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		_origEnv = process.env.PI_TEAMS_WORKER;
	});

	function writeGoalFile(goalId: string, objective: string): void {
		const goalRecord = {
			version: 3,
			id: goalId,
			status: "active",
			sisyphus: false,
			autoContinue: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			objective: objective,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			activePath: `.pi/goals/active_goal_20260101_${goalId}.md`,
		};
		const content = `${JSON.stringify(goalRecord, null, 2)}

# Goal Prompt

${objective}

## Progress

- Status: active
- Auto-continue: off
- Sisyphus mode: no
`;
		fs.writeFileSync(path.join(cwd, ".pi", "goals", `active_goal_20260101_${goalId}.md`), content);
	}

	it("worker session does not inherit goal focus from branch entries", async () => {
		process.env.PI_TEAMS_WORKER = "1";

		const goalId = "test-goal-worker-001";
		writeGoalFile(goalId, "Test goal for worker isolation");

		// Load extension as worker with branch entries simulating leader's focus
		const pi = createMockPi({ cwd });
		goalExtension(pi);

		const branchEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: goalId, reason: "selected" } },
			{ type: "custom", customType: "pi-goal-state", data: { goal: { id: goalId, status: "active", objective: "Test", sisyphus: false, autoContinue: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", usage: { tokensUsed: 0, activeSeconds: 0 }, stopReason: undefined } } },
		];

		const ctx = createMockCtx(pi, {
			cwd,
			sessionManager: {
				getBranch: () => branchEntries,
				getSessionId: () => "worker-session-1",
				getSessionFile: () => "/tmp/worker-session.jsonl",
				getLeafId: () => "worker-leaf",
			},
		});

		// Emit session_start to trigger loadState
		await emit(pi, ctx, "session_start", { reason: "new" });

		// Worker should have NO focused goal — get_goal tool returns null
		const result = await invokeTool(pi, ctx, "get_goal", {});
		const text = (result as any)?.content?.[0]?.text ?? "";
		// get_goal returns "No goal is set" or similar when no goal is focused
		assert.ok(
			text.includes("No goal") || text.includes("No active goal") || text.includes("null") || text === "" || text.includes("unfocused"),
			`Worker should have no focused goal, got: ${text}`,
		);

		_lastPi = pi;
		_lastCwd = cwd;
	});

	it("leader session inherits goal focus from branch entries (backward compatible)", async () => {
		delete process.env.PI_TEAMS_WORKER;

		const goalId = "test-goal-leader-001";
		writeGoalFile(goalId, "Test goal for leader inheritance");

		// Load extension as leader (no PI_TEAMS_WORKER)
		const pi = createMockPi({ cwd });
		goalExtension(pi);

		const branchEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: goalId, reason: "selected" } },
		];

		const ctx = createMockCtx(pi, {
			cwd,
			sessionManager: {
				getBranch: () => branchEntries,
				getSessionId: () => "leader-session-1",
				getSessionFile: () => "/tmp/leader-session.jsonl",
				getLeafId: () => "leader-leaf",
			},
		});

		await emit(pi, ctx, "session_start", { reason: "new" });

		// Leader should inherit the focus — get_goal returns the goal
		// NOTE (add-goal-focus-locking, LD3): this test now exercises TRUE focus-entry
		// inheritance (branch entry carries version:1 so normalizeGoalFocusEntry
		// accepts it). Explicit focus entries always win regardless of session
		// reason / lock state. The prior data lacked `version` and was silently
		// passing via the old auto-focus-on-any-reason path, which LD3 removes.
		const result = await invokeTool(pi, ctx, "get_goal", {});
		const text = (result as any)?.content?.[0]?.text ?? "";
		assert.ok(
			text.includes(goalId) || text.includes("leader inheritance"),
			`Leader should have focused goal ${goalId}, got: ${text}`,
		);

		_lastPi = pi;
		_lastCwd = cwd;
	});

	it("session_tree event in worker session does not inherit goal", async () => {
		process.env.PI_TEAMS_WORKER = "1";

		const goalId = "test-goal-tree-001";
		writeGoalFile(goalId, "Test goal for session_tree worker");

		const pi = createMockPi({ cwd });
		goalExtension(pi);

		const branchEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: goalId, reason: "selected" } },
		];

		const ctx = createMockCtx(pi, {
			cwd,
			sessionManager: {
				getBranch: () => branchEntries,
				getSessionId: () => "worker-session-2",
				getSessionFile: () => "/tmp/worker-session-2.jsonl",
				getLeafId: () => "worker-leaf-2",
			},
		});

		// session_tree also calls loadState — worker isolation applies
		await emit(pi, ctx, "session_tree", {});

		// Worker should still have no focused goal
		const result = await invokeTool(pi, ctx, "get_goal", {});
		const text = (result as any)?.content?.[0]?.text ?? "";
		assert.ok(
			text.includes("No goal") || text.includes("No active goal") || text.includes("null") || text === "" || text.includes("unfocused"),
			`Worker session_tree should not inherit goal, got: ${text}`,
		);

		_lastPi = pi;
		_lastCwd = cwd;
	});
});
