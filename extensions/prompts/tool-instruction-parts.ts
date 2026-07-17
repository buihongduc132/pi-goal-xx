/**
 * Granular per-tool-instruction prompt building.
 *
 * When a lifecycle tool (`pause_goal`, `goal_question`, `abort_goal`,
 * `complete_goal`) is in `settings.disabledTools`, the default prompt
 * instruction for that tool is suppressed. The user can supply a replacement
 * via `settings.toolInstructions[name]`, which is resolved through the existing
 * `resolvePrompt` resolver (key: `tool-instruction-<name>`).
 *
 * Why a separate module:
 *  - `goalPrompt`/`continuationPrompt` use a verbose `pause_goal` paragraph;
 *    `sisyphusDisciplineBlock` uses a one-liner bullet — two DIFFERENT default
 *    texts for the same tool (G2). Splitting into dedicated helpers prevents
 *    injecting the wrong text.
 *  - `askUserInstruction` is pair-gated (both ask-tools must be disabled to
 *    suppress; one disabled → single-tool text references the available tool).
 *
 * See: openspec/changes/add-prompt-tool-instruction-config/
 */

import { resolvePrompt, type PromptConfig } from "../prompt-resolver.ts";
import type { GoalSettings } from "../goal-settings.ts";

// ---------------------------------------------------------------------------
// Default instruction texts (extracted verbatim from goal-prompts.ts)
// ---------------------------------------------------------------------------

/** Verbose `pause_goal` paragraph — used in goalPrompt + continuationPrompt bodies. */
export const DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION =
	"If you hit a real blocker that you cannot resolve with one more reasonable next step (missing credentials, contradictory spec, file/permission you cannot access, dangerous operation pending user approval, or an unclear Sisyphus-style ordered plan), the CORRECT action is to call pause_goal({reason, suggestedAction?}) with a structured, non-empty reason. pause_goal IS the channel for handing control back to the user — do not substitute a conversational \"blocked, please help\" summary in your final message and skip the tool call. Without pause_goal, the goal stays \"active\" and the UI cannot show the blocker. After pause_goal returns, you may add one short user-facing summary, but the tool call comes first.";

/** One-liner `pause_goal` bullet — used in sisyphusDisciplineBlock only. (G2 split) */
export const DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET =
	"- If a step is unclear, blocked, fails, or seems wrong: call pause_goal({reason, suggestedAction?}) instead of inventing a workaround.";

/** Original `pause_goal` line from goalTweakDraftingPrompt — distinct from the body. (NG1) */
export const DEFAULT_PAUSE_GOAL_TWEAK_INSTRUCTION =
	"- Do NOT call pause_goal during this drafting interview (it pauses execution — you are not executing, you are revising).";

/** Default ask-user instruction — references both ask-tools. */
export const DEFAULT_ASK_USER_INSTRUCTION =
	"To ask the user a structured question (e.g. when the user's spec changes and you need to clarify before updating the goal), use goal_question. It opens a question dialog and returns the user's answer as tool output. Use plain conversation for simple clarifications.";

/** Default `abort_goal` instruction. */
export const DEFAULT_ABORT_GOAL_INSTRUCTION =
	"If the user explicitly asks to abandon/cancel this goal, or the objective is obsolete, impossible, or unsafe to continue and should not be marked complete, call abort_goal({reason}) with a non-empty reason and stop.";

/** Default `complete_goal` instruction (verbose paragraph). */
export const DEFAULT_COMPLETE_GOAL_INSTRUCTION =
	"Keep this goal in force until it is actually achieved. Do not pause for confirmation just because a phase, chapter, file, or checklist item is finished. At each natural stopping point, compare every explicit requirement with concrete evidence from the workspace/session. If the objective is complete, call complete_goal and provide a verificationSummary; complete_goal will launch an independent pi auditor agent and only archive if that auditor returns <approved/>. If it is not complete, choose the next concrete action and do it.";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isToolDisabled(settings: GoalSettings | undefined, toolName: string): boolean {
	return Boolean(settings?.disabledTools?.includes(toolName));
}

/**
 * Resolve a per-tool replacement via `toolInstructions[name]`.
 * Returns the resolved text (source !== "none") or "" when no replacement
 * resolves (empty file, no inline, mode "off" with no inline).
 *
 * Resolution key pattern: `tool-instruction-<toolName>` (file lookup under
 * the standard promptsDir: `tool-instruction-<toolName>.md`).
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
	// Tool instructions have no hardcoded default to append to, so `final`
	// would carry a leading "\n\n" separator from the empty default.
	return resolved.source === "none" ? "" : (resolved.injected ?? resolved.final);
}

/**
 * Generic helper skeleton: returns the default text when the tool is enabled,
 * the replacement (or "") when disabled.
 *
 * @param toolName    Lifecycle tool name.
 * @param defaultText Default instruction text (caller picks the context-correct one).
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

/**
 * Ask-tool pair gate. Suppresses ONLY when BOTH `goal_question` and
 * `goal_questionnaire` are disabled. When exactly one is disabled, returns
 * a single-tool template referencing the available tool (G3).
 */
function askUserInstructionInternal(
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): string {
	const qDisabled = isToolDisabled(settings, "goal_question");
	const qqDisabled = isToolDisabled(settings, "goal_questionnaire");
	if (!qDisabled && !qqDisabled) return DEFAULT_ASK_USER_INSTRUCTION;
	if (qDisabled && qqDisabled) {
		// Both off: prefer goal_question config, then goal_questionnaire.
		const fromQ = resolveToolReplacement("goal_question", settings, cwd);
		if (fromQ) return fromQ;
		const fromQq = resolveToolReplacement("goal_questionnaire", settings, cwd);
		return fromQq;
	}
	// Exactly one disabled → single-tool text referencing the available one.
	const available = qDisabled ? "goal_questionnaire" : "goal_question";
	return DEFAULT_ASK_USER_SINGLE_TEMPLATE(available);
}

/**
 * Parameterized template for the single-tool-disabled case (G3). Avoids
 * referencing a tool that does not exist.
 */
export function DEFAULT_ASK_USER_SINGLE_TEMPLATE(availableTool: string): string {
	return `To ask the user a structured question (e.g. when the user's spec changes and you need to clarify before updating the goal), use ${availableTool}. It opens a question dialog and returns the user's answer as tool output. Use plain conversation for simple clarifications.`;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Verbose `pause_goal` paragraph for goalPrompt/continuationPrompt bodies. */
export function pauseGoalBodyInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_BODY_INSTRUCTION, settings, cwd);
}

/** One-liner `pause_goal` bullet for sisyphusDisciplineBlock only. (G2) */
export function pauseGoalSisyphusBullet(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_SISYPHUS_BULLET, settings, cwd);
}

/** `pause_goal` line for goalTweakDraftingPrompt — distinct default. (NG1) */
export function pauseGoalTweakInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("pause_goal", DEFAULT_PAUSE_GOAL_TWEAK_INSTRUCTION, settings, cwd);
}

/** Pair-gated ask-user instruction (suppress only when both ask-tools disabled). */
export function askUserInstruction(settings?: GoalSettings, cwd?: string): string {
	return askUserInstructionInternal(settings, cwd);
}

/** `abort_goal` instruction. */
export function abortGoalInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("abort_goal", DEFAULT_ABORT_GOAL_INSTRUCTION, settings, cwd);
}

/** `complete_goal` instruction (verbose paragraph). */
export function completeGoalInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("complete_goal", DEFAULT_COMPLETE_GOAL_INSTRUCTION, settings, cwd);
}
