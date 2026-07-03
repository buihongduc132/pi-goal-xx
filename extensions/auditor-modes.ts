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

/** Baseline tools always available to the auditor. */
export const AUDITOR_BASELINE_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"report_auditor_progress",
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
	const progressTool = "report_auditor_progress";
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.tools ?? [];
		const added = include.length > 0 ? applyPatterns(include, mainTools, cache) : [];
		const merged = new Set<string>([...AUDITOR_BASELINE_TOOLS, ...added]);
		merged.add(progressTool);
		return Array.from(merged);
	}
	// inherit
	const source = mainTools.length > 0 ? mainTools : [...AUDITOR_BASELINE_TOOLS];
	const exclude = settings?.auditorExclude?.tools ?? [];
	const filtered = exclude.length > 0 ? excludePatterns(exclude, source, cache) : [...source];
	const merged = new Set<string>(filtered);
	merged.add(progressTool); // never strip the progress reporter
	return Array.from(merged);
}

/** Resolve MCP server names (inherit excludes; minimal includes from main). */
export function resolveAuditorMcp(
	mainMcp: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.mcp ?? [];
		return include.length > 0 ? applyPatterns(include, mainMcp, cache) : [];
	}
	const exclude = settings?.auditorExclude?.mcp ?? [];
	return exclude.length > 0 ? excludePatterns(exclude, mainMcp, cache) : [...mainMcp];
}

/** Resolve skill names (inherit excludes; minimal includes from main). */
export function resolveAuditorSkills(
	mainSkills: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.skills ?? [];
		return include.length > 0 ? applyPatterns(include, mainSkills, cache) : [];
	}
	const exclude = settings?.auditorExclude?.skills ?? [];
	return exclude.length > 0 ? excludePatterns(exclude, mainSkills, cache) : [...mainSkills];
}

/** Resolve extension names (inherit excludes; minimal includes from main). */
export function resolveAuditorExtensions(
	mainExtensions: string[],
	settings: GoalSettings | undefined,
	cache?: AuditorPatternCache,
): string[] {
	const mode = resolveAuditorMode(settings);
	if (mode === "minimal") {
		const include = settings?.auditorInclude?.extensions ?? [];
		return include.length > 0 ? applyPatterns(include, mainExtensions, cache) : [];
	}
	const exclude = settings?.auditorExclude?.extensions ?? [];
	return exclude.length > 0 ? excludePatterns(exclude, mainExtensions, cache) : [...mainExtensions];
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
