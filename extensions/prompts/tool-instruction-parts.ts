/**
 * Granular per-tool-instruction prompt building.
 *
 * When a lifecycle tool is in `settings.disabledTools`, the default prompt
 * instruction for that tool is suppressed. The user can supply a replacement
 * via `settings.toolInstructions[name]`, resolved through the existing
 * `resolvePrompt` resolver (key: `tool-instruction-<name>`).
 *
 * See: openspec/changes/add-prompt-tool-instruction-config/
 */

import { resolvePrompt, type PromptConfig } from "../prompt-resolver.ts";
import type { GoalSettings } from "../goal-settings.ts";

// ---------------------------------------------------------------------------
// Default instruction texts
// ---------------------------------------------------------------------------

/**
 * Default `pause_goal` body instruction (verbose paragraph).
 *
 * Fork invariant (extensions/goal-tool-names.ts): the block/question/pause
 * agent tools were REMOVED from this fork — pause/abort remain user slash
 * commands (/goal-pause, /goal-abort). The default is therefore tool-less
 * (main's original wording): state the blocker in the final message and stop.
 */
export const DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION =
	"If you hit a real blocker that you cannot resolve with one more reasonable next step (missing credentials, contradictory spec, file/permission you cannot access, dangerous operation pending user approval, or an unclear Sisyphus-style ordered plan), state the blocker concisely in your final message and stop — the user will intervene. Do not invent workarounds, do not fake completion, do not silently redefine the objective, and do not use complete_goal=complete to escape a blocker.";

/**
 * Default `pause_goal` Sisyphus bullet (one-liner).
 * Tool-less for the same fork-invariant reason as the body instruction above.
 */
export const DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET =
	"If a step is unclear, blocked, fails, or seems wrong: state the blocker in your final message and stop — do not invent a workaround.";

/**
 * Default `goal_question` / `goal_questionnaire` ask-user instruction.
 * Tool-less (fork invariant): the ask agent tools are not registered in this
 * fork, so the default must not instruct the agent to call them. Plain
 * conversation is the sanctioned clarification path.
 */
export const DEFAULT_ASK_USER_INSTRUCTION =
	"To clarify something with the user mid-work (e.g. when the user's spec changes and you need to confirm before updating the goal), use plain conversation and ask plainly in your message. Do NOT use workhorse/reconnaissance tools for clarification.";

/**
 * Default `abort_goal` instruction.
 * Tool-less (fork invariant): abort is a user slash command, not an agent tool.
 */
export const DEFAULT_ABORT_GOAL_INSTRUCTION =
	"If the user explicitly asks to abandon/cancel this goal, or the objective is obsolete, impossible, or unsafe to continue and should not be marked complete, state that in your final message and stop — the user can run /goal-abort or /goal-clear to dispose of the goal.";

/** Default `complete_goal` instruction (verbose paragraph). */
export const DEFAULT_COMPLETE_GOAL_INSTRUCTION =
	"Keep this goal in force until it is actually achieved. Do not pause for confirmation just because a phase, chapter, file, or checklist item is finished. At each natural stopping point, compare every explicit requirement with concrete evidence from the workspace/session. If the objective is complete, call complete_goal and provide a verificationSummary; complete_goal will launch an independent pi auditor agent and only archive if that auditor returns <approved/>. If it is not complete, choose the next concrete action and do it.";

/**
 * Default `pause_goal` tweak-drafting instruction (NG1).
 * Exact original NG1 line (openspec add-prompt-tool-instruction-config task 4.6),
 * preserving the "it pauses execution" explanation.
 */
const DEFAULT_PAUSE_GOAL_TWEAK_INSTRUCTION =
	"Do NOT call pause_goal during this drafting interview (it pauses execution — you are not executing, you are revising).";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isToolDisabled(settings: GoalSettings | undefined, toolName: string): boolean {
	return Boolean(settings?.disabledTools?.includes(toolName));
}

/**
 * Both ask tools (goal_question + goal_questionnaire) disabled?
 * Callers use this to suppress "ask tool" advertising when no ask tool
 * can actually be called.
 */
export function bothAskToolsDisabled(settings: GoalSettings | undefined): boolean {
	return isToolDisabled(settings, "goal_question") && isToolDisabled(settings, "goal_questionnaire");
}

/**
 * Resolve a per-tool replacement via `toolInstructions[name]`.
 * Returns the resolved text (source !== "none") or "" when no replacement 
 * resolves (empty file, no inline, mode "off" with no inline).
 *
 * Resolution key: `tool-instruction-<toolName>` (file: `tool-instruction-<toolName>.md`).
 */
function resolveToolReplacement(
	toolName: string,
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	const cfg: PromptConfig | undefined = settings?.toolInstructions?.[toolName];
	if (!cfg) return "";
	const resolved = resolvePrompt(
		`tool-instruction-${toolName}`,
		cfg,
		cwd ?? ".",
		"",
		{ promptsDir: settings?.promptsDir },
	);
	// Use `.injected` (raw block body), NOT `.final` (default + "\n\n" + body).
	// Tool instructions have no hardcoded default to prepend, so `final`
	// would carry a leading "\n\n" separator from the empty default.
	return resolved.source === "none" ? "" : (resolved.injected ?? resolved.final);
}

/**
 * Generic helper: returns `defaultText` when the tool is enabled;
 * when disabled returns the replacement (or "" when no replacement resolves).
 */
function instructionFor(
	toolName: string,
	defaultText: string,
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	if (!isToolDisabled(settings, toolName)) return defaultText;
	return resolveToolReplacement(toolName, settings, cwd);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** `pause_goal` body instruction (verbose paragraph). */
export function pauseGoalBodyInstruction(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION, settings, cwd);
}

/** `pause_goal` Sisyphus bullet instruction (one-liner). */
export function pauseGoalSisyphusBullet(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET, settings, cwd);
}

/**
 * `pause_goal` tweak-drafting instruction (NG1).
 * Separate helper so callers in the tweak prompt can independently suppress
 * or replace this specific line without affecting the body/sisyphus variants.
 */
export function pauseGoalTweakInstruction(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_TWEAK_INSTRUCTION, settings, cwd);
}

/**
 * Ask-user instruction with pair gating.
 *
 * Gating rules:
 *   - Neither disabled → DEFAULT_ASK_USER_INSTRUCTION.
 *   - Both disabled + no config → "".
 *   - Both disabled + config (on goal_question) → resolved replacement.
 *   - Only goal_question disabled → single-tool text mentioning goal_questionnaire.
 *   - Only goal_questionnaire disabled → single-tool text mentioning goal_question.
 */
export function askUserInstruction(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	const qDisabled = isToolDisabled(settings, "goal_question");
	const qqDisabled = isToolDisabled(settings, "goal_questionnaire");

	// Neither disabled → full default.
	if (!qDisabled && !qqDisabled) return DEFAULT_ASK_USER_INSTRUCTION;

	// Both disabled → suppress, or use replacement. The `goal_question` key is
	// checked first; when it does not resolve, fall back to the
	// `goal_questionnaire` replacement so a questionnaire-only config is not
	// silently dropped.
	if (qDisabled && qqDisabled) {
		const qReplacement = resolveToolReplacement("goal_question", settings, cwd);
		if (qReplacement) return qReplacement;
		return resolveToolReplacement("goal_questionnaire", settings, cwd);
	}

	// Only goal_questionnaire disabled → mention goal_question only.
	if (!qDisabled && qqDisabled) {
		return "To clarify something with the user mid-work, use goal_question to ask a single question. It returns user intent into the conversation. Do NOT use workhorse/reconnaissance tools for clarification.";
	}

	// Only goal_question disabled → mention goal_questionnaire only.
	return "To clarify something with the user mid-work, use goal_questionnaire to ask structured questions. It returns user intent into the conversation. Do NOT use workhorse/reconnaissance tools for clarification.";
}

/** `abort_goal` instruction. */
export function abortGoalInstruction(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	return instructionFor("abort_goal", DEFAULT_ABORT_GOAL_INSTRUCTION, settings, cwd);
}

/** `complete_goal` instruction (verbose paragraph). */
export function completeGoalInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("complete_goal", DEFAULT_COMPLETE_GOAL_INSTRUCTION, settings, cwd);
}
