/**
 * Granular per-tool-instruction prompt building.
 *
 * When a lifecycle tool (`complete_goal`) is in `settings.disabledTools`, the
 * default prompt instruction for that tool is suppressed. The user can supply
 * a replacement via `settings.toolInstructions[name]`, which is resolved through
 * the existing `resolvePrompt` resolver (key: `tool-instruction-<name>`).
 *
 * See: openspec/changes/add-prompt-tool-instruction-config/
 */

import { resolvePrompt, type PromptConfig } from "../prompt-resolver.ts";
import type { GoalSettings } from "../goal-settings.ts";

// ---------------------------------------------------------------------------
// Default instruction texts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** `complete_goal` instruction (verbose paragraph). */
export function completeGoalInstruction(settings?: GoalSettings, cwd?: string): string {
	return instructionFor("complete_goal", DEFAULT_COMPLETE_GOAL_INSTRUCTION, settings, cwd);
}
