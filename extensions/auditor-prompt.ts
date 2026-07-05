/**
 * Auditor prompt resolution — delegates to the unified `prompt-resolver.ts`.
 *
 * See:
 *   - openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 *   - openspec/changes/unified-prompt-config/design.md (D8 migration plan)
 *
 * Resolution order (first non-empty wins):
 *   1. Inline `settings.auditorPrompt` OR `settings.prompts.auditor.inline`
 *      (inline ALWAYS wins, regardless of mode).
 *   2. Unified file source via resolvePrompt('auditor', cfg, cwd, "", opts):
 *        - <home>/<promptsDir>/auditor.md  (global)
 *        - <cwd>/<promptsDir>/auditor.md   (local)
 *      combined per `mode` (default "global-local": local wins).
 *   3. Legacy file source (backward compat, pre-unified-prompt-config):
 *        - <home>/.pi/auditor-prompt.md    (global)
 *        - <cwd>/.pi/auditor-prompt.md     (local)
 *      consulted ONLY when the unified source yields nothing.
 *   4. Hardcoded fallback (caller-supplied `defaultPrompt`).
 *
 * Modes (unified): "override" | "append" | "global-local" | "local" |
 * "global-local-merge" | "off". The legacy `auditorPromptMode` key accepts
 * the original three ("global-local" | "local" | "global-local-merge") and
 * is treated as the mode for `prompts.auditor` when no unified prompts.auditor
 * block is present.
 *
 * The public API (`loadAuditorPrompt` signature + `{prompt, source}` return)
 * is preserved exactly; internals now delegate to `resolvePrompt`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSettings, AuditorPromptMode } from "./goal-settings.ts";
import { resolvePrompt, type PromptConfig, type PromptMode, type PromptSource } from "./prompt-resolver.ts";

/** Default unified prompts directory (relative to home and cwd). */
const DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/";

/** Legacy local/global filename for the auditor prompt. */
const LEGACY_FILENAME = "auditor-prompt.md";

/** Compute the legacy global auditor prompt path (`<home>/.pi/auditor-prompt.md`). */
export function globalAuditorPromptPath(home: string = os.homedir()): string {
	if (!home) return "";
	return path.join(home, ".pi", LEGACY_FILENAME);
}

/** Compute the legacy local auditor prompt path (`<cwd>/.pi/auditor-prompt.md`). */
export function localAuditorPromptPath(cwd: string): string {
	return path.join(cwd, ".pi", LEGACY_FILENAME);
}

export interface LoadAuditorPromptOptions {
	/**
	 * The auditor's fact layer (objective + summaries + contract + checklist).
	 * When provided, override mode REPLACES only the persona preamble but
	 * ALWAYS concatenates this fact layer — the auditor must be able to
	 * identify the goal under audit in every mode. (Spec: "Goal data always
	 * injected".) Omit for non-auditor callers that have no fact layer.
	 */
	factLayer?: string;
}

/** Result of resolving the auditor prompt. */
export interface ResolvedAuditorPrompt {
	/** The final prompt text to hand to the auditor. */
	prompt: string;
	/** Where the prompt came from. */
	source:
		| "inline" // settings.auditorPrompt / prompts.auditor.inline
		| "local" // local file (unified or legacy) in local / global-local / merge modes
		| "global" // global file (unified or legacy)
		| "merged" // global-local-merge with both present
		| "default"; // hardcoded fallback
}

/** Re-export so callers can introspect the auditor mode without importing settings. */
export type { AuditorPromptMode };

/**
 * Resolve the effective auditor prompt mode. Prefers `settings.prompts.auditor.mode`
 * (unified) when present, else falls back to legacy `settings.auditorPromptMode`,
 * defaulting to "global-local".
 */
export function resolveAuditorPromptMode(settings?: GoalSettings): AuditorPromptMode {
	const unified = settings?.prompts?.auditor?.mode;
	if (unified) return unified as AuditorPromptMode;
	return settings?.auditorPromptMode ?? "global-local";
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

/** Map the unified PromptSource to the auditor ResolvedAuditorPrompt source label. */
function mapSource(src: PromptSource): ResolvedAuditorPrompt["source"] {
	if (src === "none") return "default";
	return src;
}

/**
 * Read the legacy `.pi/auditor-prompt.md` files per `mode` (the original
 * three modes only — override/append/off are unified-only). Returns the body
 * + source label, or undefined when nothing is found.
 */
function readLegacyBlock(
	mode: PromptMode,
	cwd: string,
	home: string,
): { body: string; source: ResolvedAuditorPrompt["source"] } | undefined {
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
 * Resolve the auditor prompt. The `defaultPrompt` is supplied by the caller
 * (the hardcoded `buildGoalAuditorPrompt()` output) and used only when no
 * inline, unified, or legacy source resolves.
 *
 * @param settings goal settings (legacy keys or unified `prompts.auditor`)
 * @param cwd      main session cwd, for local prompt files
 * @param defaultPrompt hardcoded fallback prompt
 * @param home     home directory, for global prompt files (defaults to $HOME)
 */
export function loadAuditorPrompt(
	settings: GoalSettings | undefined,
	cwd: string,
	defaultPrompt: string,
	home?: string,
	opts?: LoadAuditorPromptOptions,
): ResolvedAuditorPrompt {
	const h = home ?? os.homedir();
	const promptsDir = settings?.promptsDir ?? DEFAULT_PROMPTS_DIR;

	// Build the unified config from settings.prompts.auditor OR synthesize it
	// from the legacy keys so resolvePrompt sees a single cfg shape.
	const unifiedCfg: PromptConfig | undefined = settings?.prompts?.auditor;
	const legacyInline = settings?.auditorPrompt?.trim();
	const cfg: PromptConfig = unifiedCfg
		? unifiedCfg
		: {
				inline: legacyInline,
				mode: resolveAuditorPromptMode(settings) as PromptMode,
			};

	// Inline check (both unified and legacy inline) — must short-circuit before
	// any file read so an empty cwd doesn't matter. resolvePrompt handles this
	// internally, but we surface it here for clarity + the "off" override.
	// SPEC INVARIANT (prompt-config-resolution "Goal data always injected"):
	// the fact layer (objective, summaries, contract, checklist) is ALWAYS
	// concatenated when provided — regardless of mode, file presence, or
	// inline override. The auditor must be able to identify the goal under
	// audit in every mode.
	const factLayer = opts?.factLayer;
	const withFact = (body: string): string => (factLayer ? `${body}\n\n${factLayer}` : body);

	const inline = cfg.inline?.trim();
	if (inline && inline.length > 0) {
		return { prompt: withFact(inline), source: "inline" };
	}

	const mode = cfg.mode ?? "global-local";

	// "off" suppresses file injection entirely (inline already handled).
	if (mode !== "off") {
		// 1. Unified resolution via resolvePrompt('auditor', ...). We pass an
		//    empty hardcodedDefault because the auditor's resolved body is a
		//    persona replacement — the fact layer is concatenated explicitly
		//    below to guarantee goal-identification in every mode.
		const resolved = resolvePrompt("auditor", cfg, cwd, "", {
			promptsDir,
			home: h,
		});
		if (resolved.source !== "none" && resolved.injected) {
			return { prompt: withFact(resolved.injected), source: mapSource(resolved.source) };
		}

		// 2. Legacy fallback (.pi/auditor-prompt.md) — backward compat.
		const legacy = readLegacyBlock(mode, cwd, h);
		if (legacy) {
			return { prompt: withFact(legacy.body), source: legacy.source };
		}
	}

	// 3. Nothing resolved — hardcoded fallback (defaultPrompt already includes
	//    the fact layer when built via buildAuditorPromptParts + buildGoalAuditorPrompt).
	return { prompt: defaultPrompt, source: "default" };
}
