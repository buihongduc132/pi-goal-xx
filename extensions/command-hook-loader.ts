/**
 * Per-command hook loader + handler wrapper (group 6, D4/D5).
 *
 * See:
 *   - openspec/changes/unified-prompt-config/specs/command-hooks/spec.md
 *   - openspec/changes/unified-prompt-config/design.md (D4, D5)
 *
 * Safety model:
 *   - Hooks execute user-supplied TypeScript in the extension context.
 *   - `settings.commandHooks.enabled` MUST be explicitly true to load any
 *     hook. Default off.
 *   - Dynamic import errors are isolated: a failing hook file emits a
 *     `ui.notify` warning and the built-in handler runs unwrapped.
 *
 * Modes:
 *   - "append" (default): pre → builtin → post.
 *   - "override": the user handler REPLACES the builtin; the builtin is
 *     passed as the 3rd argument so the hook MAY delegate to it.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { GoalSettings, CommandHookConfig, CommandHooksConfig } from "./goal-settings.ts";
import { logGoalTrace, previewError } from "./goal-trace.ts";

/** Default hooks directory (relative to cwd). */
const DEFAULT_HOOKS_DIR = ".pi/pi-goal-xx/hooks/";

/** Minimal command handler shape (args, ctx) → result. */
export type CommandHandler = (args: string, ctx: unknown) => unknown | Promise<unknown>;

/** A loaded hook module's exported members. */
export interface LoadedHook {
	/** Pre-hook: runs before builtin; may transform args. */
	pre?: (args: string, ctx: unknown) => Promise<{ transformArgs?: string } | void> | ({ transformArgs?: string } | void);
	/** Post-hook: runs after builtin (append mode). */
	post?: (args: string, ctx: unknown, result: unknown) => Promise<void> | void;
	/** Override handler: replaces builtin; receives builtin as 3rd arg. */
	handler?: (args: string, ctx: unknown, builtin: CommandHandler) => unknown | Promise<unknown>;
}

/** Options for loadHook (test injection points). */
export interface LoadHookOptions {
	/** Override the dynamic importer (default: native `import()`). */
	importer?: (path: string) => Promise<Partial<LoadedHook>>;
	/** Override home directory (for global hook resolution). */
	home?: string;
	/** Override hooks directory. */
	hooksDir?: string;
}

/**
 * Load a command hook module for `name`. Returns undefined when:
 *   - hooks are disabled (`commandHooks.enabled !== true`)
 *   - no config exists for this command
 *   - the dynamic import fails (error isolated → undefined + ui.notify)
 *
 * Resolution per spec `command-hooks` Requirement "Hook precedence global
 * then local": when BOTH global and local hook files exist, they are chained
 * (append mode) as global-pre → local-pre → builtin → local-post →
 * global-post. In override mode local wins and global is ignored.
 */
export async function loadHook(
	name: string,
	cwd: string,
	settings: GoalSettings | undefined,
	opts: LoadHookOptions = {},
): Promise<LoadedHook | undefined> {
	const ch = settings?.commandHooks as CommandHooksConfig | undefined;
	if (!ch?.enabled) return undefined;
	const cmdCfg = (ch as Record<string, unknown>)[name] as CommandHookConfig | undefined;
	if (!cmdCfg) return undefined;

	const hooksDir = opts.hooksDir ?? settings?.hooksDir ?? DEFAULT_HOOKS_DIR;
	const localPath = cwd ? path.join(cwd, hooksDir, `${name}.ts`) : "";
	const globalPath = opts.home ? path.join(opts.home, hooksDir, `${name}.ts`) : "";

	const importer = opts.importer ?? (async (p: string) => {
		// Native dynamic import of a .ts file; Node strips types when run with
		// --experimental-strip-types (the extension runtime already uses it).
		// Convert to a file:// URL for cross-platform compatibility (Windows
		// drive-letter paths otherwise throw ERR_UNSUPPORTED_ESM_URL_SCHEME).
		const mod = await import(/* @vite-ignore */ pathToFileURL(p).href);
		return mod as Partial<LoadedHook>;
	});

	const tryImport = async (p: string): Promise<LoadedHook | undefined> => {
		if (!p) return undefined;
		try {
			const mod = await importer(p);
			return {
				pre: mod.pre,
				post: mod.post,
				handler: mod.handler,
			};
		} catch (err) {
			// Error isolation: a malformed hook file does NOT crash the extension.
			// Callers receive undefined and fall back to the built-in handler.
			logGoalTrace(cwd, { level: "warn", step: "hook.import_failed", message: `failed to import hook ${p}`, error: previewError(err) });
			return undefined;
		}
	};

	// Spec (command-hooks "Hook precedence global then local"): when both
	// global and local hook files exist in append mode, chain them as
	// global-pre → local-pre → builtin → local-post → global-post. In
	// override mode local wins and global is silently ignored.
	const local = localPath ? await tryImport(localPath) : undefined;
	const globalHook = globalPath ? await tryImport(globalPath) : undefined;
	if (!local && !globalHook) return undefined;
	if (local && globalHook) {
		return chainHooks(globalHook, local);
	}
	return local ?? globalHook;
}

/**
 * Chain two hook modules (global, local) into a single LoadedHook per the
 * append-mode precedence: global-pre → local-pre → builtin → local-post →
 * global-post. If either defines a full `handler` (override semantics), the
 * local handler wins and the global one is dropped (override = local wins).
 */
function chainHooks(globalHook: LoadedHook, localHook: LoadedHook): LoadedHook {
	// Override handlers: local wins, global dropped.
	if (localHook.handler) return localHook;
	if (globalHook.handler && !localHook.handler) {
		// global override + local append hooks: chain pre/post around the
		// global handler.
		return {
			pre: chainPre(globalHook.pre, localHook.pre),
			handler: globalHook.handler,
			post: chainPost(localHook.post, globalHook.post),
		};
	}
	return {
		pre: chainPre(globalHook.pre, localHook.pre),
		post: chainPost(localHook.post, globalHook.post),
	};
}

/** Compose two pre hooks: g first, then l. Each may transform args. */
function chainPre(
	g: LoadedHook["pre"],
	l: LoadedHook["pre"],
): LoadedHook["pre"] {
	if (!g) return l;
	if (!l) return g;
	return async (args, ctx) => {
		const gr = await g(args, ctx);
		const nextArgs = transformFrom(gr) ?? args;
		const lr = await l(nextArgs, ctx);
		return lr ?? undefined;
	};
}

/** Compose two post hooks: l first, then g (reverse of pre). */
function chainPost(
	l: LoadedHook["post"],
	g: LoadedHook["post"],
): LoadedHook["post"] {
	if (!l) return g;
	if (!g) return l;
	return async (args, ctx, result) => {
		await l(args, ctx, result);
		await g(args, ctx, result);
	};
}

/** Extract transformArgs from a pre-hook result, if any. */
function transformFrom(result: unknown): string | undefined {
	if (result && typeof result === "object" && "transformArgs" in result) {
		const t = (result as { transformArgs?: string }).transformArgs;
		return typeof t === "string" ? t : undefined;
	}
	return undefined;
}

/**
 * Wrap a built-in command handler with the loaded `hook` per `settings`.
 * When hooks are disabled or no hook is loaded, returns the original.
 *
 * @param name     Command name (e.g. "goals").
 * @param original The built-in handler.
 * @param settings Goal settings (commandHooks block).
 * @param cwd      Working directory (unused here but kept for symmetry).
 * @param hook     The pre-loaded hook module (undefined → no wrap).
 */
export function wrapHandler(
	name: string,
	original: CommandHandler,
	settings: GoalSettings | undefined,
	cwd: string,
	hook: LoadedHook | undefined,
): CommandHandler {
	const ch = settings?.commandHooks as CommandHooksConfig | undefined;
	if (!ch?.enabled || !hook) return original;
	const cmdCfg = (ch as Record<string, unknown>)[name] as CommandHookConfig | undefined;
	if (!cmdCfg) return original;
	const mode = cmdCfg.mode ?? "append";
	const notify = (ctx: unknown, msg: string) => {
		const ui = (ctx as { ui?: { notify?: (m: string, k?: string) => void } })?.ui;
		try { ui?.notify?.(msg, "warning"); } catch { /* swallow */ }
	};

	if (mode === "override" && hook.handler) {
		return async (args: string, ctx: unknown) => {
			try {
				return await hook.handler!(args, ctx, original);
			} catch (err) {
				// Override-handler errors propagate (user opted into full control).
				notify(ctx, `Override hook for /${name} threw: ${(err as Error).message}`);
				logGoalTrace(cwd, { level: "error", step: "hook.override_failed", message: `override hook for /${name} threw`, error: previewError(err) });
				throw err;
			}
		};
	}

	// Append mode: pre → builtin → post, with error isolation on pre/post.
	return async (args: string, ctx: unknown) => {
		let effectiveArgs = args;
		if (hook.pre) {
			try {
				const preResult = await hook.pre(args, ctx);
				if (preResult && typeof preResult === "object" && "transformArgs" in preResult) {
					const t = (preResult as { transformArgs?: string }).transformArgs;
					if (typeof t === "string") effectiveArgs = t;
				}
			} catch (err) {
				notify(ctx, `Pre-hook for /${name} failed: ${(err as Error).message}. Falling back to original args.`);
				logGoalTrace(cwd, { level: "warn", step: "hook.pre_failed", message: `pre-hook for /${name} failed`, error: previewError(err) });
				effectiveArgs = args;
			}
		}
		const result = await original(effectiveArgs, ctx);
		if (hook.post) {
			try {
				await hook.post(effectiveArgs, ctx, result);
			} catch (err) {
				notify(ctx, `Post-hook for /${name} failed: ${(err as Error).message}`);
				logGoalTrace(cwd, { level: "warn", step: "hook.post_failed", message: `post-hook for /${name} failed`, error: previewError(err) });
			}
		}
		return result;
	};
}

/**
 * Lazy hook cache: loads the hook on first invocation of a wrapped command,
 * then caches it. Returns a wrapped handler that dispatches per settings.
 *
 * Hook loading is deferred so synchronous command registration does not need
 * an async init phase. The first call to a hooked command pays the (isolated)
 * dynamic-import cost; subsequent calls reuse the cache.
 */
export function lazyWrapCommand<H extends CommandHandler>(
	name: string,
	handler: H,
	getSettings: () => GoalSettings | undefined,
	getCwd: () => string,
): H {
	let cached: LoadedHook | undefined | null = null; // null = not yet loaded
	const wrapped = async (args: string, ctx: unknown) => {
		const settings = getSettings();
		const ch = settings?.commandHooks as CommandHooksConfig | undefined;
		if (!ch?.enabled) return handler(args, ctx);
		const cmdCfg = (ch as Record<string, unknown>)[name] as CommandHookConfig | undefined;
		if (!cmdCfg) return handler(args, ctx);
		if (cached === null) {
			cached = (await loadHook(name, getCwd(), settings)) ?? undefined;
		}
		const dispatch = wrapHandler(name, handler, settings, getCwd(), cached ?? undefined);
		return dispatch(args, ctx);
	};
	return wrapped as H;
}
