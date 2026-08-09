/**
 * RED PHASE — prompt builder integration (tasks 3.1).
 *
 * Spec: openspec/changes/add-prompt-tool-instruction-config/specs/prompt-config-resolution/spec.md
 * Design: openspec/changes/add-prompt-tool-instruction-config/design.md (D4)
 *
 * Contract under test (GREEN implements):
 *  - goalPrompt / continuationPrompt call the instruction helpers and filter empty strings.
 *  - sisyphusDisciplineBlock accepts optional (settings, cwd) and uses pauseGoalSisyphusBullet.
 *  - goalDraftingPrompt splits the tool-clause line on ask-tool availability (G4).
 *  - goalTweakDraftingPrompt uses pauseGoalTweakInstruction (NG1).
 *  - No orphan blank lines after suppression (S4 structural guard).
 *
 * Today these FAIL: helpers not wired into builders; DEFAULT_* constants not yet imported.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	goalPrompt,
	continuationPrompt,
	sisyphusDisciplineBlock,
	goalTweakDraftingPrompt,
} from "../extensions/prompts/goal-prompts.ts";
import { goalDraftingPrompt } from "../extensions/goal-draft.ts";
import {
	DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION,
	DEFAULT_ASK_USER_INSTRUCTION,
	DEFAULT_ABORT_GOAL_INSTRUCTION,
	DEFAULT_COMPLETE_GOAL_INSTRUCTION,
} from "../extensions/prompts/tool-instruction-parts.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. goalPrompt — pause_goal suppression
// ---------------------------------------------------------------------------

describe("goalPrompt — pause_goal instruction", () => {
	it("no disabledTools → contains default instruction (regression guard)", () => {
		const out = goalPrompt(makeGoal({ id: "gA" }));
		assert.ok(
			out.includes(DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION),
			"default pause_goal instruction must be present when tool enabled",
		);
	});

	it("disabledTools: [pause_goal] → does NOT contain default instruction", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(
			!out.includes(DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION),
			"default pause_goal instruction must be omitted when tool disabled",
		);
	});

	it("disabledTools: [pause_goal] + inline replacement → contains inline, not default", () => {
		const settings: GoalSettings = {
			disabledTools: ["pause_goal"],
			toolInstructions: { pause_goal: { inline: "Use intercom." } },
		};
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(out.includes("Use intercom."), "inline replacement must appear");
		assert.ok(!out.includes(DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION), "default must be omitted");
	});

	it("disabledTools: [pause_goal] → no orphan blank lines (no \\n\\n\\n) (S4)", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(
			!/^\s*$\n\s*$\n\s*$/m.test(out) && !out.includes("\n\n\n"),
			"no three-or-more consecutive newlines (orphan blank lines) after suppression",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. goalPrompt — ask-user instruction
// ---------------------------------------------------------------------------

describe("goalPrompt — ask-user instruction", () => {
	it("disabledTools: [goal_question, goal_questionnaire] → does NOT contain default", () => {
		const settings: GoalSettings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
		};
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(
			!out.includes(DEFAULT_ASK_USER_INSTRUCTION),
			"default ask-user instruction must be omitted when both tools disabled",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. goalPrompt — abort_goal instruction
// ---------------------------------------------------------------------------

describe("goalPrompt — abort_goal instruction", () => {
	it("disabledTools: [abort_goal] → does NOT contain default", () => {
		const settings: GoalSettings = { disabledTools: ["abort_goal"] };
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(
			!out.includes(DEFAULT_ABORT_GOAL_INSTRUCTION),
			"default abort_goal instruction must be omitted when tool disabled",
		);
	});
});

// ---------------------------------------------------------------------------
// 4. goalPrompt — complete_goal instruction
// ---------------------------------------------------------------------------

describe("goalPrompt — complete_goal instruction", () => {
	it("disabledTools: [complete_goal] → does NOT contain default", () => {
		const settings: GoalSettings = { disabledTools: ["complete_goal"] };
		const out = goalPrompt(makeGoal({ id: "gA" }), settings);
		assert.ok(
			!out.includes(DEFAULT_COMPLETE_GOAL_INSTRUCTION),
			"default complete_goal instruction must be omitted when tool disabled",
		);
	});
});

// ---------------------------------------------------------------------------
// 5. continuationPrompt — ask-user + abort_goal suppression
// ---------------------------------------------------------------------------

describe("continuationPrompt — instruction suppression", () => {
	it("disabledTools: [goal_question, goal_questionnaire] → does NOT contain default ask-user", () => {
		const settings: GoalSettings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
		};
		const out = continuationPrompt(makeGoal({ id: "gK" }), settings);
		assert.ok(
			!out.includes(DEFAULT_ASK_USER_INSTRUCTION),
			"default ask-user instruction must be omitted in continuationPrompt",
		);
	});

	it("disabledTools: [abort_goal] → does NOT contain default abort_goal", () => {
		const settings: GoalSettings = { disabledTools: ["abort_goal"] };
		const out = continuationPrompt(makeGoal({ id: "gK" }), settings);
		assert.ok(
			!out.includes(DEFAULT_ABORT_GOAL_INSTRUCTION),
			"default abort_goal instruction must be omitted in continuationPrompt",
		);
	});
});

// ---------------------------------------------------------------------------
// 6. sisyphusDisciplineBlock — pause_goal bullet suppression
// ---------------------------------------------------------------------------

describe("sisyphusDisciplineBlock — pause_goal bullet", () => {
	it("disabledTools: [pause_goal] → does NOT contain 'call pause_goal' sentence", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		const out = sisyphusDisciplineBlock(makeGoal({ id: "s1", sisyphus: true }), settings);
		assert.ok(
			!out.includes("call pause_goal"),
			"sisyphus pause_goal bullet must be omitted when tool disabled",
		);
	});

	it("disabledTools: [pause_goal] → still contains OTHER sisyphus bullets", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		const out = sisyphusDisciplineBlock(makeGoal({ id: "s1", sisyphus: true }), settings);
		assert.ok(out.includes("SISYPHUS STYLE"), "sisyphus header preserved");
		assert.ok(
			out.includes("Follow the user's ordered plan faithfully"),
			"other sisyphus bullets preserved",
		);
		assert.ok(
			out.includes("complete_goal only after"),
			"complete_goal sisyphus bullet preserved (not gated)",
		);
	});
});

// ---------------------------------------------------------------------------
// 7. goalDraftingPrompt — ask-tool clause splitting (G4, S3)
// ---------------------------------------------------------------------------

describe("goalDraftingPrompt — ask-tool clause (G4, S3)", () => {
	it("both ask tools disabled → does NOT contain tool clause, DOES contain plain-conversation clause", () => {
		const settings: GoalSettings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
		};
		const out = goalDraftingPrompt("build a thing", "goal", settings);
		assert.ok(
			!out.includes("Use goal_question or goal_questionnaire"),
			"tool clause must be omitted when both ask tools disabled",
		);
		assert.ok(
			out.toLowerCase().includes("plain conversation"),
			"plain-conversation clause must always be present",
		);
	});

	it("only goal_question disabled → references goal_questionnaire (S3)", () => {
		const settings: GoalSettings = { disabledTools: ["goal_question"] };
		const out = goalDraftingPrompt("build a thing", "goal", settings);
		assert.ok(out.includes("goal_questionnaire"), "must reference the available ask tool");
	});
});

// ---------------------------------------------------------------------------
// 8. goalTweakDraftingPrompt — pause_goal line (NG1)
// ---------------------------------------------------------------------------

describe("goalTweakDraftingPrompt — pause_goal line (NG1)", () => {
	it("disabledTools: [pause_goal] → does NOT contain 'Do NOT call pause_goal' line", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		const out = goalTweakDraftingPrompt(makeGoal({ id: "gT" }), "make it faster", settings);
		assert.ok(
			!out.includes("Do NOT call pause_goal"),
			"'Do NOT call pause_goal' line must be omitted when tool disabled",
		);
	});
});

// ---------------------------------------------------------------------------
// 9. goalTweakDraftingPrompt — ask-tool (S3)
// ---------------------------------------------------------------------------

describe("goalTweakDraftingPrompt — ask-tool reference (S3)", () => {
	it("only goal_question disabled → references goal_questionnaire", () => {
		const settings: GoalSettings = { disabledTools: ["goal_question"] };
		const out = goalTweakDraftingPrompt(makeGoal({ id: "gT" }), "tweak it", settings);
		assert.ok(
			out.includes("goal_questionnaire"),
			"goalTweakDraftingPrompt must reference the available ask tool",
		);
	});
});
