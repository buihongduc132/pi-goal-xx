/**
 * Goal-active-env runtime helpers.
 *
 * When a goal is focused (started/selected/resumed), pi-goal-xx sets a
 * dedicated env variable (default `PI_GOAL_XX_ACTIVE`) whose value is resolved
 * from a configurable template supporting {cwd} {repo} {branch} {goalId}.
 * Default template: `{repo}-{branch}-{goalId}`.
 *
 * When focus is cleared (completed/aborted/cleared), the env var is removed.
 *
 * Side-effecting functions (`setActiveGoalEnv`, `clearActiveGoalEnv`) accept
 * the env object so tests can pass a stub instead of `process.env`.
 *
 * Git-aware helpers (`getRepoName`, `getBranchName`) shell out to `git` and
 * fall back gracefully when not in a git repo or git is unavailable.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

/** Default env variable name for the active-goal signal. */
export const DEFAULT_ACTIVE_ENV_NAME = "PI_GOAL_XX_ACTIVE";

/** Default value template. Interpolated tokens: {cwd} {repo} {branch} {goalId}. */
export const DEFAULT_ACTIVE_ENV_TEMPLATE = "{repo}-{branch}-{goalId}";

/** All supported interpolation tokens. Unknown tokens are left verbatim. */
const ACTIVE_ENV_TOKENS = ["cwd", "repo", "branch", "goalId"] as const;

/** Token context passed to `resolveActiveEnvValue`. */
export interface ActiveEnvContext {
	/** Absolute path to the current working directory. */
	cwd: string;
	/** Repository name (basename of git toplevel or cwd). May be empty. */
	repo: string;
	/** Current git branch. May be empty (detached HEAD or non-git). */
	branch: string;
	/** Focused goal id. */
	goalId: string;
}

/**
 * Resolve a template into the env value by interpolating {cwd} {repo}
 * {branch} {goalId}. Missing token values interpolate to empty string;
 * unknown tokens are left verbatim (no crash).
 */
export function resolveActiveEnvValue(template: string, ctx: ActiveEnvContext): string {
	const values: Record<string, string> = {
		cwd: ctx.cwd ?? "",
		repo: ctx.repo ?? "",
		branch: ctx.branch ?? "",
		goalId: ctx.goalId ?? "",
	};
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		if (!ACTIVE_ENV_TOKENS.includes(key as (typeof ACTIVE_ENV_TOKENS)[number])) {
			return match;
		}
		return values[key] ?? "";
	});
}

/** Set the env var to the resolved value. Mutates `env`. */
export function setActiveGoalEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	value: string,
): void {
	if (!name) return;
	env[name] = value;
}

/** Remove the env var. Mutates `env`. No-op when already absent. */
export function clearActiveGoalEnv(env: NodeJS.ProcessEnv, name: string): void {
	if (!name) return;
	delete env[name];
}

/**
 * Derive repo name: basename of `git rev-parse --show-toplevel`, or basename
 * of `cwd` when not in a git repo or git is unavailable. Empty string if
 * neither path can be resolved.
 */
export function getRepoName(cwd: string): string {
	const top = gitTopLevel(cwd);
	const base = top ?? cwd;
	if (!base) return "";
	return path.basename(base);
}

/**
 * Derive branch name: `git rev-parse --abbrev-ref HEAD`. Returns empty string
 * when detached (git returns the literal "HEAD"), not in a repo, or git
 * is unavailable.
 */
export function getBranchName(cwd: string): string {
	const raw = gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	return raw === "HEAD" ? "" : raw;
}

/** Build an `ActiveEnvContext` from cwd + goalId using git-derived fields. */
export function buildActiveEnvContext(cwd: string, goalId: string): ActiveEnvContext {
	return {
		cwd,
		repo: getRepoName(cwd),
		branch: getBranchName(cwd),
		goalId,
	};
}

/** Run a git command in `cwd`; return stdout on success, "" on failure. */
function gitRun(cwd: string, args: string[]): string {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		});
		return out ?? "";
	} catch {
		return "";
	}
}

/** Resolve git toplevel dir; null when not in a git repo or git unavailable. */
function gitTopLevel(cwd: string): string | null {
	const out = gitRun(cwd, ["rev-parse", "--show-toplevel"]);
	return out.trim() || null;
}

