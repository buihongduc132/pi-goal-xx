/**
 * RED tests for the CodeRabbit/Gemini review comments on PR #39:
 * - Comment 3619913059 (gemini): use execFileSync (security/perf)
 * - Comment 3619924986 (coderabbit): map detached HEAD → ""
 * - Comment 3619924992 (coderabbit MAJOR): turn_end completion clears env
 * - Comment 3619924996 (coderabbit MAJOR): name-change while focused clears old var
 * - Comment 3619924997 (coderabbit): brittle branch-name assertion in test
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import {
	getBranchName,
	resolveActiveEnvValue,
} from "../extensions/goal-env-runtime.ts";

test("getBranchName: detached HEAD returns empty string (not 'HEAD')", () => {
	// Create a temp git repo, detach HEAD, verify getBranchName returns "".
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-detached-"));
	try {
		execSync("git init -q", { cwd: tmp });
		execSync('git config user.email t@e.invalid', { cwd: tmp });
		execSync('git config user.name t', { cwd: tmp });
		fs.writeFileSync(path.join(tmp, "f"), "x");
		execSync("git add f && git commit -qm init", { cwd: tmp });
		execSync("git checkout -q --detach", { cwd: tmp });

		const branch = getBranchName(tmp);
		assert.equal(branch, "", `detached HEAD must yield empty string, got: ${JSON.stringify(branch)}`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("getBranchName: normal branch returns the actual branch name", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-branch-"));
	try {
		execSync("git init -q", { cwd: tmp });
		execSync('git config user.email t@e.invalid', { cwd: tmp });
		execSync('git config user.name t', { cwd: tmp });
		fs.writeFileSync(path.join(tmp, "f"), "x");
		execSync("git add f && git commit -qm init", { cwd: tmp });
		execSync("git checkout -q -b mybranch", { cwd: tmp });

		const branch = getBranchName(tmp);
		assert.equal(branch, "mybranch");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
