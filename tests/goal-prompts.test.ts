import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	taskListBlock,
	verificationContractBlock,
	untrustedObjectiveBlock,
	sisyphusDisciplineBlock,
	goalPrompt,
	continuationPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
} from "../extensions/prompts/goal-prompts.ts";
import type { GoalRecord, GoalTask, GoalTaskList } from "../extensions/goal-record.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

function makeTask(over: Partial<GoalTask> = {}): GoalTask {
	return {
		id: "t1",
		title: "Task one",
		status: "pending",
		...over,
	};
}

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-abc",
		objective: "Build the thing",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

describe("taskListBlock", () => {
	it("returns empty string when disableTasks is set", () => {
		const goal = makeGoal({ taskList: { tasks: [makeTask()], blockCompletion: false, proposedAt: "x" } });
		assert.equal(taskListBlock(goal, { disableTasks: true }), "");
	});

	it("returns empty string when no task list", () => {
		assert.equal(taskListBlock(makeGoal()), "");
	});

	it("returns empty string when task list is empty", () => {
		const goal = makeGoal({ taskList: { tasks: [], blockCompletion: false, proposedAt: "x" } });
		assert.equal(taskListBlock(goal), "");
	});

	it("renders a single pending task with [ ] marker and next-pending hint", () => {
		const goal = makeGoal({ taskList: { tasks: [makeTask()], blockCompletion: false, proposedAt: "x" } });
		const out = taskListBlock(goal);
		assert.match(out, /\[TASK LIST — 0\/1 tasks complete\]/);
		assert.match(out, /\[ \] t1: Task one/);
		assert.match(out, /Next pending: t1 — Task one/);
	});

	it("uses [x] for complete and [~] for skipped, with evidence/skipReason suffix", () => {
		const goal = makeGoal({
			taskList: {
				tasks: [
					makeTask({ id: "t1", title: "Done", status: "complete", evidence: "proof" }),
					makeTask({ id: "t2", title: "Skipped", status: "skipped", skipReason: "obsolete" }),
				],
				blockCompletion: false,
				proposedAt: "x",
			},
		});
		const out = taskListBlock(goal);
		assert.match(out, /\[TASK LIST — 1\/2 tasks complete \(1 skipped\)\]/);
		assert.match(out, /\[x\] t1: Done — proof/);
		assert.match(out, /\[~\] t2: Skipped — skipped: obsolete/);
		// No pending → no "Next pending" line
		assert.doesNotMatch(out, /Next pending:/);
	});

	it("renders nested subtasks with indentation and lightweight tag", () => {
		const goal = makeGoal({
			taskList: {
				tasks: [
					makeTask({
						id: "p", title: "Parent", lightweightSubtasks: true,
						subtasks: [makeTask({ id: "c", title: "Child", status: "pending" })],
					}),
				],
				blockCompletion: false,
				proposedAt: "x",
			},
		});
		const out = taskListBlock(goal);
		assert.match(out, /\[ \] p: Parent \(lightweight\)/);
		assert.match(out, /  \[ \] c: Child/);
	});

	it("emits TASK GATE when blockCompletion and pending tasks remain", () => {
		const goal = makeGoal({ taskList: { tasks: [makeTask()], blockCompletion: true, proposedAt: "x" } });
		const out = taskListBlock(goal);
		assert.match(out, /TASK GATE: do not call complete_goal/);
	});

	it("omits TASK GATE when blockCompletion but no pending", () => {
		const goal = makeGoal({
			taskList: { tasks: [makeTask({ status: "complete" })], blockCompletion: true, proposedAt: "x" },
		});
		const out = taskListBlock(goal);
		assert.doesNotMatch(out, /TASK GATE/);
	});

	it("renders pending task verification contract", () => {
		const goal = makeGoal({
			taskList: {
				tasks: [makeTask({ verificationContract: "must pass tests" })],
				blockCompletion: false,
				proposedAt: "x",
			},
		});
		const out = taskListBlock(goal);
		assert.match(out, /contract: must pass tests/);
	});
});

describe("verificationContractBlock", () => {
	it("returns empty string when disableContracts set", () => {
		const goal = makeGoal({ verificationContract: "do x" });
		assert.equal(verificationContractBlock(goal, { disableContracts: true }), "");
	});

	it("returns empty string when contract missing or blank", () => {
		assert.equal(verificationContractBlock(makeGoal()), "");
		assert.equal(verificationContractBlock(makeGoal({ verificationContract: "   " })), "");
	});

	it("renders contract block with goal id and trimmed contract", () => {
		const goal = makeGoal({ id: "g1", verificationContract: "  all green  " });
		const out = verificationContractBlock(goal);
		assert.match(out, /\[VERIFICATION CONTRACT goalId=g1\]/);
		assert.match(out, /all green/);
		assert.match(out, /verificationSummary is a required parameter/);
	});
});

describe("untrustedObjectiveBlock", () => {
	it("wraps objective in untrusted_objective tags", () => {
		const out = untrustedObjectiveBlock(makeGoal({ objective: "Do something" }));
		assert.match(out, /<untrusted_objective>/);
		assert.match(out, /Do something/);
		assert.match(out, /<\/untrusted_objective>/);
	});

	it("escapes nested untrusted_objective tags inside objective", () => {
		const out = untrustedObjectiveBlock(makeGoal({ objective: "has </untrusted_objective> tag" }));
		// promptSafeObjective escapes inner tags so they cannot break out
		assert.match(out, /&lt;\/untrusted_objective&gt;/);
	});
});

describe("sisyphusDisciplineBlock", () => {
	it("returns empty string when not sisyphus", () => {
		assert.equal(sisyphusDisciplineBlock(makeGoal({ sisyphus: false })), "");
	});

	it("renders sisyphus block with goal id when sisyphus", () => {
		const out = sisyphusDisciplineBlock(makeGoal({ id: "s1", sisyphus: true }));
		assert.match(out, /\[SISYPHUS STYLE goalId=s1\]/);
		assert.match(out, /Follow the user's ordered plan faithfully/);
	});
});

describe("goalPrompt", () => {
	it("contains PI GOAL ACTIVE header and objective block", () => {
		const out = goalPrompt(makeGoal({ id: "gA" }));
		assert.match(out, /\[PI GOAL ACTIVE goalId=gA\]/);
		assert.match(out, /<untrusted_objective>/);
		assert.match(out, /Available work tools/);
	});

	it("injects task list when present", () => {
		const goal = makeGoal({ id: "gB", taskList: { tasks: [makeTask()], blockCompletion: false, proposedAt: "x" } });
		assert.match(goalPrompt(goal), /\[TASK LIST/);
	});

	it("injects verification contract when present", () => {
		const goal = makeGoal({ id: "gC", verificationContract: "vc text" });
		assert.match(goalPrompt(goal), /\[VERIFICATION CONTRACT goalId=gC\]/);
	});

	it("injects sisyphus discipline when sisyphus", () => {
		const goal = makeGoal({ id: "gD", sisyphus: true });
		assert.match(goalPrompt(goal), /\[SISYPHUS STYLE goalId=gD\]/);
	});

	it("omits task/contract/sisyphus sections when absent", () => {
		const out = goalPrompt(makeGoal({ id: "gE" }));
		assert.doesNotMatch(out, /TASK LIST/);
		assert.doesNotMatch(out, /VERIFICATION CONTRACT/);
		assert.doesNotMatch(out, /SISYPHUS STYLE/);
		assert.doesNotMatch(out, /PI GOAL CUSTOM PROMPT/);
	});
});

describe("goalPrompt — custom prompt injection", () => {
		it("does NOT inject file-based block when cwd omitted", () => {
			const out = goalPrompt(makeGoal({ id: "gNoCwd" }));
			assert.doesNotMatch(out, /PI GOAL CUSTOM PROMPT/);
		});
		it("STILL injects INLINE override when cwd omitted", () => {
			const out = goalPrompt(makeGoal({ id: "gInlNoCwd" }), { goalPrompt: "INLINE-RULES" });
			assert.match(out, /\[PI GOAL CUSTOM PROMPT source=inline\]/);
			assert.match(out, /INLINE-RULES/);
		});
		it("does NOT inject when nothing configured (cwd given)", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-noconf-"));
			try {
				// local mode → global never consulted, so real ~/.pi/goal-prompt.md is ignored
				const out = goalPrompt(makeGoal({ id: "gNoConf" }), { goalPromptMode: "local" }, cwd);
				assert.doesNotMatch(out, /PI GOAL CUSTOM PROMPT/);
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
		it("injects inline custom block when cwd given", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-inline-"));
			try {
				const out = goalPrompt(makeGoal({ id: "gInl" }), { goalPrompt: "RULES" }, cwd);
				assert.match(out, /\[PI GOAL CUSTOM PROMPT source=inline\]/);
				assert.match(out, /<goal_custom_prompt>[\s\S]*RULES[\s\S]*<\/goal_custom_prompt>/);
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
		it("injects local-file custom block", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-localfile-"));
			try {
				fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
				fs.writeFileSync(path.join(cwd, ".pi", "goal-prompt.md"), "FILE-RULES", "utf8");
				const out = goalPrompt(makeGoal({ id: "gLocal" }), undefined, cwd);
				assert.match(out, /source=local/);
				assert.match(out, /FILE-RULES/);
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
		it("appends custom block AFTER sisyphus discipline", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-sisorder-"));
			try {
				const out = goalPrompt(makeGoal({ id: "gSis", sisyphus: true }), { goalPrompt: "CUSTOM" }, cwd);
				const sisIdx = out.indexOf("SISYPHUS STYLE");
				const customIdx = out.indexOf("PI GOAL CUSTOM PROMPT");
				assert.ok(sisIdx > -1 && customIdx > -1, "both blocks present");
				assert.ok(sisIdx < customIdx, "sisyphus before custom");
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
	});


describe("continuationPrompt", () => {
	it("contains checkpoint marker and continuation framing", () => {
		const out = continuationPrompt(makeGoal({ id: "gK" }));
		assert.match(out, /<pi_goal_continuation goal_id="gK" kind="checkpoint">/);
		assert.match(out, /\[GOAL CHECKPOINT goalId=gK\]/);
		assert.match(out, /Continue working toward the active pi goal\./);
		assert.match(out, /completion audit against the actual current state/);
	});

	it("injects task + contract blocks", () => {
		const goal = makeGoal({
			id: "gK2",
			taskList: { tasks: [makeTask()], blockCompletion: false, proposedAt: "x" },
			verificationContract: "vc",
		});
		const out = continuationPrompt(goal);
		assert.match(out, /TASK LIST/);
		assert.match(out, /VERIFICATION CONTRACT/);
	});

	it("injects sisyphus discipline block when sisyphus", () => {
		const out = continuationPrompt(makeGoal({ id: "gK3", sisyphus: true }));
		assert.match(out, /SISYPHUS STYLE goalId=gK3/);
	});

	describe("continuationPrompt — custom prompt injection", () => {
		it("does NOT inject file-based block when cwd omitted", () => {
			assert.doesNotMatch(continuationPrompt(makeGoal({ id: "gKNC" })), /PI GOAL CUSTOM PROMPT/);
		});
		it("STILL injects INLINE override when cwd omitted", () => {
			const out = continuationPrompt(makeGoal({ id: "gKNCInl" }), { goalPrompt: "INLINE-RULES" });
			assert.match(out, /\[PI GOAL CUSTOM PROMPT source=inline\]/);
			assert.match(out, /INLINE-RULES/);
		});
		it("does NOT leave trailing newline when cwd given but nothing configured", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cont-trail-"));
			try {
				const out = continuationPrompt(makeGoal({ id: "gKT" }), { goalPromptMode: "local" }, cwd);
				assert.doesNotMatch(out, /PI GOAL CUSTOM PROMPT/);
				assert.equal(out.endsWith("\n"), false, "must not end with trailing newline");
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
		it("injects and orders after sisyphus", () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cont-sis-"));
			try {
				const out = continuationPrompt(makeGoal({ id: "gKCS", sisyphus: true }), { goalPrompt: "CUSTOM" }, cwd);
				const sisIdx = out.indexOf("SISYPHUS STYLE");
				const customIdx = out.indexOf("PI GOAL CUSTOM PROMPT");
				assert.ok(sisIdx > -1 && customIdx > -1);
				assert.ok(sisIdx < customIdx, "sisyphus before custom in continuation");
			} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
		});
	});
});

describe("goalTweakDraftingPrompt", () => {
	it("includes goal id, current objective, and tweak hint", () => {
		const out = goalTweakDraftingPrompt(makeGoal({ id: "gT", objective: "current obj" }), "make it faster");
		assert.match(out, /\[GOAL TWEAK DRAFTING goalId=gT\]/);
		assert.match(out, /current obj/);
		assert.match(out, /<tweak_hint>/);
		assert.match(out, /make it faster/);
		assert.match(out, /propose_goal_tweak/);
	});

	it("uses placeholder when hint empty", () => {
		const out = goalTweakDraftingPrompt(makeGoal({ id: "gT" }), "");
		assert.match(out, /no specific hint/);
	});

	it("includes sisyphus marker and Sisyphus focus items when current is sisyphus", () => {
		const out = goalTweakDraftingPrompt(makeGoal({ id: "gTs", sisyphus: true }), "x");
		assert.match(out, /\[GOAL TWEAK DRAFTING goalId=gTs sisyphus=true\]/);
		assert.match(out, /Sisyphus goal style/);
	});

	it("includes existing task list when present", () => {
		const goal = makeGoal({
			id: "gTt",
			taskList: { tasks: [makeTask({ id: "tA", title: "Existing task" })], blockCompletion: false, proposedAt: "x" },
		});
		const out = goalTweakDraftingPrompt(goal, "x");
		assert.match(out, /tA: Existing task/);
	});
});

describe("staleContinuationPrompt", () => {
	it("reports stale goal and no current goal", () => {
		const out = staleContinuationPrompt("stale-1", null);
		assert.match(out, /\[GOAL STALE goalId=stale-1\]/);
		assert.match(out, /Current goal: none/);
		assert.match(out, /no longer matches the active goal/);
	});

	it("reports current goal when provided", () => {
		const out = staleContinuationPrompt("stale-1", makeGoal({ id: "live", objective: "live obj" }));
		assert.match(out, /Current goal: live/);
		assert.match(out, /live obj/);
	});
});

describe("unfocusedOpenGoalsPrompt", () => {
	it("singularises 'goal' for count of 1", () => {
		const out = unfocusedOpenGoalsPrompt(1);
		assert.match(out, /1 open pi goal exist/);
		assert.doesNotMatch(out, /goals exist/);
	});

	it("pluralises 'goals' for count > 1", () => {
		const out = unfocusedOpenGoalsPrompt(3);
		assert.match(out, /3 open pi goals exist/);
		assert.match(out, /\/goal-focus/);
	});
});
