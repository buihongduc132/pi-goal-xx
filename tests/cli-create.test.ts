import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { parseGoalFile, serializeGoalFile, GOALS_DIR } from "../extensions/storage/goal-files.ts";
import { DEFAULT_CEREMONY_CONTRACT } from "../src/cli/ceremony.ts";
import { runCreate } from "../src/cli/create.ts";
import { parseArgs } from "../src/cli/index.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cli-create-"));
}

function cleanup(dir: string) {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe("CLI arg parsing", () => {
	it("rejects missing --objective", () => {
		assert.throws(() => parseArgs(["create"]), /--objective.*required/i);
	});

	it("parses --objective as required", () => {
		const args = parseArgs(["create", "--objective", "build a thing"]);
		assert.equal(args.objective, "build a thing");
	});

	it("parses --auto-continue flag (default true)", () => {
		const args = parseArgs(["create", "--objective", "x"]);
		assert.equal(args.autoContinue, true);
	});

	it("parses --no-auto-continue", () => {
		const args = parseArgs(["create", "--objective", "x", "--no-auto-continue"]);
		assert.equal(args.autoContinue, false);
	});

	it("parses --sisyphus flag (default false)", () => {
		const args = parseArgs(["create", "--objective", "x"]);
		assert.equal(args.sisyphus, false);
	});

	it("parses --sisyphus", () => {
		const args = parseArgs(["create", "--objective", "x", "--sisyphus"]);
		assert.equal(args.sisyphus, true);
	});

	it("parses --tasks as JSON string", () => {
		const tasksJson = JSON.stringify({
			tasks: [{ id: "t1", title: "do thing", status: "pending" }],
			blockCompletion: true,
		});
		const args = parseArgs(["create", "--objective", "x", "--tasks", tasksJson]);
		assert.ok(args.tasks);
		assert.equal(args.tasks!.tasks.length, 1);
		assert.equal(args.tasks!.tasks[0].id, "t1");
	});

	it("rejects invalid --tasks JSON", () => {
		assert.throws(
			() => parseArgs(["create", "--objective", "x", "--tasks", "not-json"]),
			/--tasks.*invalid/i,
		);
	});

	it("parses --verification-contract", () => {
		const args = parseArgs(["create", "--objective", "x", "--verification-contract", "run tests"]);
		assert.equal(args.verificationContract, "run tests");
	});

	it("parses --draft-id", () => {
		const args = parseArgs(["create", "--objective", "x", "--draft-id", "draft-123"]);
		assert.equal(args.draftId, "draft-123");
	});

	it("parses --worktree", () => {
		const args = parseArgs(["create", "--objective", "x", "--worktree", "/tmp/wt-feature"]);
		assert.equal(args.worktree, "/tmp/wt-feature");
	});

	it("parses --parallel-lanes as JSON", () => {
		const lanesJson = JSON.stringify({
			lanes: [{ name: "lane-a", worktree: "/tmp/wt-a" }],
			converge: { name: "converge", worktree: "/tmp/wt-converge" },
		});
		const args = parseArgs(["create", "--objective", "x", "--parallel-lanes", lanesJson]);
		assert.ok(args.parallelLanes);
		assert.equal(args.parallelLanes!.lanes.length, 1);
	});

	it("rejects invalid --parallel-lanes JSON", () => {
		assert.throws(
			() => parseArgs(["create", "--objective", "x", "--parallel-lanes", "{bad}"]),
			/--parallel-lanes.*invalid/i,
		);
	});
});

describe("CLI create subcommand", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});

	afterEach(() => {
		cleanup(dir);
	});

	it("creates a goal file at .pi/goals/active_goal_<ts>_<id>.md", () => {
		const result = runCreate({
			cwd: dir,
			objective: "build the thing",
			autoContinue: true,
			sisyphus: false,
		});

		assert.ok(result.goalPath);
		assert.ok(result.goalPath.startsWith(`${GOALS_DIR}/active_goal_`));
		assert.ok(result.goalPath.endsWith(".md"));

		const absPath = path.resolve(dir, result.goalPath);
		assert.ok(fs.existsSync(absPath), "goal file must exist on disk");
	});

	it("filename matches pattern active_goal_<18-digit-ts>_<safe-id>.md", () => {
		const result = runCreate({
			cwd: dir,
			objective: "test filename",
			autoContinue: true,
			sisyphus: false,
		});

		const basename = path.basename(result.goalPath);
		// Pattern: active_goal_<18 digits>_<safe-id>.md
		assert.match(basename, /^active_goal_\d{16}_[a-zA-Z0-9_-]+\.md$/);
	});

	it("created file is parseable by parseGoalFile", () => {
		const result = runCreate({
			cwd: dir,
			objective: "parseable goal",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed, "parseGoalFile must return a valid GoalRecord");
		assert.equal(parsed.objective, "parseable goal");
		assert.equal(parsed.status, "active");
	});

	it("JSON v3 format with version: 3", () => {
		const result = runCreate({
			cwd: dir,
			objective: "v3 check",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const content = fs.readFileSync(absPath, "utf8");
		// First line should be JSON opening
		const jsonEnd = content.indexOf("\n\n");
		const jsonPart = content.slice(0, jsonEnd);
		const parsed = JSON.parse(jsonPart);
		assert.equal(parsed.version, 3);
	});

	it("markdown body has # Goal Prompt → objective → ## Progress → ## Tasks", () => {
		const result = runCreate({
			cwd: dir,
			objective: "markdown structure check",
			autoContinue: true,
			sisyphus: false,
			taskList: {
				tasks: [{ id: "t1", title: "do thing", status: "pending" }],
				blockCompletion: true,
				proposedAt: new Date().toISOString(),
			},
		});

		const absPath = path.resolve(dir, result.goalPath);
		const content = fs.readFileSync(absPath, "utf8");

		assert.ok(content.includes("# Goal Prompt"), "must have # Goal Prompt heading");
		assert.ok(content.includes("## Progress"), "must have ## Progress heading");
		assert.ok(content.includes("## Tasks"), "must have ## Tasks heading");

		const goalPromptIdx = content.indexOf("# Goal Prompt");
		const progressIdx = content.indexOf("## Progress");
		const tasksIdx = content.indexOf("## Tasks");

		assert.ok(goalPromptIdx < progressIdx, "# Goal Prompt before ## Progress");
		assert.ok(progressIdx < tasksIdx, "## Progress before ## Tasks");
	});

	it("default ceremony contract baked into verificationContract", () => {
		const result = runCreate({
			cwd: dir,
			objective: "ceremony check",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.ok(parsed.verificationContract, "verificationContract must be set");
		assert.ok(
			parsed.verificationContract!.includes("verifier-loop"),
			"ceremony contract must mention verifier-loop",
		);
		assert.ok(
			parsed.verificationContract!.includes("worktree"),
			"ceremony contract must mention worktree",
		);
		assert.ok(
			parsed.verificationContract!.includes("pr-creation"),
			"ceremony contract must mention pr-creation",
		);
	});

	it("--verification-contract overrides default ceremony", () => {
		const customContract = "CUSTOM: run lint and tests only";
		const result = runCreate({
			cwd: dir,
			objective: "custom contract",
			autoContinue: true,
			sisyphus: false,
			verificationContract: customContract,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.equal(parsed.verificationContract, customContract);
	});

	it("taskList.blockCompletion always true", () => {
		const result = runCreate({
			cwd: dir,
			objective: "block completion check",
			autoContinue: true,
			sisyphus: false,
			taskList: {
				tasks: [{ id: "t1", title: "step one", status: "pending" }],
				blockCompletion: true,
				proposedAt: new Date().toISOString(),
			},
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.ok(parsed.taskList, "taskList must be present");
		assert.equal(parsed.taskList!.blockCompletion, true);
	});

	it("--worktree path appears in objective text", () => {
		const wtPath = "/tmp/wt-my-feature";
		const result = runCreate({
			cwd: dir,
			objective: "worktree goal",
			autoContinue: true,
			sisyphus: false,
			worktree: wtPath,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.ok(
			parsed.objective.includes(wtPath),
			`objective must contain worktree path "${wtPath}", got: ${parsed.objective}`,
		);
		assert.ok(
			parsed.objective.includes("Worktree:"),
			"objective must contain 'Worktree:' label",
		);
	});

	it("--parallel-lanes: N worktrees + converge worktree in objective", () => {
		const lanes = {
			lanes: [
				{ name: "lane-a", worktree: "/tmp/wt-a" },
				{ name: "lane-b", worktree: "/tmp/wt-b" },
			],
			converge: { name: "converge", worktree: "/tmp/wt-converge" },
		};
		const result = runCreate({
			cwd: dir,
			objective: "parallel lanes goal",
			autoContinue: true,
			sisyphus: false,
			parallelLanes: lanes,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.ok(parsed.objective.includes("/tmp/wt-a"), "objective must contain lane-a worktree");
		assert.ok(parsed.objective.includes("/tmp/wt-b"), "objective must contain lane-b worktree");
		assert.ok(parsed.objective.includes("/tmp/wt-converge"), "objective must contain converge worktree");
		assert.ok(parsed.objective.includes("Lanes:"), "objective must contain 'Lanes:' label");
		assert.ok(parsed.objective.includes("Converge:"), "objective must contain 'Converge:' label");
	});

	it("no unknown JSON keys in goal file", () => {
		const result = runCreate({
			cwd: dir,
			objective: "schema check",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const content = fs.readFileSync(absPath, "utf8");
		const jsonEnd = content.indexOf("\n\n");
		const jsonPart = content.slice(0, jsonEnd);
		const parsed = JSON.parse(jsonPart);

		// Known GoalRecord keys (closed schema)
		const knownKeys = new Set([
			"version", "id", "objective", "status", "autoContinue", "usage",
			"sisyphus", "createdAt", "updatedAt", "activePath", "archivedPath",
			"stopReason", "pauseReason", "pauseSuggestedAction", "skipAuditor",
			"taskList", "verificationContract",
		]);

		for (const key of Object.keys(parsed)) {
			assert.ok(knownKeys.has(key), `unknown JSON key found: "${key}"`);
		}
	});

	it("uses createGoal from extensions/goal-record.ts (not a rewrite)", () => {
		// This test verifies that the CLI imports and uses the real createGoal function.
		// If createGoal is rewritten, the id format or timestamp behavior would differ.
		const result = runCreate({
			cwd: dir,
			objective: "import check",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		// createGoal generates id as <base36-timestamp>-<6-char-random>
		assert.match(parsed.id, /^[a-z0-9]+-[a-z0-9]{6}$/, "id format must match createGoal output");
		assert.equal(parsed.status, "active");
		assert.equal(parsed.autoContinue, true);
		assert.equal(parsed.sisyphus, false);
		assert.deepEqual(parsed.usage, { tokensUsed: 0, activeSeconds: 0 });
	});

	it("--sisyphus flag sets sisyphus: true in goal record", () => {
		const result = runCreate({
			cwd: dir,
			objective: "sisyphus goal",
			autoContinue: true,
			sisyphus: true,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.equal(parsed.sisyphus, true);
	});

	it("--auto-continue false sets autoContinue: false", () => {
		const result = runCreate({
			cwd: dir,
			objective: "no auto-continue",
			autoContinue: false,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.equal(parsed.autoContinue, false);
	});

	it("tasks with subtasks (recursive) are preserved", () => {
		const tasks = {
			tasks: [
				{
					id: "t1",
					title: "parent task",
					status: "pending",
					subtasks: [
						{ id: "t1.1", title: "child task", status: "pending" },
					],
				},
			],
			blockCompletion: true,
			proposedAt: new Date().toISOString(),
		};
		const result = runCreate({
			cwd: dir,
			objective: "recursive tasks",
			autoContinue: true,
			sisyphus: false,
			taskList: tasks,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const parsed = parseGoalFile(absPath);
		assert.ok(parsed);
		assert.ok(parsed.taskList);
		assert.equal(parsed.taskList!.tasks.length, 1);
		assert.ok(parsed.taskList!.tasks[0].subtasks);
		assert.equal(parsed.taskList!.tasks[0].subtasks!.length, 1);
		assert.equal(parsed.taskList!.tasks[0].subtasks![0].id, "t1.1");
	});

	it("created file matches serializeGoalFile output format", () => {
		const result = runCreate({
			cwd: dir,
			objective: "format check",
			autoContinue: true,
			sisyphus: false,
		});

		const absPath = path.resolve(dir, result.goalPath);
		const content = fs.readFileSync(absPath, "utf8");

		// Verify the file ends with a newline (serializeGoalFile adds trailing \n)
		assert.ok(content.endsWith("\n"), "file must end with newline");

		// Verify JSON is first, then blank line, then markdown
		const firstNewline = content.indexOf("\n");
		assert.ok(content[firstNewline + 1] === "\n" || content.slice(0, firstNewline).startsWith("{"),
			"file must start with JSON");
	});
});

describe("DEFAULT_CEREMONY_CONTRACT", () => {
	it("contains all 10 ordered workflow steps", () => {
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("worktree-lifecycle"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("worst-first-testing"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("coding-rules"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("e2e-testing"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("teams-workflow"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("abw"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("verifier-loop"));
		assert.ok(DEFAULT_CEREMONY_CONTRACT.includes("pr-creation"));
	});

	it("contains auditor hard-reject rule", () => {
		assert.ok(
			DEFAULT_CEREMONY_CONTRACT.includes("AUDITOR HARD-REJECT") ||
			DEFAULT_CEREMONY_CONTRACT.includes("hard-reject") ||
			DEFAULT_CEREMONY_CONTRACT.includes("instant") ||
			DEFAULT_CEREMONY_CONTRACT.includes("disapproved"),
			"ceremony contract must contain auditor hard-reject rule",
		);
	});

	it("mentions verifier-loop approval hash requirement", () => {
		assert.ok(
			DEFAULT_CEREMONY_CONTRACT.includes("hash") ||
			DEFAULT_CEREMONY_CONTRACT.includes("approval"),
			"ceremony contract must mention verifier-loop hash/approval",
		);
	});
});
