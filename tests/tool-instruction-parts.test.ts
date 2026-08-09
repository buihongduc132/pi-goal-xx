/**
 * RED PHASE — instruction helper module (tasks 2.13).
 *
 * Spec: openspec/changes/add-prompt-tool-instruction-config/specs/prompt-config-resolution/spec.md
 * Design: openspec/changes/add-prompt-tool-instruction-config/design.md (D3)
 *
 * Contract under test (GREEN implements):
 *  - New module `extensions/prompts/tool-instruction-parts.ts`.
 *  - Exports DEFAULT_* constants and helper functions.
 *  - Each helper: tool enabled → default text; disabled + no config → "";
 *    disabled + config → resolved text.
 *  - askUserInstruction: pair gating (both disabled → suppress; one disabled → single-tool text).
 *  - pauseGoalBodyInstruction vs pauseGoalSisyphusBullet: different defaults (G2).
 *  - pauseGoalTweakInstruction: NG1 — separate helper for the tweak prompt line.
 *
 * Today these FAIL: the module does not exist yet.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	pauseGoalBodyInstruction,
	pauseGoalSisyphusBullet,
	pauseGoalTweakInstruction,
	askUserInstruction,
	abortGoalInstruction,
	completeGoalInstruction,
	DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION,
	DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET,
	DEFAULT_ASK_USER_INSTRUCTION,
	DEFAULT_ABORT_GOAL_INSTRUCTION,
	DEFAULT_COMPLETE_GOAL_INSTRUCTION,
} from "../extensions/prompts/tool-instruction-parts.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a tmp cwd with a tool-instruction file at the default promptsDir. */
function tmpCwdWithToolInstruction(toolName: string, body: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-tiparts-"));
	const local = path.join(cwd, ".pi", "pi-goal-xx", "prompts", `tool-instruction-${toolName}.md`);
	fs.mkdirSync(path.dirname(local), { recursive: true });
	fs.writeFileSync(local, body, "utf8");
	return cwd;
}

// ---------------------------------------------------------------------------
// 1. pauseGoalBodyInstruction
// ---------------------------------------------------------------------------

describe("pauseGoalBodyInstruction", () => {
	it("tool enabled → returns default text", () => {
		const out = pauseGoalBodyInstruction(undefined, undefined);
		assert.ok(out.length > 0, "should return non-empty default");
		assert.equal(out, DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION);
	});

	it("tool disabled + no config → empty string", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		assert.equal(pauseGoalBodyInstruction(settings, undefined), "");
	});

	it("tool disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["pause_goal"],
			toolInstructions: { pause_goal: { inline: "Use intercom instead." } },
		};
		const out = pauseGoalBodyInstruction(settings, undefined);
		assert.equal(out, "Use intercom instead.");
	});

	it("tool disabled + file config → file content returned", () => {
		const cwd = tmpCwdWithToolInstruction("pause_goal", "FILE: call intercom.");
		try {
			const settings: GoalSettings = {
				disabledTools: ["pause_goal"],
				toolInstructions: { pause_goal: { mode: "local" } },
			};
			const out = pauseGoalBodyInstruction(settings, cwd);
			assert.equal(out, "FILE: call intercom.");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("tool disabled + empty file + no inline → empty string", () => {
		const cwd = tmpCwdWithToolInstruction("pause_goal", "");
		try {
			const settings: GoalSettings = {
				disabledTools: ["pause_goal"],
				toolInstructions: { pause_goal: { mode: "local" } },
			};
			const out = pauseGoalBodyInstruction(settings, cwd);
			assert.equal(out, "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 2. pauseGoalSisyphusBullet
// ---------------------------------------------------------------------------

describe("pauseGoalSisyphusBullet", () => {
	it("tool enabled → returns default text", () => {
		const out = pauseGoalSisyphusBullet(undefined, undefined);
		assert.ok(out.length > 0, "should return non-empty default");
		assert.equal(out, DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET);
	});

	it("tool disabled + no config → empty string", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		assert.equal(pauseGoalSisyphusBullet(settings, undefined), "");
	});

	it("tool disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["pause_goal"],
			toolInstructions: { pause_goal: { inline: "Ask via intercom." } },
		};
		const out = pauseGoalSisyphusBullet(settings, undefined);
		assert.equal(out, "Ask via intercom.");
	});

	it("tool disabled + file config → file content returned", () => {
		const cwd = tmpCwdWithToolInstruction("pause_goal", "FILE: sis bullet replacement");
		try {
			const settings: GoalSettings = {
				disabledTools: ["pause_goal"],
				toolInstructions: { pause_goal: { mode: "local" } },
			};
			const out = pauseGoalSisyphusBullet(settings, cwd);
			assert.equal(out, "FILE: sis bullet replacement");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("tool disabled + empty file + no inline → empty string", () => {
		const cwd = tmpCwdWithToolInstruction("pause_goal", "   ");
		try {
			const settings: GoalSettings = {
				disabledTools: ["pause_goal"],
				toolInstructions: { pause_goal: { mode: "local" } },
			};
			const out = pauseGoalSisyphusBullet(settings, cwd);
			assert.equal(out, "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 3. G2 assertion — body vs sisyphus bullet are DIFFERENT defaults
// ---------------------------------------------------------------------------

describe("G2: pauseGoalBodyInstruction vs pauseGoalSisyphusBullet — different defaults", () => {
	it("enabled → DIFFERENT default texts", () => {
		const body = pauseGoalBodyInstruction(undefined, undefined);
		const bullet = pauseGoalSisyphusBullet(undefined, undefined);
		assert.notEqual(body, bullet, "body and sisyphus bullet must be different text constants");
		assert.ok(body.length > bullet.length, "body paragraph should be longer than the one-liner bullet");
	});
});

// ---------------------------------------------------------------------------
// 4. askUserInstruction
// ---------------------------------------------------------------------------

describe("askUserInstruction", () => {
	it("neither tool disabled → returns default text", () => {
		const out = askUserInstruction(undefined, undefined);
		assert.ok(out.length > 0);
		assert.equal(out, DEFAULT_ASK_USER_INSTRUCTION);
	});

	it("both disabled + no config → empty string", () => {
		const settings: GoalSettings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
		};
		assert.equal(askUserInstruction(settings, undefined), "");
	});

	it("both disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["goal_question", "goal_questionnaire"],
			toolInstructions: { goal_question: { inline: "Use intercom to ask." } },
		};
		const out = askUserInstruction(settings, undefined);
		assert.equal(out, "Use intercom to ask.");
	});

	it("both disabled + file config → file content returned", () => {
		const cwd = tmpCwdWithToolInstruction("goal_question", "FILE: ask replacement");
		try {
			const settings: GoalSettings = {
				disabledTools: ["goal_question", "goal_questionnaire"],
				toolInstructions: { goal_question: { mode: "local" } },
			};
			const out = askUserInstruction(settings, cwd);
			assert.equal(out, "FILE: ask replacement");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("both disabled + empty file + no inline → empty string", () => {
		const cwd = tmpCwdWithToolInstruction("goal_question", "");
		try {
			const settings: GoalSettings = {
				disabledTools: ["goal_question", "goal_questionnaire"],
				toolInstructions: { goal_question: { mode: "local" } },
			};
			const out = askUserInstruction(settings, cwd);
			assert.equal(out, "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("only goal_question disabled → single-tool text referencing goal_questionnaire (G3)", () => {
		const settings: GoalSettings = { disabledTools: ["goal_question"] };
		const out = askUserInstruction(settings, undefined);
		assert.ok(out.length > 0, "should NOT be suppressed when only one tool disabled");
		assert.ok(out.includes("goal_questionnaire"), "must reference the available tool");
		assert.ok(!out.includes("goal_question.") || out.includes("goal_questionnaire"),
			"must not reference the disabled tool as available");
	});

	it("only goal_questionnaire disabled → single-tool text referencing goal_question", () => {
		const settings: GoalSettings = { disabledTools: ["goal_questionnaire"] };
		const out = askUserInstruction(settings, undefined);
		assert.ok(out.length > 0, "should NOT be suppressed when only one tool disabled");
		assert.ok(out.includes("goal_question"), "must reference the available tool");
	});
});

// ---------------------------------------------------------------------------
// 5. abortGoalInstruction
// ---------------------------------------------------------------------------

describe("abortGoalInstruction", () => {
	it("tool enabled → returns default text", () => {
		const out = abortGoalInstruction(undefined, undefined);
		assert.ok(out.length > 0);
		assert.equal(out, DEFAULT_ABORT_GOAL_INSTRUCTION);
	});

	it("tool disabled + no config → empty string", () => {
		const settings: GoalSettings = { disabledTools: ["abort_goal"] };
		assert.equal(abortGoalInstruction(settings, undefined), "");
	});

	it("tool disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["abort_goal"],
			toolInstructions: { abort_goal: { inline: "Use intercom to abort." } },
		};
		assert.equal(abortGoalInstruction(settings, undefined), "Use intercom to abort.");
	});

	it("tool disabled + file config → file content returned", () => {
		const cwd = tmpCwdWithToolInstruction("abort_goal", "FILE: abort replacement");
		try {
			const settings: GoalSettings = {
				disabledTools: ["abort_goal"],
				toolInstructions: { abort_goal: { mode: "local" } },
			};
			assert.equal(abortGoalInstruction(settings, cwd), "FILE: abort replacement");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("tool disabled + empty file + no inline → empty string", () => {
		const cwd = tmpCwdWithToolInstruction("abort_goal", "");
		try {
			const settings: GoalSettings = {
				disabledTools: ["abort_goal"],
				toolInstructions: { abort_goal: { mode: "local" } },
			};
			assert.equal(abortGoalInstruction(settings, cwd), "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 6. completeGoalInstruction
// ---------------------------------------------------------------------------

describe("completeGoalInstruction", () => {
	it("tool enabled → returns default text", () => {
		const out = completeGoalInstruction(undefined, undefined);
		assert.ok(out.length > 0);
		assert.equal(out, DEFAULT_COMPLETE_GOAL_INSTRUCTION);
	});

	it("tool disabled + no config → empty string", () => {
		const settings: GoalSettings = { disabledTools: ["complete_goal"] };
		assert.equal(completeGoalInstruction(settings, undefined), "");
	});

	it("tool disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["complete_goal"],
			toolInstructions: { complete_goal: { inline: "Check via auditor." } },
		};
		assert.equal(completeGoalInstruction(settings, undefined), "Check via auditor.");
	});

	it("tool disabled + file config → file content returned", () => {
		const cwd = tmpCwdWithToolInstruction("complete_goal", "FILE: complete replacement");
		try {
			const settings: GoalSettings = {
				disabledTools: ["complete_goal"],
				toolInstructions: { complete_goal: { mode: "local" } },
			};
			assert.equal(completeGoalInstruction(settings, cwd), "FILE: complete replacement");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("tool disabled + empty file + no inline → empty string", () => {
		const cwd = tmpCwdWithToolInstruction("complete_goal", "");
		try {
			const settings: GoalSettings = {
				disabledTools: ["complete_goal"],
				toolInstructions: { complete_goal: { mode: "local" } },
			};
			assert.equal(completeGoalInstruction(settings, cwd), "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 7. pauseGoalTweakInstruction (NG1)
// ---------------------------------------------------------------------------

describe("pauseGoalTweakInstruction (NG1)", () => {
	it("tool enabled → returns the original 'Do NOT call pause_goal' line", () => {
		const out = pauseGoalTweakInstruction(undefined, undefined);
		assert.ok(out.includes("Do NOT call pause_goal"), "must contain the original tweak instruction text");
		assert.ok(out.includes("drafting interview"), "must mention drafting context");
	});

	it("tool disabled + no config → empty string", () => {
		const settings: GoalSettings = { disabledTools: ["pause_goal"] };
		assert.equal(pauseGoalTweakInstruction(settings, undefined), "");
	});

	it("tool disabled + inline config → inline text returned", () => {
		const settings: GoalSettings = {
			disabledTools: ["pause_goal"],
			toolInstructions: { pause_goal: { inline: "No pausing during tweaks." } },
		};
		assert.equal(pauseGoalTweakInstruction(settings, undefined), "No pausing during tweaks.");
	});
});
