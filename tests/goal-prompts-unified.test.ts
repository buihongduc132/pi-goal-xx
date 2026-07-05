/**
 * RED PHASE — unified resolver integration into the 6 runtime prompts.
 *
 * Spec: openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 * Tasks: group 3 (3.1–3.5)
 *
 * Contract under test (GREEN implements):
 *  - goalPrompt / continuationPrompt consult unified `prompts.goal-running`
 *    / `prompts.goal-continuation` (in addition to the legacy goalPrompt key).
 *  - goalTweakDraftingPrompt / staleContinuationPrompt / unfocusedOpenGoalsPrompt
 *    / goalDraftingPrompt gain optional (settings?, cwd?) params and consult
 *    unified prompts.<key>.
 *  - append mode: the resolved block is appended to the hardcoded body.
 *  - override mode: the resolved block REPLACES the hardcoded instruction
 *    body, but load-bearing DYNAMIC markers ([PI GOAL ACTIVE] / objective /
 *    task list for goal+continuation) are preserved (they are computed at
 *    runtime, not part of the hardcoded default).
 *  - custom promptsDir honored.
 *  - legacy goalPrompt flat key still works (backward compat).
 *
 * Today most of these FAIL (unified path not wired into the 6 fns).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	goalPrompt,
	continuationPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
} from "../extensions/prompts/goal-prompts.ts";
import { goalDraftingPrompt } from "../extensions/goal-draft.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "test-goal-1",
		objective: "=== Goal ===\nObjective: test objective",
		status: "running",
		sisyphus: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as GoalRecord;
}

function tmpCwdWithPrompt(key: string, body: string, dir = ".pi/pi-goal-xx/prompts/"): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-prompts-"));
	const local = path.join(cwd, dir, `${key}.md`);
	fs.mkdirSync(path.dirname(local), { recursive: true });
	fs.writeFileSync(local, body, "utf8");
	return cwd;
}

// ---------------------------------------------------------------------------
// goalPrompt — unified prompts.goal-running
// ---------------------------------------------------------------------------

describe("goalPrompt — unified prompts.goal-running", () => {
	it("append mode injects unified block after hardcoded body", () => {
		const cwd = tmpCwdWithPrompt("goal-running", "UNIFIED-RUNNING-RULE");
		const goal = makeGoal();
		const settings: GoalSettings = {
			prompts: { "goal-running": { mode: "append" } },
		};
		const out = goalPrompt(goal, settings, cwd);
		assert.ok(out.includes("UNIFIED-RUNNING-RULE"), "append block must appear");
		assert.ok(out.includes("[PI GOAL ACTIVE"), "lifecycle marker preserved");
		assert.ok(out.includes("test objective"), "objective preserved");
	});

	it("override mode replaces hardcoded instructions but preserves dynamic markers", () => {
		const goal = makeGoal();
		const settings: GoalSettings = {
			prompts: { "goal-running": { mode: "override", inline: "OVERRIDE-ONLY-INSTRUCTIONS" } },
		};
		const out = goalPrompt(goal, settings, "/nonexistent-cwd");
		assert.ok(out.includes("OVERRIDE-ONLY-INSTRUCTIONS"), "override body present");
		// Dynamic, load-bearing markers MUST survive override.
		assert.ok(out.includes("[PI GOAL ACTIVE"), "marker preserved under override");
		assert.ok(out.includes("test objective"), "objective preserved under override");
	});

	it("custom promptsDir honored", () => {
		const cwd = tmpCwdWithPrompt("goal-running", "CUSTOM-DIR-BODY", ".pi/my-prompts/");
		const settings: GoalSettings = {
			prompts: { "goal-running": { mode: "append" } },
			promptsDir: ".pi/my-prompts/",
		};
		const out = goalPrompt(makeGoal(), settings, cwd);
		assert.ok(out.includes("CUSTOM-DIR-BODY"));
	});

	it("legacy goalPrompt flat key still works (backward compat)", () => {
		const settings: GoalSettings = {
			goalPrompt: "LEGACY-GOAL-PROMPT",
			goalPromptMode: "local",
		};
		const out = goalPrompt(makeGoal(), settings, "/nonexistent");
		assert.ok(out.includes("LEGACY-GOAL-PROMPT"));
	});
});

// ---------------------------------------------------------------------------
// continuationPrompt — unified prompts.goal-continuation
// ---------------------------------------------------------------------------

describe("continuationPrompt — unified prompts.goal-continuation", () => {
	it("append mode injects unified block", () => {
		const cwd = tmpCwdWithPrompt("goal-continuation", "UNIFIED-CONT-RULE");
		const settings: GoalSettings = {
			prompts: { "goal-continuation": { mode: "append" } },
		};
		const out = continuationPrompt(makeGoal(), settings, cwd);
		assert.ok(out.includes("UNIFIED-CONT-RULE"));
		assert.ok(out.includes("test objective"));
	});

	it("override mode preserves checkpoint marker + objective", () => {
		const settings: GoalSettings = {
			prompts: { "goal-continuation": { mode: "override", inline: "OVERRIDE-CONT" } },
		};
		const out = continuationPrompt(makeGoal(), settings, "/nonexistent");
		assert.ok(out.includes("OVERRIDE-CONT"));
		assert.ok(out.includes("pi_goal_continuation"), "outer marker preserved");
		assert.ok(out.includes("test objective"));
	});
});

// ---------------------------------------------------------------------------
// goalTweakDraftingPrompt — gains settings/cwd, unified prompts.goal-tweak
// ---------------------------------------------------------------------------

describe("goalTweakDraftingPrompt — unified prompts.goal-tweak", () => {
	it("append mode injects unified block", () => {
		const cwd = tmpCwdWithPrompt("goal-tweak", "TWEAK-RULE");
		const settings: GoalSettings = {
			prompts: { "goal-tweak": { mode: "append" } },
		};
		const out = goalTweakDraftingPrompt(makeGoal(), "hint", settings, cwd);
		assert.ok(out.includes("TWEAK-RULE"));
	});

	it("works without settings/cwd (backward compat)", () => {
		const out = goalTweakDraftingPrompt(makeGoal(), "hint");
		assert.ok(out.includes("GOAL TWEAK DRAFTING"));
	});
});

// ---------------------------------------------------------------------------
// staleContinuationPrompt — gains settings/cwd, unified prompts.goal-stale
// ---------------------------------------------------------------------------

describe("staleContinuationPrompt — unified prompts.goal-stale", () => {
	it("append mode injects unified block", () => {
		const cwd = tmpCwdWithPrompt("goal-stale", "STALE-RULE");
		const settings: GoalSettings = {
			prompts: { "goal-stale": { mode: "append" } },
		};
		const out = staleContinuationPrompt("stale-1", null, settings, cwd);
		assert.ok(out.includes("STALE-RULE"));
	});

	it("works without settings/cwd (backward compat)", () => {
		const out = staleContinuationPrompt("stale-1", null);
		assert.ok(out.includes("GOAL STALE"));
	});
});

// ---------------------------------------------------------------------------
// unfocusedOpenGoalsPrompt — gains settings/cwd, unified prompts.goal-unfocused
// ---------------------------------------------------------------------------

describe("unfocusedOpenGoalsPrompt — unified prompts.goal-unfocused", () => {
	it("append mode injects unified block", () => {
		const cwd = tmpCwdWithPrompt("goal-unfocused", "UNFOCUSED-RULE");
		const settings: GoalSettings = {
			prompts: { "goal-unfocused": { mode: "append" } },
		};
		const out = unfocusedOpenGoalsPrompt(2, settings, cwd);
		assert.ok(out.includes("UNFOCUSED-RULE"));
	});

	it("works without settings/cwd (backward compat)", () => {
		const out = unfocusedOpenGoalsPrompt(2);
		assert.ok(out.includes("PI GOAL UNFOCUSED"));
	});
});

// ---------------------------------------------------------------------------
// goalDraftingPrompt — gains settings/cwd, unified prompts.goal-drafting
// ---------------------------------------------------------------------------

describe("goalDraftingPrompt — unified prompts.goal-drafting", () => {
	it("append mode injects unified block", () => {
		const cwd = tmpCwdWithPrompt("goal-drafting", "DRAFTING-RULE");
		const settings: GoalSettings = {
			prompts: { "goal-drafting": { mode: "append" } },
		};
		const out = goalDraftingPrompt("topic", "goals", settings, cwd);
		assert.ok(out.includes("DRAFTING-RULE"));
	});

	it("works without settings/cwd (backward compat)", () => {
		const out = goalDraftingPrompt("topic", "goals");
		assert.ok(out.length > 0);
	});
});
