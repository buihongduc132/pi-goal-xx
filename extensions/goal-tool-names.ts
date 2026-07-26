export const SISYPHUS_STEP_TOOL_NAME = "step_complete";
export const PROPOSE_TWEAK_TOOL_NAME = "propose_goal_tweak";
export const PROPOSE_DRAFT_TOOL_NAME = "propose_goal_draft";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const START_GOAL_TOOL_NAME = "start_goal";
export const PROPOSE_TASK_LIST_TOOL_NAME = "propose_task_list";
export const COMPLETE_TASK_TOOL_NAME = "complete_task";
export const SKIP_TASK_TOOL_NAME = "skip_task";

// NOTE: The block/question/pause agent tools were removed from this fork.
// The agent signals completion via complete_goal; blockers are stated in the
// agent's final message. User-initiated pause/abort remain available as slash
// commands (/goal-pause, /goal-abort, /goal-clear, /goal-resume).

export const ACTIVE_GOAL_TOOL_NAMES = ["get_goal", "complete_goal", PROPOSE_TWEAK_TOOL_NAME, PROPOSE_TASK_LIST_TOOL_NAME, COMPLETE_TASK_TOOL_NAME, SKIP_TASK_TOOL_NAME] as const;
export const PAUSED_GOAL_TOOL_NAMES = ["get_goal", "complete_goal", PROPOSE_TWEAK_TOOL_NAME, PROPOSE_TASK_LIST_TOOL_NAME] as const;
export const NO_FOCUSED_GOAL_TOOL_NAMES = ["get_goal"] as const;

export const GOAL_WORK_TOOL_NAMES = [
	"complete_goal",
	PROPOSE_TWEAK_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	START_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	"get_goal",
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

export const GOAL_PROGRESS_TOOL_NAMES = [
	"complete_goal",
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

export const POST_STOP_ALLOWED_TOOLS = ["get_goal"] as const;

export type GoalToolStatus = "active" | "paused" | "complete" | null | undefined;


export type GoalToolPhase = "normal" | "drafting" | "tweakDrafting";

export function lifecycleToolNamesForGoalStatus(status: GoalToolStatus, phase: GoalToolPhase = "normal"): readonly string[] {
	if (phase === "drafting" || phase === "tweakDrafting") return NO_FOCUSED_GOAL_TOOL_NAMES;
	if (status === "active") return ACTIVE_GOAL_TOOL_NAMES;
	if (status === "paused") return PAUSED_GOAL_TOOL_NAMES;
	return NO_FOCUSED_GOAL_TOOL_NAMES;
}
