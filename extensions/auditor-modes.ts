/**
 * Auditor mode resolution: derive the auditor's effective resource lists
 * (tools, MCP servers, skills, extensions) from the main session's resources
 * and the user's `auditorMode` + `auditorExclude` / `auditorInclude` config.
 *
 * Two modes (see specs/auditor-modes/spec.md):
 *   inherit  (default): start with ALL main resources, apply `auditorExclude`
 *   minimal            : start with baseline, apply `auditorInclude` (matched against main)
 *
 * Wildcard pattern matching + caching lives in `./auditor-patterns.ts`.
 */

import type { GoalSettings, AuditorResourceFilter } from "./goal-settings.ts";
import {
	applyPatterns,
	excludePatterns,
	type AuditorPatternCache,
} from "./auditor-patterns.ts";
import { EARLY_DISAPPROVE_TOOL_NAME } from "./early-disapprove-tool.ts";

/** Baseline tools always available to the auditor. */
export const AUDITOR_BASELINE_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"report_auditor_progress",
	EARLY_DISAPPROVE_TOOL_NAME,
];

/** Resolve the auditor's effective mode, defaulting to "inherit". */
export function resolveAuditorMode(settings?: GoalSettings): "inherit" | "minimal" {
	return settings?.auditorMode === "minimal" ? "minimal" : "inherit";
}

/**
 * Resolve the auditor's tool list.
 *
 * - `inherit`: start with `mainTools` (defaults to baseline when mainTools empty),
 *   remove anything matching `auditorExclude.tools`. `report_auditor_progress`
 *   is always retained (auditor needs it).
 * - `minimal`: start with baseline, add any main tools matching
 *   `auditorInclude.tools`.
 */
export function resolveAuditorTools(
	mainTools: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.tools;
		if (include === undefined || include.length === 0) {
			return Array.from(AUDITOR_BASELINE_TOOLS);
		}
		const added = applyPatterns(include, mainTools, cache);
		return Array.from(new Set([...AUDITOR_BASELINE_TOOLS, ...added]));
	}
	// inherit
	const source = mainTools.length > 0 ? mainTools : Array.from(AUDITOR_BASELINE_TOOLS);
	const exclude = settings?.auditorExclude?.tools;
	if (exclude === undefined || exclude.length === 0) {
		return Array.from(new Set([...source, "report_auditor_progress", EARLY_DISAPPROVE_TOOL_NAME]));
	}
	const filtered = excludePatterns(exclude, source, cache);
	return Array.from(new Set([...filtered, "report_auditor_progress", EARLY_DISAPPROVE_TOOL_NAME]));
}

/** Resolve MCP server names (inherit excludes; minimal includes from main). */
export function resolveAuditorMcp(
	mainMcp: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.mcp;
		if (include === undefined || include.length === 0) return [];
		return applyPatterns(include, mainMcp, cache);
	}
	const exclude = settings?.auditorExclude?.mcp;
	if (exclude === undefined || exclude.length === 0) return Array.from(mainMcp);
	return excludePatterns(exclude, mainMcp, cache);
}

/** Resolve skill names (inherit excludes; minimal includes from main). */
export function resolveAuditorSkills(
	mainSkills: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.skills;
		if (include === undefined || include.length === 0) return [];
		return applyPatterns(include, mainSkills, cache);
	}
	const exclude = settings?.auditorExclude?.skills;
	if (exclude === undefined || exclude.length === 0) return Array.from(mainSkills);
	return excludePatterns(exclude, mainSkills, cache);
}

/** Resolve extension names (inherit excludes; minimal includes from main). */
export function resolveAuditorExtensions(
	mainExtensions: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.extensions;
		if (include === undefined || include.length === 0) return [];
		return applyPatterns(include, mainExtensions, cache);
	}
	const exclude = settings?.auditorExclude?.extensions;
	if (exclude === undefined || exclude.length === 0) return Array.from(mainExtensions);
	return excludePatterns(exclude, mainExtensions, cache);
}

/** Result of resolving all four resource lists at once. */
export interface ResolvedAuditorResources {
	mode: "inherit" | "minimal";
	tools: string[];
	mcp: string[];
	skills: string[];
	extensions: string[];
}

/**
 * Convenience: resolve all four resource lists in one call. Takes the main
 * session's resources and the goal settings, returns the auditor's effective
 * resources.
 */
export function resolveAuditorResources(
	main: { tools?: string[]; mcp?: string[]; skills?: string[]; extensions?: string[] },
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): ResolvedAuditorResources {
	return {
		mode: resolveAuditorMode(settings),
		tools: resolveAuditorTools(main.tools ?? [], settings, cache),
		mcp: resolveAuditorMcp(main.mcp ?? [], settings, cache),
		skills: resolveAuditorSkills(main.skills ?? [], settings, cache),
		extensions: resolveAuditorExtensions(main.extensions ?? [], settings, cache),
	};
}

/** Type re-export so callers don't need to import from goal-settings directly. */
export type { AuditorResourceFilter };
