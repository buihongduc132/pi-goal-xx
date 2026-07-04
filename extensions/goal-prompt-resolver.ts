/**
 * Goal prompt resolution — mirrors auditor-prompt.ts.
 *
 * Lets the user inject a CUSTOM block into the runtime goal/continuation
 * system prompts WITHOUT modifying the hardcoded lifecycle instructions.
 * The drafting prompts (/goal, /sisyphus) live in pi-core tool schema and
 * are out of reach of this package.
 *
 * Resolution order (first non-empty wins):
 *   1. Inline `settings.goalPrompt` (always takes precedence)
 *   2. File-based prompt(s), combined per `goalPromptMode`:
 *        - "global-local"       : local overrides global completely (local wins if present)
 *        - "local"              : only `.pi/goal-prompt.md`, global never checked
 *        - "global-local-merge" : global + "\n\n" + local (local appended)
 *   3. No fallback (returns empty string → no custom block injected)
 *
 * File locations:
 *   global: `<home>/.pi/goal-prompt.md`
 *   local : `<cwd>/.pi/goal-prompt.md`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSettings, AuditorPromptMode } from "./goal-settings.ts";

/** Re-use the same mode enum as auditor — same semantics. */
export type GoalPromptMode = AuditorPromptMode;

/** Result of resolving the goal custom prompt. */
export interface ResolvedGoalPrompt {
	/** The final custom prompt text (empty string when none configured). */
	prompt: string;
	/** Where the prompt came from. */
	source:
		| "inline" // settings.goalPrompt
		| "local" // .pi/goal-prompt.md (local mode or global-local with local present)
		| "global" // ~/.pi/goal-prompt.md (global-local without local, or merge without local)
		| "merged" // global-local-merge with both present
		| "none"; // nothing configured
}

/** Resolve the effective prompt mode, defaulting to "global-local". */
export function resolveGoalPromptMode(settings?: GoalSettings): GoalPromptMode {
	return settings?.goalPromptMode ?? "global-local";
}

/** Read a file's content if it exists and is non-empty, else undefined. */
function readFileIfExists(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

/** Compute the global prompt path (`<home>/.pi/goal-prompt.md`). */
export function globalGoalPromptPath(home: string = os.homedir()): string {
	if (!home) return "";
	return path.join(home, ".pi", "goal-prompt.md");
}

/** Compute the local prompt path (`<cwd>/.pi/goal-prompt.md`). */
export function localGoalPromptPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal-prompt.md");
}

/**
 * Resolve the goal custom prompt. Returns { prompt: "", source: "none" }
 * when nothing is configured — callers then skip the custom block.
 */
export function loadGoalPrompt(
	settings: GoalSettings | undefined,
	cwd: string,
	home?: string,
): ResolvedGoalPrompt {
	// 1. Inline override always wins.
	const inline = settings?.goalPrompt?.trim();
	if (inline && inline.length > 0) {
		return { prompt: inline, source: "inline" };
	}

	const mode = resolveGoalPromptMode(settings);
	const globalPath = globalGoalPromptPath(home);
	const localPath = localGoalPromptPath(cwd);

	if (mode === "local") {
		const localText = readFileIfExists(localPath);
		if (localText) return { prompt: localText, source: "local" };
		return { prompt: "", source: "none" };
	}

	if (mode === "global-local-merge") {
		const globalText = globalPath ? readFileIfExists(globalPath) : undefined;
		const localText = readFileIfExists(localPath);
		if (globalText && localText) {
			return { prompt: `${globalText}\n\n${localText}`, source: "merged" };
		}
		if (globalText) return { prompt: globalText, source: "global" };
		if (localText) return { prompt: localText, source: "local" };
		return { prompt: "", source: "none" };
	}

	// mode === "global-local" (default): defer global read until local is known missing.
	const localText = readFileIfExists(localPath);
	if (localText) return { prompt: localText, source: "local" };
	const globalText = globalPath ? readFileIfExists(globalPath) : undefined;
	if (globalText) return { prompt: globalText, source: "global" };
	return { prompt: "", source: "none" };
}

/**
 * Wrap the resolved custom prompt in a tagged block. Empty when nothing
 * configured, so callers can unconditionally append without conditional noise.
 */
export function customGoalPromptBlock(settings: GoalSettings | undefined, cwd: string, home?: string): string {
	const resolved = loadGoalPrompt(settings, cwd, home);
	if (!resolved.prompt) return "";
	return [
		"",
		`[PI GOAL CUSTOM PROMPT source=${resolved.source}]`,
		"<goal_custom_prompt>",
		resolved.prompt,
		"</goal_custom_prompt>",
	].join("\n");
}
