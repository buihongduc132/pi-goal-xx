/**
 * Glob-style wildcard pattern matching for auditor resource filtering.
 *
 * Syntax (see specs/auditor-wildcard-matching/spec.md):
 *   `*`  — matches any run of characters (including empty)
 *   `?`  — matches exactly one character
 *   no wildcard — exact match
 *
 * Matching is case-sensitive. Patterns are converted to RegExp internally.
 * Per-session cache (`AuditorPatternCache`) memoizes the result of resolving
 * a pattern against a candidate list so repeated calls are O(1).
 */

/**
 * Convert a glob pattern into a RegExp source string.
 *
 * Escapes regex metacharacters in literal segments, then translates `*` to `.*`
 * and `?` to `.`. The returned source is anchored (`^...$`) so partial matches
 * are not allowed.
 *
 * Compiled RegExps are memoized in a module-level Map to avoid recompiling
 * the same pattern on every candidate (matters when filtering large lists).
 *
 * @internal exported for testing only
 */
const COMPILED_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegex(pattern: string): RegExp {
	const cached = COMPILED_REGEX_CACHE.get(pattern);
	if (cached) return cached;
	let out = "";
	for (const ch of pattern) {
		if (ch === "*") out += ".*";
		else if (ch === "?") out += ".";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const re = new RegExp(`^${out}$`);
	COMPILED_REGEX_CACHE.set(pattern, re);
	return re;
}

/** Match a single candidate against a pattern. Case-sensitive. */
export function matchPattern(pattern: string, candidate: string): boolean {
	if (pattern === candidate) return true; // fast path for exact matches
	if (!pattern.includes("*") && !pattern.includes("?")) return false;
	return globToRegex(pattern).test(candidate);
}

/**
 * Resolve a pattern against a candidate list, returning all matching candidates.
 * Uses the provided cache keyed by an unambiguous serialization of pattern +
 * candidates (JSON) to avoid collisions when candidate strings contain commas.
 */
export function resolvePattern(
	pattern: string,
	candidates: string[],
	cache?: AuditorPatternCache,
): string[] {
	const key = `${pattern}::${JSON.stringify(candidates)}`;
	if (cache) {
		const hit = cache.get(key);
		if (hit) return hit;
	}
	const out = candidates.filter((c) => matchPattern(pattern, c));
	if (cache) cache.set(key, out);
	return out;
}

/**
 * Per-session in-memory cache for pattern resolution results.
 *
 * Backed by a Map<string, string[]>. Lazy-populated on first resolution.
 * Lifecycle: created when an auditor session starts, cleared when it ends.
 */
export class AuditorPatternCache {
	private readonly map = new Map<string, string[]>();

	get(key: string): string[] | undefined {
		return this.map.get(key);
	}

	set(key: string, value: string[]): void {
		this.map.set(key, value);
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}

	/** Test-only helper to inspect raw entries. */
	entries(): IterableIterator<[string, string[]]> {
		return this.map.entries();
	}
}

/**
 * Apply a list of patterns (combined with OR semantics) to a candidate list,
 * returning all candidates that match at least one pattern.
 *
 * Order of the result mirrors the candidate list order; duplicates are removed.
 */
export function applyPatterns(
	patterns: string[],
	candidates: string[],
	cache?: AuditorPatternCache,
): string[] {
	if (patterns.length === 0) return [];
	const matched = new Set<string>();
	for (const p of patterns) {
		for (const c of resolvePattern(p, candidates, cache)) matched.add(c);
	}
	// Preserve input candidate order in the output.
	return candidates.filter((c) => matched.has(c));
}

/**
 * Subtract a set of patterns from a candidate list, returning all candidates
 * that do NOT match any of the patterns.
 */
export function excludePatterns(
	patterns: string[],
	candidates: string[],
	cache?: AuditorPatternCache,
): string[] {
	if (patterns.length === 0) return [...candidates];
	const matched = new Set(applyPatterns(patterns, candidates, cache));
	return candidates.filter((c) => !matched.has(c));
}
