/**
 * goalHash: pure hash function + surfaces.
 *
 * Spec: flow/plans/goal-continuation-throttle-hash.md
 *
 * Contract under test:
 *  - goalHash(goal) → 8-char lowercase hex string (sha256 prefix).
 *  - STABLE: identical goals except usage.tokensUsed / usage.activeSeconds /
 *    updatedAt → same hash.
 *  - SENSITIVE: changing objective OR taskList.tasks[0].status OR status OR
 *    verificationContract OR sisyphus → different hash.
 *  - continuationPrompt(goal) output contains exactly one line matching
 *    /^goalHash: [0-9a-f]{8}$/ and value === goalHash(goal).
 *  - continuationPrompt still contains "[GOAL CHECKPOINT goalId=" marker.
 *  - serializeGoalFile JSON meta block contains "goalHash": "<8hex>" equal
 *    to goalHash(goal).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { continuationPrompt } from "../extensions/prompts/goal-prompts.ts";
import { serializeGoalFile } from "../extensions/storage/goal-files.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";

let goalHash: (goal: GoalRecord) => string;

async function loadGoalHash(): Promise<(goal: GoalRecord) => string> {
	const mod = await import("../extensions/goal-record.ts");
	return (mod as Record<string, unknown>).goalHash as (goal: GoalRecord) => string;
}

function mkGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	const base = createGoal(
		{ objective: "build the thing", autoContinue: true, sisyphus: false },
		1_700_000_000_000,
	);
	return {
		...base,
		taskList: {
			tasks: [
				{ id: "T-1", title: "first task", status: "pending" },
				{ id: "T-2", title: "second task", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: new Date(1_700_000_000_000).toISOString(),
		},
		verificationContract: "tests must pass",
		...over,
	};
}

const HEX8 = /^[0-9a-f]{8}$/;

describe("goalHash — shape", () => {
	it("returns an 8-char lowercase hex string", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		const h = goalHash(goal);
		assert.strictEqual(typeof h, "string");
		assert.ok(HEX8.test(h));
	});

	it("is stable across calls for the same goal", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		assert.strictEqual(goalHash(goal), goalHash(goal));
	});
});

describe("goalHash — stability (usage/updatedAt changes do NOT affect hash)", () => {
	it("ignores usage.tokensUsed changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal({ usage: { tokensUsed: 999999, activeSeconds: a.usage.activeSeconds } });
		assert.strictEqual(goalHash(a), goalHash(b));
	});

	it("ignores usage.activeSeconds changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal({ usage: { tokensUsed: a.usage.tokensUsed, activeSeconds: 999999 } });
		assert.strictEqual(goalHash(a), goalHash(b));
	});

	it("ignores updatedAt changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal({ updatedAt: new Date(1_800_000_000_000).toISOString() });
		assert.strictEqual(goalHash(a), goalHash(b));
	});

	it("ignores combined usage + updatedAt drift", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal({
			usage: { tokensUsed: 12345, activeSeconds: 6789 },
			updatedAt: new Date(1_900_000_000_000).toISOString(),
		});
		assert.strictEqual(goalHash(a), goalHash(b));
	});
});

describe("goalHash — sensitivity (semantic changes DO affect hash)", () => {
	it("changes when objective changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal({ objective: "build a DIFFERENT thing" });
		assert.notStrictEqual(goalHash(a), goalHash(b));
	});

	it("changes when taskList.tasks[0].status changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal();
		const b = mkGoal();
		b.taskList!.tasks[0] = { ...b.taskList!.tasks[0], status: "complete" };
		assert.notStrictEqual(goalHash(a), goalHash(b));
	});

	it("changes when status changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal({ status: "active" });
		const b = mkGoal({ status: "paused" });
		assert.notStrictEqual(goalHash(a), goalHash(b));
	});

	it("changes when verificationContract changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal({ verificationContract: "tests must pass" });
		const b = mkGoal({ verificationContract: "tests must pass AND lint clean" });
		assert.notStrictEqual(goalHash(a), goalHash(b));
	});

	it("changes when sisyphus changes", async () => {
		goalHash = await loadGoalHash();
		const a = mkGoal({ sisyphus: false });
		const b = mkGoal({ sisyphus: true });
		assert.notStrictEqual(goalHash(a), goalHash(b));
	});
});

describe("goalHash — continuationPrompt surface", () => {
	it("contains exactly one line matching /^goalHash: [0-9a-f]{8}$/", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		const out = continuationPrompt(goal);
		const matches = out.match(/^goalHash: [0-9a-f]{8}$/gm);
		assert.notStrictEqual(matches, null);
		assert.strictEqual(matches!.length, 1);
	});

	it("the hash value in the prompt equals goalHash(goal)", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		const out = continuationPrompt(goal);
		const line = out.match(/^goalHash: ([0-9a-f]{8})$/m);
		assert.notStrictEqual(line, null);
		assert.strictEqual(line![1], goalHash(goal));
	});

	it("still contains the [GOAL CHECKPOINT goalId= marker", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		const out = continuationPrompt(goal);
		assert.ok(out.includes(`[GOAL CHECKPOINT goalId=${goal.id}]`));
	});
});

describe("goalHash — serializeGoalFile surface", () => {
	it("JSON meta block contains goalHash equal to goalHash(goal)", async () => {
		goalHash = await loadGoalHash();
		const goal = mkGoal();
		const serialized = serializeGoalFile(goal);
		// The file starts with a JSON meta block (before the first blank line).
		const jsonBlock = serialized.split("\n\n")[0];
		const parsed = JSON.parse(jsonBlock);
		assert.strictEqual(typeof parsed.goalHash, "string");
		assert.ok(HEX8.test(parsed.goalHash));
		assert.strictEqual(parsed.goalHash, goalHash(goal));
	});
});
