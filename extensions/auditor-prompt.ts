/**
 * Auditor prompt resolution.
 *
 * See specs/auditor-prompt-config/spec.md.
 *
 * Resolution order (first non-empty wins):
 *   1. Inline `settings.auditorPrompt` (always takes precedence)
 *   2. File-based prompt(s), combined per `auditorPromptMode`:
 *        - "global-local"       : local overrides global completely (local wins if present)
 *        - "local"              : only `.pi/auditor-prompt.md`, global never checked
 *        - "global-local-merge" : global + "\n\n" + local (local appended)
 *   3. Hardcoded fallback (caller supplies via `defaultPrompt`)
 *
 * File locations:
 *   global: `<home>/.pi/auditor-prompt.md`
 *   local : `<cwd>/.pi/auditor-prompt.md`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSettings, AuditorPromptMode } from "./goal-settings.ts";

/** Result of resolving the auditor prompt. */
export interface ResolvedAuditorPrompt {
	/** The final prompt text to hand to the auditor. */
	prompt: string;
	/** Where the prompt came from. */
	source:
		| "inline" // settings.auditorPrompt
		| "local" // .pi/auditor-prompt.md (local mode or global-local with local present)
		| "global" // ~/.pi/auditor-prompt.md (global-local without local, or merge without local)
		| "merged" // global-local-merge with both present
		| "default"; // hardcoded fallback
}

/** Resolve the effective prompt mode, defaulting to "global-local". */
export function resolveAuditorPromptMode(settings?: GoalSettings): AuditorPromptMode {
	return settings?.auditorPromptMode ?? "global-local";
}

/** Read a file's content if it exists and is non-empty, else undefined. */
function readFileIfExists(filePath: string): string | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const content = fs.readFileSync(filePath, "utf8");
		const trimmed = content.trim();
		return trimmed.length > 0 ? content.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Compute the global prompt path (`<home>/.pi/auditor-prompt.md`). */
export function globalAuditorPromptPath(home: string = os.homedir()): string {
	if (!home) return ""; // unreachable on most platforms; caller treats "" as missing
	return path.join(home, ".pi", "auditor-prompt.md");
}

/** Compute the local prompt path (`<cwd>/.pi/auditor-prompt.md`). */
export function localAuditorPromptPath(cwd: string): string {
	return path.join(cwd, ".pi", "auditor-prompt.md");
}

/**
 * Resolve the auditor prompt. The `defaultPrompt` is supplied by the caller
 * (the hardcoded `buildGoalAuditorPrompt()` output) and used only when no
 * inline or file-based prompt is available.
 *
 * @param settings goal settings (auditorPrompt / auditorPromptMode)
 * @param cwd      main session cwd, for the local prompt file
 * @param home     home directory, for the global prompt file (defaults to $HOME)
 * @param defaultPrompt hardcoded fallback prompt
 */
export function loadAuditorPrompt(
	settings: GoalSettings | undefined,
	cwd: string,
	defaultPrompt: string,
	home?: string,
): ResolvedAuditorPrompt {
	// 1. Inline override always wins.
	const inline = settings?.auditorPrompt?.trim();
	if (inline && inline.length > 0) {
		return { prompt: inline, source: "inline" };
	}

	const mode = resolveAuditorPromptMode(settings);
	const globalPath = globalAuditorPromptPath(home);
	const localPath = localAuditorPromptPath(cwd);

	if (mode === "local") {
		// `local` mode: global is never consulted — do not even read it.
		const localText = readFileIfExists(localPath);
		if (localText) return { prompt: localText, source: "local" };
		return { prompt: defaultPrompt, source: "default" };
	}

	const globalText = globalPath ? readFileIfExists(globalPath) : undefined;
	const localText = readFileIfExists(localPath);

	if (mode === "global-local-merge") {
		if (globalText && localText) {
			return { prompt: `${globalText}\n\n${localText}`, source: "merged" };
		}
		if (globalText) return { prompt: globalText, source: "global" };
		if (localText) return { prompt: localText, source: "local" };
		return { prompt: defaultPrompt, source: "default" };
	}

	// mode === "global-local" (default)
	if (localText) return { prompt: localText, source: "local" };
	if (globalText) return { prompt: globalText, source: "global" };
	return { prompt: defaultPrompt, source: "default" };
}
