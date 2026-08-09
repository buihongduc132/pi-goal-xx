/**
 * Unified prompt resolution for pi-goal-xx runtime prompts.
 *
 * Generalizes the per-surface resolution logic that previously lived in
 * `auditor-prompt.ts` and `goal-prompt-resolver.ts` into a single primitive
 * covering all runtime prompt keys + tool prompt fields.
 *
 * See:
 *   - openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 *   - openspec/changes/unified-prompt-config/design.md (section D1)
 *
 * Resolution precedence (always):
 *   1. Inline `cfg.inline` — ALWAYS wins when non-blank, regardless of mode.
 *      (Even under `mode: "off"` — `off` suppresses FILE injection only.)
 *   2. File sources, combined per `cfg.mode`:
 *        - "override"          : replace hardcodedDefault entirely.
 *                                resolvedBlock = local ?? global (no merge).
 *        - "append"            : prepend hardcodedDefault; resolvedBlock via
 *                                the default global-local strategy (local wins).
 *        - "global-local"      : (DEFAULT) local wins over global; append-style.
 *        - "local"             : only the local file is consulted; append-style.
 *        - "global-local-merge": global + "\n\n" + local when both present;
 *                                append-style.
 *        - "off"               : no file injection (inline still wins if set).
 *   3. Nothing resolved → final = hardcodedDefault.
 *
 * File paths:
 *   global = path.join(home,  promptsDir, `${key}.md`)
 *   local  = path.join(cwd,   promptsDir, `${key}.md`)
 *   default promptsDir = ".pi/pi-goal-xx/prompts/"
 *
 * Empty / whitespace-only files are treated as absent (mirrors the existing
 * auditor-prompt.ts + goal-prompt-resolver.ts behavior).
 *
 * An in-memory cache keyed by absolute path + mtimeMs avoids re-reading
 * unchanged files on every prompt build. Editing a file (mtime change)
 * invalidates the entry automatically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** All supported prompt resolution modes. */
export type PromptMode =
	| "override"
	| "append"
	| "global-local"
	| "local"
	| "global-local-merge"
	| "off";

/** Per-key prompt configuration (mirrors a single `prompts.<key>` block). */
export interface PromptConfig {
	mode?: PromptMode;
	inline?: string;
	file?: string;
}

/** Where a resolved persona/policy block originated. */
export type PromptSource = "inline" | "global" | "local" | "merged" | "none";

/**
 * Structured resolution result. Exposed for callers that want to inspect
 * provenance; `resolvePrompt` returns the flattened `{final, injected}` shape.
 */
export interface ResolvedPrompt {
	body: string;
	source: PromptSource;
}

export interface ResolvePromptOptions {
	/** Override the prompts directory (default `.pi/pi-goal-xx/prompts/`). */
	promptsDir?: string;
	/** Override the home directory for global prompt lookup. */
	home?: string;
}

export interface ResolvedFinal {
	/** The final prompt text to hand to the model / register on a tool. */
	final: string;
	/**
	 * The resolved persona/policy block that was injected (appended) on top of
	 * the hardcodedDefault. `undefined` when nothing was injected (override
	 * mode replaces rather than injects; off mode with no inline; no config).
	 */
	injected?: string;
	/**
	 * Provenance of the resolved block: "inline" | "global" | "local" |
	 * "merged" | "none". Lets callers (e.g. auditor-prompt migration) report
	 * where the block originated without re-reading files.
	 */
	source: PromptSource;
}

/** Default prompts directory (relative to both home and cwd). */
const DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/";

// ---------------------------------------------------------------------------
// mtime-keyed in-memory file cache
// ---------------------------------------------------------------------------

interface CacheEntry {
	mtimeMs: number;
	body: string | undefined; // undefined = file known-absent/blank at this mtime
}

const fileCache = new Map<string, CacheEntry>();

/**
 * Read a prompt file's trimmed content if it exists and is non-empty,
 * else `undefined`. Results are cached keyed by absolute path + mtimeMs so
 * repeated prompt builds don't re-read unchanged files. A file edit (mtime
 * change) invalidates the cached entry automatically.
 */
function readFileCached(absPath: string): string | undefined {
	// Cheap existence probe (no throw) — avoids the throw/catch overhead on
	// every call for missing files while still re-checking on each invocation
	// so files created after an initial miss are picked up (hot-reload safe).
	if (!fs.existsSync(absPath)) return undefined;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(absPath);
	} catch {
		// Race: file vanished between existsSync and statSync. Treat as missing.
		return undefined;
	}

	const mtimeMs = stat.mtimeMs;
	const cached = fileCache.get(absPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.body;

	let body: string | undefined;
	try {
		const raw = fs.readFileSync(absPath, "utf8");
		const trimmed = raw.trim();
		body = trimmed.length > 0 ? trimmed : undefined;
	} catch {
		body = undefined;
	}
	fileCache.set(absPath, { mtimeMs, body });
	return body;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function globalPromptPath(home: string, promptsDir: string, key: string): string {
	return path.join(home, promptsDir, `${key}.md`);
}

function localPromptPath(cwd: string, promptsDir: string, key: string): string {
	return path.join(cwd, promptsDir, `${key}.md`);
}

/**
 * Expand a leading `~` to the home directory. Other paths returned as-is.
 * (path.join does NOT handle ~ — Node treats it as a literal dir name.)
 */
function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(home, p.slice(2));
	}
	return p;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

interface ResolvedBlock {
	body: string;
	source: Exclude<PromptSource, "none">;
}

/**
 * Resolve the persona/policy block (the layer that gets injected on top of —
 * or replaces — the hardcodedDefault). Inline always wins; otherwise files
 * are consulted per `mode`.
 */
function resolveBlock(
	key: string,
	cfg: PromptConfig | undefined,
	cwd: string,
	home: string,
	promptsDir: string,
): ResolvedBlock | undefined {
	// 1. Inline ALWAYS wins (regardless of mode — even "off").
	const inline = cfg?.inline?.trim();
	if (inline && inline.length > 0) {
		return { body: inline, source: "inline" };
	}

	const mode = cfg?.mode ?? "global-local";

	// 2. "off" suppresses file injection entirely (inline already handled above).
	if (mode === "off") return undefined;

	// 2b. cfg.file — arbitrary file path (priority: inline > cfg.file >
	// mode-based lookup). Tilde-expanded (~ → home); relative paths resolve
	// against cwd. Falls through to mode-based lookup when the file is
	// missing/empty so users can mix cfg.file with mode-based fallback.
	const cfgFilePath = cfg?.file?.trim();
	if (cfgFilePath) {
		const expanded = expandTilde(cfgFilePath, home);
		const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
		const body = readFileCached(resolved);
		if (body) return { body, source: "local" };
		// fall through to mode-based lookup when cfg.file missing/empty
	}

	const globalPath = globalPromptPath(home, promptsDir, key);
	const localPath = cwd ? localPromptPath(cwd, promptsDir, key) : "";

	const globalText = readFileCached(globalPath);
	const localText = localPath ? readFileCached(localPath) : undefined;

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

	// "global-local" (default), "append", and "override" (no inline) all use
	// the same file-resolution strategy: local wins over global, no merge.
	if (localText) return { body: localText, source: "local" };
	if (globalText) return { body: globalText, source: "global" };
	return undefined;
}

/**
 * Resolve the final prompt text for `key`.
 *
 * @param key               Prompt key (e.g. "goal-running", "auditor").
 * @param cfg               Per-key config from settings (`prompts.<key>`).
 * @param cwd               Current working directory (for local file lookup).
 * @param hardcodedDefault  The hardcoded fallback body supplied by the caller.
 * @param opts              Optional overrides for promptsDir + home.
 * @returns `{ final, injected? }` — `final` is what the caller hands onward;
 *          `injected` is the resolved persona/policy block when one was
 *          appended on top of the default (absent for override / off / none).
 */
export function resolvePrompt(
	key: string,
	cfg: PromptConfig | undefined,
	cwd: string,
	hardcodedDefault: string,
	opts?: ResolvePromptOptions,
): ResolvedFinal {
	const promptsDir = opts?.promptsDir ?? DEFAULT_PROMPTS_DIR;
	const home = opts?.home ?? os.homedir();

	const block = resolveBlock(key, cfg, cwd, home, promptsDir);
	const mode = cfg?.mode ?? "global-local";

	if (!block) {
		return { final: hardcodedDefault, source: "none" };
	}

	// UNIFIED INLINE SEMANTICS (closes the off+inline divergence between
	// the generic resolver and loadAuditorPrompt): inline ALWAYS wins as an
	// override of the persona layer, regardless of mode. This matches the
	// auditor's short-circuit and the spec invariant 'Inline always wins
	// regardless of mode'. File-sourced bodies, by contrast, are mode-
	// dependent: override replaces the default, append/global-local/local/
	// global-local-merge prepend the default.
	const isInline = block.source === "inline";
	if (mode === "override" || isInline) {
		return { final: block.body, injected: block.body, source: block.source };
	}

	// File-sourced append-style modes: prepend the hardcodedDefault and
	// inject the resolved block on top.
	return {
		final: `${hardcodedDefault}\n\n${block.body}`,
		injected: block.body,
		source: block.source,
	};
}
