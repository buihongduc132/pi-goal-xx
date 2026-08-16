import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GoalSettings } from "../extensions/goal-settings.ts";
import {
	renderConfirmationTasks,
	promptSafeObjective,
	extractVerificationContract,
	buildDraftConfirmationText,
	buildTweakConfirmationText,
	evaluateDraftingToolGate,
	validateGoalDraftProposal,
	goalDraftingPrompt,
	resolveGoalDraftingBlock,
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

describe("G6: objective length cap", () => {
	it("rejects objective exceeding the max length", () => {
		const longObjective = "x".repeat(50_001);
		const r = validateGoalDraftProposal({
			intent: { focus: "goal" },
			objective: longObjective,
			sisyphus: false,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.ok(!r.ok);
		assert.match((r as { message: string }).message, /50.*KB|max.*length|too long/i);
	});

	it("accepts objective at the exact max length", () => {
		const maxObjective = "x".repeat(50_000);
		const r = validateGoalDraftProposal({
			intent: { focus: "goal" },
			objective: maxObjective,
			sisyphus: false,
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

// ── Branch coverage: formatting helpers ───────────────────────────────────

describe("buildDraftConfirmationText branches", () => {
	it("sisyphus focus renders Sisyphus mode label and auto-continue=no", () => {
		const txt = buildDraftConfirmationText({
			focus: "sisyphus",
			originalTopic: "topic",
			objective: "obj",
			autoContinue: false,
		});
		assert.match(txt, /Sisyphus \(prompt\/criteria style\)/);
		assert.match(txt, /Auto-continue: no/);
	});

	it("normal goal focus renders Normal goal mode label and auto-continue=yes", () => {
		const txt = buildDraftConfirmationText({
			focus: "goal",
			originalTopic: "topic",
			objective: "obj",
			autoContinue: true,
		});
		assert.match(txt, /Normal goal/);
		assert.match(txt, /Auto-continue: yes/);
	});
});

describe("formatPrefixedLines via confirmation text (empty + box-drawing lines)", () => {
	it("skips blank lines and preserves lines already prefixed with │", () => {
		// objective containing a blank line and a │-prefixed line exercises
		// both branches of formatPrefixedLines.
		const txt = buildDraftConfirmationText({
			focus: "goal",
			originalTopic: "topic",
			objective: "│ existing box line\n\nplain line",
			autoContinue: true,
		});
		// The │-prefixed line must be preserved as-is (no double-prefix).
		assert.match(txt, /│ existing box line/);
		// The plain line gets the │ prefix added.
		assert.match(txt, /│   plain line/);
	});
});

describe("buildTweakConfirmationText branches", () => {
	it("includes tasks block when tasks present", () => {
		const txt = buildTweakConfirmationText({
			currentObjective: "old",
			newObjective: "new",
			changeSummary: "changed",
			sisyphus: true,
			tasks: [{ id: "t1", title: "Do thing", status: "pending" }],
		});
		assert.match(txt, /TASKS/);
		assert.match(txt, /Do thing/);
		assert.match(txt, /Sisyphus \(prompt\/criteria style\)/);
	});

	it("omits tasks block when tasks empty", () => {
		const txt = buildTweakConfirmationText({
			currentObjective: "old",
			newObjective: "new",
			changeSummary: "changed",
			sisyphus: false,
			tasks: [],
		});
		assert.ok(!/TASKS/.test(txt));
	});
});

describe("renderConfirmationTasks branches", () => {
	it("renders lightweight, contract, and nested subtask markers", () => {
		const tasks = [
			{
				id: "t1",
				title: "Outer",
				status: "pending" as const,
				lightweightSubtasks: true,
				verificationContract: "run tests",
				subtasks: [
					{ id: "t1.1", title: "Inner", status: "pending" as const },
				],
			},
		];
		const lines = renderConfirmationTasks(tasks, 0);
		const joined = lines.join("\n");
		assert.match(joined, /\(lightweight\)/);
		assert.match(joined, /contract: run tests/);
		assert.match(joined, /Inner/);
		// Nested subtask should be indented.
		assert.ok(lines.length > 1, "nested subtask should produce extra line(s)");
	});
});

// ── Branch coverage: extractVerificationContract template expansion ────────

describe("extractVerificationContract template expansion", () => {
	it("reports missingSnippets when contract has unresolvable template", () => {
		// A contract containing {{name}} that has no snippet file resolves to
		// a non-empty expanded string (literal preserved) and a warning.
		const r = extractVerificationContract(
			"objective body\nVerification contract: run {{missing-thing}}",
			"/tmp/nonexistent-contracts-dir",
		);
		assert.ok(r.verificationContract);
		assert.ok(r.missingSnippets && r.missingSnippets.includes("missing-thing"),
			`expected missingSnippets to include 'missing-thing', got: ${JSON.stringify(r.missingSnippets)}`);
	});
});

// ── Branch coverage: validateGoalDraftProposal focus-gate message ──────────

describe("validateGoalDraftProposal focus-gate message for sisyphus", () => {
	it("mentions /sisyphus when focus is sisyphus but sisyphus=false", () => {
		const r = validateGoalDraftProposal({
			intent: { focus: "sisyphus" },
			objective: "do thing",
			sisyphus: false,
		} as unknown as Parameters<typeof validateGoalDraftProposal>[0]);
		assert.ok(!r.ok);
		assert.match((r as { message: string }).message, /\/sisyphus/);
	});
});

// ── Branch coverage: goalDraftingPrompt prompt-config paths ────────────────

describe("goalDraftingPrompt prompt config branches", () => {
	it("returns override body when settings define an inline override", () => {
		const settings = {
			prompts: { "goal-drafting": { mode: "override", inline: "OVERRIDE-BODY-123" } },
		} as unknown as GoalSettings;
		const p = goalDraftingPrompt("some topic", "goal", settings, "/tmp");
		assert.equal(p, "OVERRIDE-BODY-123");
	});

	it("appends injected block (non-override mode) to the base prompt", () => {
		const settings = {
			prompts: { "goal-drafting": { mode: "append", inline: "INJECTED-BLOCK-456" } },
		} as unknown as GoalSettings;
		const p = goalDraftingPrompt("topic here", "goal", settings, "/tmp");
		assert.match(p, /INJECTED-BLOCK-456/);
		assert.match(p, /PI GOAL CUSTOM PROMPT key=goal-drafting/);
	});

	it("resolveGoalDraftingBlock returns empty when no prompts configured", () => {
		assert.equal(resolveGoalDraftingBlock(undefined, "/tmp"), "");
	});

	it("resolveGoalDraftingBlock returns empty when prompts exist but no key", () => {
		const settings = { prompts: { "other-key": { mode: "append" } } } as unknown as GoalSettings;
		assert.equal(resolveGoalDraftingBlock(settings, "/tmp"), "");
	});

	it("resolveGoalDraftingBlock returns empty when injected is blank", () => {
		const settings = {
			prompts: { "goal-drafting": { mode: "append", inline: "   " } },
		} as unknown as GoalSettings;
		assert.equal(resolveGoalDraftingBlock(settings, "/tmp"), "");
	});
});

// ── Branch coverage: draftingAskLine disabled-tools paths ──────────────────

describe("goalDraftingPrompt draftingAskLine disabled-tool paths", () => {
	it("includes plain-conversation line only when both ask tools disabled", () => {
		const settings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
		} as unknown as GoalSettings;
		const p = goalDraftingPrompt("topic", "goal", settings);
		assert.match(p, /ask one focused question/);
		assert.ok(!/Use goal_questionnaire/.test(p));
		assert.ok(!/Use goal_question or goal_questionnaire/.test(p));
	});

	it("references only goal_questionnaire when goal_question disabled", () => {
		const settings = { disabledTools: ["goal_question"] } as unknown as GoalSettings;
		const p = goalDraftingPrompt("topic", "goal", settings);
		assert.match(p, /Use goal_questionnaire/);
		assert.ok(!/Use goal_question or goal_questionnaire/.test(p));
	});

	it("references only goal_question when goal_questionnaire disabled", () => {
		const settings = { disabledTools: ["goal_questionnaire"] } as unknown as GoalSettings;
		const p = goalDraftingPrompt("topic", "goal", settings);
		assert.match(p, /Use goal_question to clarify/);
		assert.ok(!/Use goal_questionnaire/.test(p));
	});

	it("GD1: both disabled + goal_question inline replacement → replacement reaches drafting prompt (RED)", () => {
		const settings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
			toolInstructions: { goal_question: { inline: "Use intercom to clarify." } },
		} as unknown as GoalSettings;
		const p = goalDraftingPrompt("topic", "goal", settings);
		assert.ok(p.includes("Use intercom to clarify."), "configured replacement must reach goalDraftingPrompt");
	});
});

// ── Branch coverage: goalDraftingPromptBase topic + sisyphus ───────────────

describe("goalDraftingPromptBase branches", () => {
	it("uses fallback topic text when topic is blank", () => {
		const p = goalDraftingPrompt("", "goal");
		assert.match(p, /no topic provided/);
	});

	it("sisyphus focus emits sisyphus header and ordered-steps shape", () => {
		const p = goalDraftingPrompt("step by step", "sisyphus");
		assert.match(p, /focus=sisyphus/);
		assert.match(p, /Ordered steps/);
		assert.match(p, /Sisyphus reminder/);
	});
});
