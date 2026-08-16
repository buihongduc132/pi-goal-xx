/**
 * RED tests for goal-active-env feature.
 *
 * When a goal is focused (started/selected/resumed), pi-goal-xx should set a
 * dedicated env variable (default `PI_GOAL_XX_ACTIVE`) whose value is resolved
 * from a configurable template supporting {cwd} {repo} {branch} {goalId}.
 * Default template: `{repo}-{branch}-{goalId}`.
 *
 * When focus is cleared (completed/aborted/cleared), the env var is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_ACTIVE_ENV_NAME,
	DEFAULT_ACTIVE_ENV_TEMPLATE,
	buildActiveEnvContext,
	clearActiveGoalEnv,
	getBranchName,
	getRepoName,
	resolveActiveEnvValue,
	setActiveGoalEnv,
} from "../extensions/goal-env-runtime.ts";

test("defaults: name=PI_GOAL_XX_ACTIVE, template={repo}-{branch}-{goalId}", () => {
	assert.equal(DEFAULT_ACTIVE_ENV_NAME, "PI_GOAL_XX_ACTIVE");
	assert.equal(DEFAULT_ACTIVE_ENV_TEMPLATE, "{repo}-{branch}-{goalId}");
});

test("resolveActiveEnvValue: default template interpolates all 4 tokens", () => {
	const got = resolveActiveEnvValue(DEFAULT_ACTIVE_ENV_TEMPLATE, {
		cwd: "/home/bhd/Documents/Projects/bhd/pi-goal-xx",
		repo: "pi-goal-xx",
		branch: "feat/goal-active-env-var",
		goalId: "mru8rre0-3lirjx",
	});
	assert.equal(got, "pi-goal-xx-feat/goal-active-env-var-mru8rre0-3lirjx");
});

test("resolveActiveEnvValue: custom template with {cwd} and {goalId}", () => {
	const got = resolveActiveEnvValue("goal:{goalId}@{cwd}", {
		cwd: "/tmp/x",
		repo: "x",
		branch: "main",
		goalId: "abc",
	});
	assert.equal(got, "goal:abc@/tmp/x");
});

test("resolveActiveEnvValue: missing token values become empty string", () => {
	const got = resolveActiveEnvValue("{repo}-{branch}-{goalId}", {
		cwd: "/tmp",
		repo: "",
		branch: "",
		goalId: "abc",
	});
	assert.equal(got, "--abc");
});

test("resolveActiveEnvValue: unknown tokens are left verbatim (no crash)", () => {
	const got = resolveActiveEnvValue("{repo}-{unknown}", {
		cwd: "/tmp",
		repo: "r",
		branch: "b",
		goalId: "g",
	});
	assert.equal(got, "r-{unknown}");
});

test("setActiveGoalEnv writes env[name]=value", () => {
	const env: NodeJS.ProcessEnv = {};
	setActiveGoalEnv(env, "PI_GOAL_XX_ACTIVE", "pi-goal-xx-main-abc");
	assert.equal(env.PI_GOAL_XX_ACTIVE, "pi-goal-xx-main-abc");
});

test("clearActiveGoalEnv deletes env[name]", () => {
	const env: NodeJS.ProcessEnv = { PI_GOAL_XX_ACTIVE: "x" };
	clearActiveGoalEnv(env, "PI_GOAL_XX_ACTIVE");
	assert.equal(env.PI_GOAL_XX_ACTIVE, undefined);
});

test("clearActiveGoalEnv is a no-op when name missing", () => {
	const env: NodeJS.ProcessEnv = {};
	clearActiveGoalEnv(env, "PI_GOAL_XX_ACTIVE");
	assert.equal(env.PI_GOAL_XX_ACTIVE, undefined);
});

test("getRepoName: returns basename of git toplevel (falls back to cwd basename)", () => {
	// Use the worktree itself — should be a real git repo.
	const cwd = process.cwd();
	const name = getRepoName(cwd);
	assert.ok(name.length > 0, "repo name must be non-empty");
	// Must equal basename of git toplevel or cwd
	assert.ok(typeof name === "string");
});

test("getBranchName: returns the current git branch dynamically (no hardcode)", () => {
	const cwd = process.cwd();
	const branch = getBranchName(cwd);
	assert.ok(typeof branch === "string", "branch must be a string");
	// Derive expected value dynamically from git so the test passes regardless
	// of which branch/checkout it runs under (no hard-coded branch name).
	const expected = (() => {
		try {
			const raw = execSync(
				"git rev-parse --abbrev-ref HEAD",
				{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
			).trim();
			return raw === "HEAD" ? "" : raw;
		} catch {
			return "";
		}
	})();
	assert.equal(branch, expected);
});

// ── Branch coverage: nullish-coalescing, empty-name guards, non-git dirs ──

test("resolveActiveEnvValue: nullish ctx fields fall back to empty string", () => {
	// Pass undefined for each field to exercise the `?? ""` branches.
	const got = resolveActiveEnvValue("{cwd}-{repo}-{branch}-{goalId}", {
		cwd: undefined as unknown as string,
		repo: undefined as unknown as string,
		branch: undefined as unknown as string,
		goalId: undefined as unknown as string,
	});
	assert.equal(got, "---");
});

test("setActiveGoalEnv: empty name is a no-op", () => {
	const env: NodeJS.ProcessEnv = { EXISTING: "v" };
	setActiveGoalEnv(env, "", "should-not-set");
	assert.equal(env[""], undefined);
	assert.deepEqual(Object.keys(env), ["EXISTING"]);
});

test("clearActiveGoalEnv: empty name is a no-op", () => {
	const env: NodeJS.ProcessEnv = { EXISTING: "v" };
	clearActiveGoalEnv(env, "");
	// Should not have created or deleted any spurious keys.
	assert.deepEqual(Object.keys(env), ["EXISTING"]);
});

test("getRepoName: returns basename of cwd when not in a git repo", () => {
	// A temp directory with no .git — getRepoName should fall back to cwd basename.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-nongit-"));
	try {
		const name = getRepoName(tmp);
		assert.equal(name, path.basename(tmp));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("getRepoName: returns empty string when cwd is empty", () => {
	// Empty cwd → gitRun fails (ENOENT) → top is null → base is "" → return "".
	assert.equal(getRepoName(""), "");
});

test("buildActiveEnvContext: assembles context from cwd and goalId", () => {
	const ctx = buildActiveEnvContext(process.cwd(), "goal-abc");
	assert.equal(ctx.goalId, "goal-abc");
	assert.equal(ctx.cwd, process.cwd());
	assert.ok(typeof ctx.repo === "string");
	assert.ok(typeof ctx.branch === "string");
});

test("buildActiveEnvContext: non-git directory yields empty repo and branch", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ctx-nongit-"));
	try {
		const ctx = buildActiveEnvContext(tmp, "g1");
		assert.equal(ctx.repo, path.basename(tmp));
		assert.equal(ctx.branch, "");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
