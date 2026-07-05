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
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absPath);
	} catch {
		// Missing or unreadable — cache the absence so we don't re-stat every
		// call. Keyed by path alone with a sentinel mtime of -1.
		const cached = fileCache.get(absPath);
		if (cached && cached.mtimeMs === -1) return cached.body;
		fileCache.set(absPath, { mtimeMs: -1, body: undefined });
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
		return { final: hardcodedDefault };
	}

	// Override mode REPLACES the hardcodedDefault entirely (persona-only
	// prompts). Nothing is "injected" — the block IS the final.
	if (mode === "override") {
		return { final: block.body };
	}

	// All other modes (append, global-local, local, global-local-merge, off
	// with inline) are append-style: prepend the hardcodedDefault and inject
	// the resolved block on top.
	return {
		final: `${hardcodedDefault}\n\n${block.body}`,
		injected: block.body,
	};
}
