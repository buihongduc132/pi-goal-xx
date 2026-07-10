/**
 * Goal prompt resolution — migrated to unified resolver.
 *
 * Lets the user inject a CUSTOM block into the runtime goal/continuation
 * system prompts AND the drafting prompts (/goal, /sisyphus, propose_goal_draft).
 *
 * Resolution order (first non-empty wins):
 *   1. Inline `settings.goalPrompt` (always takes precedence)
 *   2. Unified file source via resolvePrompt('goal', cfg, cwd, "", opts):
 *        - <home>/<promptsDir>/goal.md  (global)
 *        - <cwd>/<promptsDir>/goal.md   (local)
 *      combined per `mode` (default "global-local": local wins).
 *   3. Legacy file source (backward compat, pre-unified-prompt-config):
 *        - <home>/.pi/goal-prompt.md    (global)
 *        - <cwd>/.pi/goal-prompt.md     (local)
 *      consulted ONLY when the unified source yields nothing.
 *   4. No fallback (returns empty string → no custom block injected)
 *
 * Modes (unified): "override" | "append" | "global-local" | "local" |
 * "global-local-merge" | "off". The legacy `goalPromptMode` key accepts
 * the original three ("global-local" | "local" | "global-local-merge") and
 * is treated as the mode for `prompts.goal` when no unified prompts.goal
 * block is present.
 *
 * The public API (`loadGoalPrompt` signature + `{prompt, source}` return)
 * is preserved exactly; internals now delegate to `resolvePrompt`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSettings, GoalPromptMode } from "./goal-settings.ts";
import { resolvePrompt, type PromptConfig, type PromptMode, type PromptSource } from "./prompt-resolver.ts";

/** Default unified prompts directory (relative to home and cwd). */
const DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/";

/** Legacy local/global filename for the goal prompt. */
const LEGACY_FILENAME = "goal-prompt.md";

/** Result of resolving the goal custom prompt. */
export interface ResolvedGoalPrompt {
	/** The final custom prompt text (empty string when none configured). */
	prompt: string;
	/** Where the prompt came from. */
	source:
		| "inline" // settings.goalPrompt / prompts.goal.inline
		| "local" // local file (unified or legacy) in local / global-local / merge modes
		| "global" // global file (unified or legacy)
		| "merged" // global-local-merge with both present
		| "none"; // nothing configured
}

/** Compute the legacy global goal prompt path (`<home>/.pi/goal-prompt.md`). */
export function globalGoalPromptPath(home: string = os.homedir()): string {
	if (!home) return "";
	return path.join(home, ".pi", LEGACY_FILENAME);
}

/** Compute the legacy local goal prompt path (`<cwd>/.pi/goal-prompt.md`). */
export function localGoalPromptPath(cwd: string): string {
	return path.join(cwd, ".pi", LEGACY_FILENAME);
}

/**
 * Resolve the effective goal prompt mode. Prefers `settings.prompts.goal.mode`
 * (unified) when present, else falls back to legacy `settings.goalPromptMode`,
 * defaulting to "global-local".
 */
export function resolveGoalPromptMode(settings?: GoalSettings): GoalPromptMode {
	const unified = settings?.prompts?.goal?.mode;
	if (unified) return unified as GoalPromptMode;
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

/** Map the unified PromptSource to the ResolvedGoalPrompt source label. */
function mapSource(src: PromptSource): ResolvedGoalPrompt["source"] {
	if (src === "none") return "none";
	return src;
}

/**
 * Read the legacy `.pi/goal-prompt.md` files per `mode` (the original
 * three modes only — override/append/off are unified-only). Returns the body
 * + source label, or undefined when nothing is found.
 */
function readLegacyBlock(
	mode: PromptMode,
	cwd: string,
	home: string,
): { body: string; source: ResolvedGoalPrompt["source"] } | undefined {
	const globalPath = path.join(home, ".pi", LEGACY_FILENAME);
	const localPath = cwd ? path.join(cwd, ".pi", LEGACY_FILENAME) : "";
	const globalText = readFileIfExists(globalPath);
	const localText = localPath ? readFileIfExists(localPath) : undefined;

	if (mode === "local") {
		if (localText) return { body: localText, source: "local" };
		return undefined;
	}

	if (mode === "global-local-merge") {
		if (globalText && localText) {
			return { body: `${globalText}\n\n${localText}`, source: "merged" };
		}
		if (globalText) return { body: globalText, source: "global" };
		if (localText) return { body: localText, source: "local" };
		return undefined;
	}

	// "global-local" (default), "override", "append", "off" — legacy fallback
	// uses local-wins-over-global (no merge). "off" is handled by the caller
	// (legacy never consulted under off).
	if (localText) return { body: localText, source: "local" };
	if (globalText) return { body: globalText, source: "global" };
	return undefined;
}

/**
 * Resolve the goal custom prompt. Returns { prompt: "", source: "none" }
 * when nothing is configured — callers then skip the custom block.
 */
export function loadGoalPrompt(
	settings: GoalSettings | undefined,
	cwd?: string,
	home?: string,
): ResolvedGoalPrompt {
	const h = home ?? os.homedir();
	const promptsDir = settings?.promptsDir ?? DEFAULT_PROMPTS_DIR;

	// Build the unified config from settings.prompts.goal OR synthesize it
	// from the legacy keys so resolvePrompt sees a single cfg shape.
	const unifiedCfg: PromptConfig | undefined = settings?.prompts?.goal;
	const legacyInline = settings?.goalPrompt?.trim();
	const cfg: PromptConfig = unifiedCfg
		? { ...unifiedCfg, inline: unifiedCfg.inline ?? legacyInline }
		: {
				inline: legacyInline,
				mode: resolveGoalPromptMode(settings) as PromptMode,
			};

	// Inline check (both unified and legacy inline) — must short-circuit before
	// any file read so an empty cwd doesn't matter.
	const inline = cfg.inline?.trim();
	if (inline && inline.length > 0) {
		return { prompt: inline, source: "inline" };
	}

	// If cwd is undefined, skip file resolution entirely (preserve original behavior)
	if (!cwd) {
		return { prompt: "", source: "none" };
	}

	const mode = cfg.mode ?? "global-local";

	// "off" suppresses file injection entirely (inline already handled).
	if (mode !== "off") {
		// 1. Unified resolution via resolvePrompt('goal', ...). We pass an
		//    empty hardcodedDefault because the goal's resolved body is a
		//    persona replacement — the fact layer is concatenated explicitly
		//    below to guarantee goal-identification in every mode.
		const resolved = resolvePrompt("goal", cfg, cwd, "", {
			promptsDir,
			home: h,
		});
		if (resolved.source !== "none" && resolved.injected) {
			return { prompt: resolved.injected, source: mapSource(resolved.source) };
		}

		// 2. Legacy fallback (.pi/goal-prompt.md) — backward compat.
		const legacy = readLegacyBlock(mode, cwd, h);
		if (legacy) {
			return { prompt: legacy.body, source: legacy.source };
		}
	}

	// 3. Nothing resolved.
	return { prompt: "", source: "none" };
}

/**
 * Wrap the resolved custom prompt in a tagged block. Empty when nothing
 * configured, so callers can unconditionally append without conditional noise.
 */
export function customGoalPromptBlock(settings: GoalSettings | undefined, cwd?: string, home?: string): string {
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
