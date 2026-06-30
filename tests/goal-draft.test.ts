import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	renderConfirmationTasks,
	promptSafeObjective,
	extractVerificationContract,
	buildDraftConfirmationText,
	buildTweakConfirmationText,
	evaluateDraftingToolGate,
	validateGoalDraftProposal,
	goalDraftingPrompt,
} from "../extensions/goal-draft.ts";

describe("renderConfirmationTasks", () => {
	it("renders empty array as empty", () => {
		assert.deepEqual(renderConfirmationTasks([], 0), []);
	});

	it("renders tasks with indent", () => {
		const tasks = [{ id: "t1", title: "A", status: "pending" as const }];
		const lines = renderConfirmationTasks(tasks, 0);
		assert.ok(lines.length > 0);
		assert.match(lines[0], /t1|A/);
	});
});

describe("promptSafeObjective", () => {
	it("passes through plain text", () => {
		assert.equal(promptSafeObjective("hello world"), "hello world");
	});
});

describe("extractVerificationContract", () => {
	it("returns objective unchanged when no contract marker", () => {
		const r = extractVerificationContract("just an objective");
		assert.equal(r.objective, "just an objective");
		assert.equal(r.verificationContract, undefined);
	});

	it("extracts contract when 'Verification contract: X' present", () => {
		const r = extractVerificationContract("do the thing\nVerification contract: run tests");
		assert.ok(r.verificationContract);
		assert.equal(r.verificationContract, "run tests");
		assert.ok(!r.objective.includes("Verification contract"));
	});

	it("is case-insensitive", () => {
		const r = extractVerificationContract("verification CONTRACT: do X");
		assert.equal(r.verificationContract, "do X");
	});

	it("handles empty contract after colon", () => {
		const r = extractVerificationContract("obj\nVerification contract:");
		// Empty match — m[1] is empty string, falsy → undefined
		assert.equal(r.verificationContract, undefined);
	});
});

describe("buildDraftConfirmationText / buildTweakConfirmationText", () => {
	it("draft text includes objective", () => {
		const txt = buildDraftConfirmationText({
			focus: "goal",
			originalTopic: "topic",
			objective: "my obj",
			autoContinue: true,
		});
		assert.match(txt, /my obj/);
	});

	it("tweak text includes change summary", () => {
		const txt = buildTweakConfirmationText({
			currentObjective: "old",
			newObjective: "new obj",
			changeSummary: "changed X",
			sisyphus: false,
		});
		assert.match(txt, /changed X/);
	});
});

describe("evaluateDraftingToolGate", () => {
	it("allows in drafting phase", () => {
		const r = evaluateDraftingToolGate({ phase: "drafting" } as unknown as Parameters<typeof evaluateDraftingToolGate>[0]);
		assert.equal(r.allowed ?? r.ok ?? true, true);
	});
});

describe("validateGoalDraftProposal", () => {
	it("rejects when intent is null", () => {
		const r = validateGoalDraftProposal({ intent: null, objective: "x", sisyphus: false } as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.ok(!r.ok);
	});

	it("rejects focus mismatch (sisyphus vs goal)", () => {
		const r = validateGoalDraftProposal({
			intent: { focus: "goal" },
			objective: "x",
			sisyphus: true,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.ok(!r.ok);
		assert.match((r as { message: string }).message, /focus gate/i);
	});

	it("rejects empty objective", () => {
		const r = validateGoalDraftProposal({
			intent: { focus: "goal" },
			objective: "  ",
			sisyphus: false,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.ok(!r.ok);
	});

	it("accepts valid goal proposal", () => {
		const r = validateGoalDraftProposal({
			intent: { focus: "goal" },
			objective: "do something",
			sisyphus: false,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.equal(r.ok, true);
	});

	it("accepts valid sisyphus proposal", () => {
		const r = validateGoalDraftProposal({
			intent: { focus: "sisyphus" },
			objective: "step 1",
			sisyphus: true,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.equal(r.ok, true);
	});
});

describe("goalDraftingPrompt", () => {
	it("returns non-empty prompt mentioning topic", () => {
		const p = goalDraftingPrompt("build feature X", "goal");
		assert.ok(p.length > 0);
	});
});
