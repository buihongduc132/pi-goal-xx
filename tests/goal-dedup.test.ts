import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	GOALS_DIR,
	findDuplicateActiveGoal,
	writeActiveGoalFile,
	type GoalFileContext,
} from "../extensions/storage/goal-files.ts";
import { createGoal } from "../extensions/goal-record.ts";

function makeTmpCtx(): { ctx: GoalFileContext; root: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-dedup-"));
	return { ctx: { cwd: root }, root };
}

function cleanup(root: string) {
	fs.rmSync(root, { recursive: true, force: true });
}

describe("findDuplicateActiveGoal", () => {
	let tmp: { ctx: GoalFileContext; root: string };

	beforeEach(() => {
		tmp = makeTmpCtx();
	});

	afterEach(() => {
		cleanup(tmp.root);
	});

	it("returns null when no active goals exist", () => {
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.equal(result, null);
	});

	it("returns null when no goals match the objective", () => {
		const goal = createGoal({ objective: "Something else", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.equal(result, null);
	});

	it("finds a goal with the exact same objective", () => {
		const goal = createGoal({ objective: "Do the thing", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.ok(result);
		assert.equal(result.objective, "Do the thing");
		assert.equal(result.id, goal.id);
	});

	it("matches objectives with trimmed whitespace", () => {
		const goal = createGoal({ objective: "  Do the thing  ", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.ok(result);
		assert.equal(result.id, goal.id);
	});

	it("matches objectives with collapsed internal whitespace", () => {
		const goal = createGoal({ objective: "Do   the   thing", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.ok(result);
		assert.equal(result.id, goal.id);
	});

	it("does NOT match when objectives differ (case-sensitive)", () => {
		const goal = createGoal({ objective: "do the thing", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.equal(result, null);
	});

	it("excludes the current goal by ID (for re-creation scenarios)", () => {
		const goal1 = createGoal({ objective: "Do the thing", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal1);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing", goal1.id);
		assert.equal(result, null);
	});

	it("finds duplicate among multiple active goals", () => {
		const goal1 = createGoal({ objective: "First goal", autoContinue: true, sisyphus: false });
		const goal2 = createGoal({ objective: "Do the thing", autoContinue: true, sisyphus: false });
		const goal3 = createGoal({ objective: "Third goal", autoContinue: true, sisyphus: false });
		writeActiveGoalFile(tmp.ctx, goal1);
		writeActiveGoalFile(tmp.ctx, goal2);
		writeActiveGoalFile(tmp.ctx, goal3);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.ok(result);
		assert.equal(result.id, goal2.id);
	});

	it("does NOT match completed goals", () => {
		const goal = createGoal({ objective: "Do the thing", autoContinue: true, sisyphus: false });
		goal.status = "complete";
		writeActiveGoalFile(tmp.ctx, goal);
		// readActiveGoalFiles filters out completed goals, so findDuplicateActiveGoal should too
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.equal(result, null);
	});

	it("does NOT match paused goals with different objective", () => {
		const goal = createGoal({ objective: "Something else", autoContinue: true, sisyphus: false });
		goal.status = "paused";
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		assert.equal(result, null);
	});

	it("matches paused goals with same objective (they are still open)", () => {
		const goal = createGoal({ objective: "Do the thing", autoContinue: true, sisyphus: false });
		goal.status = "paused";
		writeActiveGoalFile(tmp.ctx, goal);
		const result = findDuplicateActiveGoal(tmp.ctx, "Do the thing");
		// paused goals are not filtered by readActiveGoalFiles (only complete is filtered)
		// so this should match
		assert.ok(result);
		assert.equal(result.id, goal.id);
	});
});
