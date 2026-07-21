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

import {
	DEFAULT_ACTIVE_ENV_NAME,
	DEFAULT_ACTIVE_ENV_TEMPLATE,
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

test("getBranchName: returns current branch or empty string", () => {
	const cwd = process.cwd();
	const branch = getBranchName(cwd);
	assert.ok(typeof branch === "string");
	// We are on feat/goal-active-env-var in the worktree
	assert.equal(branch, "feat/goal-active-env-var");
});
