import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	lifecycleToolNamesForGoalStatus,
	ACTIVE_GOAL_TOOL_NAMES,
	PAUSED_GOAL_TOOL_NAMES,
	NO_FOCUSED_GOAL_TOOL_NAMES,
	PROPOSE_TWEAK_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	START_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	GOAL_WORK_TOOL_NAMES,
	GOAL_PROGRESS_TOOL_NAMES,
} from "../extensions/goal-tool-names.ts";

const DEAD_TOOLS = ["pause_goal", "abort_goal", "goal_question", "goal_questionnaire"] as const;

describe("tool name constants", () => {
	it("exports expected live names", () => {
		assert.equal(PROPOSE_TWEAK_TOOL_NAME, "propose_goal_tweak");
		assert.equal(PROPOSE_TASK_LIST_TOOL_NAME, "propose_task_list");
		assert.equal(COMPLETE_TASK_TOOL_NAME, "complete_task");
		assert.equal(SKIP_TASK_TOOL_NAME, "skip_task");
		assert.equal(SISYPHUS_STEP_TOOL_NAME, "step_complete");
		assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
		assert.equal(START_GOAL_TOOL_NAME, "start_goal");
		assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	});

	it("ACTIVE includes only live lifecycle + task tools", () => {
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes("get_goal"));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes("complete_goal"));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(PROPOSE_TWEAK_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(PROPOSE_TASK_LIST_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(COMPLETE_TASK_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(SKIP_TASK_TOOL_NAME));
	});

	it("ACTIVE excludes all dead tools", () => {
		for (const dead of DEAD_TOOLS) {
			assert.ok(!(ACTIVE_GOAL_TOOL_NAMES as readonly string[]).includes(dead),
				`${dead} must not be in ACTIVE_GOAL_TOOL_NAMES`);
		}
	});

	it("PAUSED excludes dead tools and skip/complete_task (no work)", () => {
		for (const dead of DEAD_TOOLS) {
			assert.ok(!(PAUSED_GOAL_TOOL_NAMES as readonly string[]).includes(dead));
		}
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes(COMPLETE_TASK_TOOL_NAME));
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes(SKIP_TASK_TOOL_NAME));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes("get_goal"));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes("complete_goal"));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes(PROPOSE_TWEAK_TOOL_NAME));
	});

	it("NO_FOCUSED_GOAL only has get_goal", () => {
		assert.deepEqual([...NO_FOCUSED_GOAL_TOOL_NAMES], ["get_goal"]);
	});

	it("GOAL_WORK_TOOL_NAMES and GOAL_PROGRESS_TOOL_NAMES exclude dead tools", () => {
		for (const dead of DEAD_TOOLS) {
			assert.ok(!(GOAL_WORK_TOOL_NAMES as readonly string[]).includes(dead),
				`${dead} must not be in GOAL_WORK_TOOL_NAMES`);
			assert.ok(!(GOAL_PROGRESS_TOOL_NAMES as readonly string[]).includes(dead),
				`${dead} must not be in GOAL_PROGRESS_TOOL_NAMES`);
		}
	});
});

describe("lifecycleToolNamesForGoalStatus", () => {
	it("drafting phase returns NO_FOCUSED regardless of status", () => {
		assert.deepEqual([...lifecycleToolNamesForGoalStatus("active", "drafting")], ["get_goal"]);
		assert.deepEqual([...lifecycleToolNamesForGoalStatus(null, "drafting")], ["get_goal"]);
	});

	it("tweakDrafting phase returns NO_FOCUSED", () => {
		assert.deepEqual([...lifecycleToolNamesForGoalStatus("active", "tweakDrafting")], ["get_goal"]);
	});

	it("active status returns ACTIVE set (no dead tools)", () => {
		const tools = lifecycleToolNamesForGoalStatus("active");
		assert.ok(tools.includes("complete_goal"));
		for (const dead of DEAD_TOOLS) {
			assert.ok(!tools.includes(dead));
		}
	});

	it("paused status returns PAUSED set (no dead tools)", () => {
		const tools = lifecycleToolNamesForGoalStatus("paused");
		assert.ok(tools.includes("complete_goal"));
		for (const dead of DEAD_TOOLS) {
			assert.ok(!tools.includes(dead));
		}
	});

	it("complete/null/undefined status returns NO_FOCUSED", () => {
		assert.deepEqual([...lifecycleToolNamesForGoalStatus("complete")], ["get_goal"]);
		assert.deepEqual([...lifecycleToolNamesForGoalStatus(null)], ["get_goal"]);
		assert.deepEqual([...lifecycleToolNamesForGoalStatus(undefined)], ["get_goal"]);
	});

	it("default phase is normal", () => {
		assert.deepEqual(
			[...lifecycleToolNamesForGoalStatus("active")],
			[...lifecycleToolNamesForGoalStatus("active", "normal")],
		);
	});
});

describe("start_goal tool name", () => {
	it("exports START_GOAL_TOOL_NAME as start_goal", () => {
		assert.equal(START_GOAL_TOOL_NAME, "start_goal");
	});

	it("start_goal is a member of GOAL_WORK_TOOL_NAMES", () => {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes("start_goal"), "start_goal should be in GOAL_WORK_TOOL_NAMES");
	});

	it("start_goal is NOT in any lifecycle surface set", () => {
		assert.ok(!ACTIVE_GOAL_TOOL_NAMES.includes("start_goal"));
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes("start_goal"));
		assert.ok(!NO_FOCUSED_GOAL_TOOL_NAMES.includes("start_goal"));
	});
});
