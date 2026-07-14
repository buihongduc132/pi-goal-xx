import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	lifecycleToolNamesForGoalStatus,
	isQuestionLikeToolName,
	ACTIVE_GOAL_TOOL_NAMES,
	PAUSED_GOAL_TOOL_NAMES,
	NO_FOCUSED_GOAL_TOOL_NAMES,
	QUESTION_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	ABORT_GOAL_TOOL_NAME,
	PROPOSE_TWEAK_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	START_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	GOAL_WORK_TOOL_NAMES,
} from "../extensions/goal-tool-names.ts";

describe("tool name constants", () => {
	it("exports expected names", () => {
		assert.equal(QUESTION_TOOL_NAME, "goal_question");
		assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
		assert.equal(ABORT_GOAL_TOOL_NAME, "abort_goal");
		assert.equal(PROPOSE_TWEAK_TOOL_NAME, "propose_goal_tweak");
		assert.equal(PROPOSE_TASK_LIST_TOOL_NAME, "propose_task_list");
		assert.equal(COMPLETE_TASK_TOOL_NAME, "complete_task");
		assert.equal(SKIP_TASK_TOOL_NAME, "skip_task");
		assert.equal(SISYPHUS_STEP_TOOL_NAME, "step_complete");
		assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
		assert.equal(START_GOAL_TOOL_NAME, "start_goal");
		assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	});

	it("ACTIVE includes lifecycle + task tools", () => {
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes("get_goal"));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes("complete_goal"));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes("pause_goal"));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(ABORT_GOAL_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(PROPOSE_TWEAK_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(PROPOSE_TASK_LIST_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(COMPLETE_TASK_TOOL_NAME));
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(SKIP_TASK_TOOL_NAME));
	});

	it("PAUSED excludes pause_goal + skip/complete_task (no work)", () => {
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes("pause_goal"));
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes(COMPLETE_TASK_TOOL_NAME));
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes(SKIP_TASK_TOOL_NAME));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes("get_goal"));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes("complete_goal"));
		assert.ok(PAUSED_GOAL_TOOL_NAMES.includes(PROPOSE_TWEAK_TOOL_NAME));
	});

	it("NO_FOCUSED_GOAL only has get_goal", () => {
		assert.deepEqual([...NO_FOCUSED_GOAL_TOOL_NAMES], ["get_goal"]);
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

	it("active status returns ACTIVE set", () => {
		const tools = lifecycleToolNamesForGoalStatus("active");
		assert.ok(tools.includes("complete_goal"));
		assert.ok(tools.includes("pause_goal"));
	});

	it("paused status returns PAUSED set", () => {
		const tools = lifecycleToolNamesForGoalStatus("paused");
		assert.ok(tools.includes("complete_goal"));
		assert.ok(!tools.includes("pause_goal"));
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

describe("isQuestionLikeToolName", () => {
	it("matches exact question tool names", () => {
		assert.equal(isQuestionLikeToolName("goal_question"), true);
		assert.equal(isQuestionLikeToolName("goal_questionnaire"), true);
	});

	it("matches names containing question/ask/clarify/confirm", () => {
		assert.equal(isQuestionLikeToolName("ask_user"), true);
		assert.equal(isQuestionLikeToolName("clarify_intent"), true);
		assert.equal(isQuestionLikeToolName("confirm_action"), true);
		assert.equal(isQuestionLikeToolName("my_question_tool"), true);
	});

	it("case insensitive", () => {
		assert.equal(isQuestionLikeToolName("ASK"), true);
		assert.equal(isQuestionLikeToolName("Confirm"), true);
	});

	it("false for unrelated names", () => {
		assert.equal(isQuestionLikeToolName("complete_goal"), false);
		assert.equal(isQuestionLikeToolName("write"), false);
		assert.equal(isQuestionLikeToolName("bash"), false);
		assert.equal(isQuestionLikeToolName(""), false);
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
		// Hidden from active/paused/no-focused tool surfaces — never surfaced to the LLM.
		assert.ok(!ACTIVE_GOAL_TOOL_NAMES.includes("start_goal"));
		assert.ok(!PAUSED_GOAL_TOOL_NAMES.includes("start_goal"));
		assert.ok(!NO_FOCUSED_GOAL_TOOL_NAMES.includes("start_goal"));
	});
});
