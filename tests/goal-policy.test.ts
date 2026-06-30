import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	validateGoalCreationSlot,
	validateGoalCompletion,
	validateGoalUpdate,
	validateGoalAbort,
	validatePauseGoal,
	validateResumeGoal,
	validateVerificationSummary,
	validateTaskCompletion,
	validateTaskSkip,
	buildPausedByAgentGoal,
	buildAbortedByAgentGoal,
	clearGoalCommandMessage,
	abortGoalCommandMessage,
	buildTaskSummary,
	taskCompletionBlockWarning,
	measureSubtaskDepth,
	findSubtaskDepthViolation,
	findTaskInTree,
	updateTaskInTree,
	checkSubtasksComplete,
	skipAllSubtasks,
	shouldQueueContinuation,
	isGoalUnfinished,
	isRunnableStatus,
	isCompletableStatus,
} from "../extensions/goal-policy.ts";
import { createGoal, type GoalRecord, type GoalTask, type GoalTaskList } from "../extensions/goal-record.ts";

function makeActiveGoal(): GoalRecord {
	return createGoal({ objective: "x", autoContinue: true, sisyphus: false }, 1719792000000);
}

function makeTaskList(tasks: GoalTask[]): GoalTaskList {
	return { tasks, blockCompletion: false };
}

describe("status predicates", () => {
	it("isRunnableStatus", () => {
		assert.equal(isRunnableStatus("active"), true);
		assert.equal(isRunnableStatus("paused"), false);
		assert.equal(isRunnableStatus("complete"), false);
	});

	it("isCompletableStatus", () => {
		assert.equal(isCompletableStatus("active"), true);
		assert.equal(isCompletableStatus("paused"), true);
		assert.equal(isCompletableStatus("complete"), false);
	});

	it("isGoalUnfinished", () => {
		assert.equal(isGoalUnfinished({ status: "active" }), true);
		assert.equal(isGoalUnfinished({ status: "paused" }), true);
		assert.equal(isGoalUnfinished({ status: "complete" }), false);
		assert.equal(isGoalUnfinished(null), false);
		assert.equal(isGoalUnfinished(undefined), false);
	});
});

describe("validateGoalCreationSlot", () => {
	it("always ok (slot)", () => {
		assert.equal(validateGoalCreationSlot(null).ok, true);
		assert.equal(validateGoalCreationSlot({ status: "active" }).ok, true);
	});
});

describe("validateGoalCompletion", () => {
	it("rejects null goal", () => {
		assert.equal(validateGoalCompletion({ goal: null }).ok, false);
	});

	it("rejects runningGoalId mismatch", () => {
		const g = makeActiveGoal();
		assert.equal(validateGoalCompletion({ goal: g, runningGoalId: "other" }).ok, false);
	});

	it("rejects non-completable status", () => {
		const g = makeActiveGoal();
		g.status = "complete";
		assert.equal(validateGoalCompletion({ goal: g }).ok, false);
	});

	it("accepts active goal", () => {
		assert.equal(validateGoalCompletion({ goal: makeActiveGoal() }).ok, true);
	});

	it("accepts paused goal", () => {
		const g = makeActiveGoal();
		g.status = "paused";
		assert.equal(validateGoalCompletion({ goal: g }).ok, true);
	});
});

describe("validateGoalUpdate", () => {
	it("rejects null", () => {
		assert.equal(validateGoalUpdate({ goal: null }).ok, false);
	});
	it("rejects complete goal", () => {
		const g = makeActiveGoal();
		g.status = "complete";
		assert.equal(validateGoalUpdate({ goal: g }).ok, false);
	});
	it("accepts active", () => {
		assert.equal(validateGoalUpdate({ goal: makeActiveGoal() }).ok, true);
	});
});

describe("validateGoalAbort", () => {
	it("rejects null", () => {
		assert.equal(validateGoalAbort({ goal: null, reason: "x" }).ok, false);
	});
	it("rejects empty reason", () => {
		assert.equal(validateGoalAbort({ goal: makeActiveGoal(), reason: "  " }).ok, false);
	});
	it("rejects complete goal", () => {
		const g = makeActiveGoal();
		g.status = "complete";
		assert.equal(validateGoalAbort({ goal: g, reason: "x" }).ok, false);
	});
	it("rejects runningGoalId mismatch", () => {
		assert.equal(validateGoalAbort({ goal: makeActiveGoal(), reason: "x", runningGoalId: "other" }).ok, false);
	});
	it("accepts active + reason", () => {
		assert.equal(validateGoalAbort({ goal: makeActiveGoal(), reason: "obsolete" }).ok, true);
	});
});

describe("validatePauseGoal", () => {
	it("rejects null", () => {
		assert.equal(validatePauseGoal({ goal: null, reason: "x" }).ok, false);
	});
	it("rejects empty reason", () => {
		assert.equal(validatePauseGoal({ goal: makeActiveGoal(), reason: "" }).ok, false);
	});
	it("rejects non-runnable status", () => {
		const g = makeActiveGoal();
		g.status = "complete";
		assert.equal(validatePauseGoal({ goal: g, reason: "x" }).ok, false);
	});
	it("accepts active + reason", () => {
		assert.equal(validatePauseGoal({ goal: makeActiveGoal(), reason: "blocked" }).ok, true);
	});
});

describe("validateResumeGoal", () => {
	it("rejects null", () => {
		assert.equal(validateResumeGoal(null).ok, false);
	});
	it("rejects complete", () => {
		const g = makeActiveGoal();
		g.status = "complete";
		assert.equal(validateResumeGoal(g).ok, false);
	});
	it("rejects already running (active + autoContinue)", () => {
		assert.equal(validateResumeGoal(makeActiveGoal()).ok, false);
	});
	it("accepts paused goal", () => {
		const g = makeActiveGoal();
		g.status = "paused";
		g.autoContinue = false;
		assert.equal(validateResumeGoal(g).ok, true);
	});
});

describe("validateVerificationSummary", () => {
	it("ok when no contract", () => {
		assert.equal(validateVerificationSummary({}).ok, true);
		assert.equal(validateVerificationSummary({ verificationContract: null }).ok, true);
	});
	it("ok when contract + summary present", () => {
		assert.equal(validateVerificationSummary({ verificationContract: "do X", verificationSummary: "did X" }).ok, true);
	});
	it("fails when contract present but summary missing", () => {
		const r = validateVerificationSummary({ verificationContract: "do X" });
		assert.equal(r.ok, false);
		assert.match(r.message!, /verificationSummary/);
	});
	it("fails when contract present but summary empty", () => {
		assert.equal(validateVerificationSummary({ verificationContract: "do X", verificationSummary: "   " }).ok, false);
	});
	it("ok when contract empty + summary empty", () => {
		assert.equal(validateVerificationSummary({ verificationContract: "  ", verificationSummary: "" }).ok, true);
	});
});

describe("buildPausedByAgentGoal / buildAbortedByAgentGoal", () => {
	it("paused sets status + clears autoContinue", () => {
		const g = makeActiveGoal();
		const p = buildPausedByAgentGoal(g, { reason: "r", updatedAt: "t" });
		assert.equal(p.status, "paused");
		assert.equal(p.autoContinue, false);
		assert.equal(p.stopReason, "agent");
		assert.equal(p.pauseReason, "r");
	});
	it("paused trims suggestedAction and drops empty", () => {
		const g = makeActiveGoal();
		const p = buildPausedByAgentGoal(g, { reason: "r", suggestedAction: "  ", updatedAt: "t" });
		assert.equal(p.pauseSuggestedAction, undefined);
		const p2 = buildPausedByAgentGoal(g, { reason: "r", suggestedAction: "do X", updatedAt: "t" });
		assert.equal(p2.pauseSuggestedAction, "do X");
	});
	it("aborted sets paused + prefixed reason", () => {
		const g = makeActiveGoal();
		const a = buildAbortedByAgentGoal(g, { reason: "obsolete", updatedAt: "t" });
		assert.equal(a.status, "paused");
		assert.equal(a.pauseReason, "Aborted: obsolete");
	});
});

describe("clearGoalCommandMessage / abortGoalCommandMessage", () => {
	it("clear messages", () => {
		assert.match(clearGoalCommandMessage({ archived: true, wasDrafting: false }), /archived/);
		assert.match(clearGoalCommandMessage({ archived: false, wasDrafting: true }), /Drafting/);
		assert.match(clearGoalCommandMessage({ archived: false, wasDrafting: false }), /No goal/);
	});
	it("abort messages", () => {
		assert.match(abortGoalCommandMessage({ archived: true, wasDrafting: false }), /aborted/);
		assert.match(abortGoalCommandMessage({ archived: false, wasDrafting: true }), /Drafting/);
	});
});

describe("buildTaskSummary / taskCompletionBlockWarning", () => {
	it("summary lists task counts", () => {
		const tl = makeTaskList([
			{ id: "t1", title: "A", status: "complete" },
			{ id: "t2", title: "B", status: "pending" },
			{ id: "t3", title: "C", status: "skipped" },
		]);
		const s = buildTaskSummary(tl);
		assert.match(s, /3/); // total
	});

	it("blockWarning returns null when no blockCompletion", () => {
		const tl = makeTaskList([{ id: "t1", title: "A", status: "pending" }]);
		assert.equal(taskCompletionBlockWarning(tl), null);
	});

	it("blockWarning returns message when blockCompletion + pending tasks", () => {
		const tl: GoalTaskList = { tasks: [{ id: "t1", title: "A", status: "pending" }], blockCompletion: true };
		const w = taskCompletionBlockWarning(tl);
		assert.ok(w);
	});

	it("blockWarning returns null when all complete", () => {
		const tl: GoalTaskList = { tasks: [{ id: "t1", title: "A", status: "complete" }], blockCompletion: true };
		assert.equal(taskCompletionBlockWarning(tl), null);
	});
});

describe("measureSubtaskDepth / findSubtaskDepthViolation", () => {
	it("depth 0 for leaf task", () => {
		assert.equal(measureSubtaskDepth({ id: "t", title: "x", status: "pending" }), 0);
	});
	it("depth 1 for one level of subtasks", () => {
		const t: GoalTask = { id: "t", title: "x", status: "pending", subtasks: [{ id: "s", title: "y", status: "pending" }] };
		assert.equal(measureSubtaskDepth(t), 1);
	});
	it("depth 2 for nested", () => {
		const t: GoalTask = {
			id: "t", title: "x", status: "pending",
			subtasks: [{ id: "s", title: "y", status: "pending", subtasks: [{ id: "ss", title: "z", status: "pending" }] }],
		};
		assert.equal(measureSubtaskDepth(t), 2);
	});
	it("findSubtaskDepthViolation returns undefined when within limit", () => {
		const tasks: GoalTask[] = [{ id: "t", title: "x", status: "pending", subtasks: [{ id: "s", title: "y", status: "pending" }] }];
		assert.equal(findSubtaskDepthViolation(tasks, 1), undefined);
	});
	it("findSubtaskDepthViolation returns message when over limit", () => {
		const tasks: GoalTask[] = [{
			id: "t", title: "x", status: "pending",
			subtasks: [{ id: "s", title: "y", status: "pending", subtasks: [{ id: "ss", title: "z", status: "pending" }] }],
		}];
		const v = findSubtaskDepthViolation(tasks, 1);
		assert.ok(v);
		assert.match(v!, /depth 2/);
	});
});

describe("findTaskInTree / updateTaskInTree", () => {
	it("findTaskInTree finds root", () => {
		const tasks: GoalTask[] = [{ id: "t1", title: "A", status: "pending" }];
		assert.equal(findTaskInTree(tasks, "t1")?.id, "t1");
	});
	it("findTaskInTree finds nested", () => {
		const tasks: GoalTask[] = [{
			id: "t1", title: "A", status: "pending",
			subtasks: [{ id: "s1", title: "B", status: "pending" }],
		}];
		assert.equal(findTaskInTree(tasks, "s1")?.id, "s1");
	});
	it("findTaskInTree returns undefined for missing", () => {
		assert.equal(findTaskInTree([], "x"), undefined);
	});
	it("updateTaskInTree applies updater immutably", () => {
		const tasks: GoalTask[] = [{ id: "t1", title: "A", status: "pending" }];
		const updated = updateTaskInTree(tasks, "t1", (t) => ({ ...t, status: "complete" }));
		assert.equal(updated[0].status, "complete");
		assert.equal(tasks[0].status, "pending"); // original unchanged
	});
});

describe("checkSubtasksComplete", () => {
	it("returns undefined when no subtasks", () => {
		assert.equal(checkSubtasksComplete({ id: "t", title: "x", status: "pending" }), undefined);
	});
	it("returns undefined when all subtasks complete", () => {
		const t: GoalTask = { id: "t", title: "x", status: "pending", subtasks: [{ id: "s", title: "y", status: "complete" }] };
		assert.equal(checkSubtasksComplete(t), undefined);
	});
	it("returns message when subtask pending (full subtasks)", () => {
		const t: GoalTask = { id: "t", title: "x", status: "pending", subtasks: [{ id: "s", title: "y", status: "pending" }] };
		const w = checkSubtasksComplete(t);
		assert.ok(w);
	});
});

describe("skipAllSubtasks", () => {
	it("cascades skip to all subtasks", () => {
		const t: GoalTask = {
			id: "t", title: "x", status: "pending",
			subtasks: [
				{ id: "s1", title: "a", status: "pending" },
				{ id: "s2", title: "b", status: "pending", subtasks: [{ id: "ss", title: "c", status: "pending" }] },
			],
		};
		const skipped = skipAllSubtasks(t, "now", "parent skip");
		assert.equal(skipped.subtasks![0].status, "skipped");
		assert.equal(skipped.subtasks![1].status, "skipped");
		assert.equal(skipped.subtasks![1].subtasks![0].status, "skipped");
	});
});

describe("validateTaskCompletion", () => {
	it("rejects null goal", () => {
		assert.equal(validateTaskCompletion({ goal: null, taskId: "t1" }).ok, false);
	});
	it("rejects missing task list", () => {
		const g = makeActiveGoal();
		assert.equal(validateTaskCompletion({ goal: g, taskId: "t1" }).ok, false);
	});
	it("rejects unknown task", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "pending" }]);
		assert.equal(validateTaskCompletion({ goal: g, taskId: "missing" }).ok, false);
	});
	it("rejects already complete task", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "complete" }]);
		assert.equal(validateTaskCompletion({ goal: g, taskId: "t1" }).ok, false);
	});
	it("accepts pending task", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "pending" }]);
		assert.equal(validateTaskCompletion({ goal: g, taskId: "t1" }).ok, true);
	});
});

describe("validateTaskSkip", () => {
	it("rejects null goal", () => {
		assert.equal(validateTaskSkip({ goal: null, taskId: "t1", reason: "x" }).ok, false);
	});
	it("rejects empty reason", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "pending" }]);
		assert.equal(validateTaskSkip({ goal: g, taskId: "t1", reason: "" }).ok, false);
	});
	it("rejects already complete", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "complete" }]);
		assert.equal(validateTaskSkip({ goal: g, taskId: "t1", reason: "x" }).ok, false);
	});
	it("accepts pending + reason", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "pending" }]);
		assert.equal(validateTaskSkip({ goal: g, taskId: "t1", reason: "x" }).ok, true);
	});
	it("accepts already skipped (toggle) without reason", () => {
		const g = makeActiveGoal();
		g.taskList = makeTaskList([{ id: "t1", title: "A", status: "skipped" }]);
		assert.equal(validateTaskSkip({ goal: g, taskId: "t1", reason: "" }).ok, true);
	});
});

describe("shouldQueueContinuation", () => {
	it("false for null", () => {
		assert.equal(shouldQueueContinuation(null), false);
	});
	it("false for complete", () => {
		assert.equal(shouldQueueContinuation({ status: "complete", autoContinue: true }), false);
	});
	it("false for active without autoContinue", () => {
		assert.equal(shouldQueueContinuation({ status: "active", autoContinue: false }), false);
	});
	it("true for active + autoContinue", () => {
		assert.equal(shouldQueueContinuation({ status: "active", autoContinue: true }), true);
	});
});
