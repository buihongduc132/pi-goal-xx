import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { runVerify } from "../src/cli/verify.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cli-verify-"));
}

function cleanup(dir: string) {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a hermetic env that strips VERIFIER_LOOP_HOME (which leaks from real machine config). */
function hermeticEnv(overrides: Record<string, string>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k !== "VERIFIER_LOOP_HOME") env[k] = v;
	}
	return { ...env, ...overrides };
}

describe("CLI verify subcommand", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});

	afterEach(() => {
		cleanup(dir);
	});

	it("exports runVerify function", () => {
		assert.equal(typeof runVerify, "function");
	});

	it("returns approval hash on successful verifier-loop", async () => {
		// Mock jewilo --json NEW output + completion.json (durable proof)
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const goalId = "test-uuid-1234";
		const fakeHome = dir;
		const goalsDir = path.join(fakeHome, ".verifier-loop", "goals", goalId);
		fs.mkdirSync(goalsDir, { recursive: true });
		fs.writeFileSync(
			path.join(goalsDir, "completion.json"),
			JSON.stringify({ hash: "080926-84f5ae38", goalId, roundNumber: 1 }),
		);
		const jewiloScript = `#!/bin/sh
echo '{"ok":true,"command":"new","goalId":"${goalId}","state":"consensus_pass"}'
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal for verification".padEnd(500, " "),
			env: hermeticEnv({ PATH: `${fakeBin}:${process.env.PATH}`, HOME: fakeHome }),
		});

		assert.ok(result.success, "verify must succeed");
		assert.ok(result.hash, "must return approval hash");
		assert.equal(result.hash, "080926-84f5ae38");
	});

	it("returns error when jewilo is not found", async () => {
		const emptyBin = path.join(dir, "empty-bin");
		fs.mkdirSync(emptyBin, { recursive: true });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal",
			env: { PATH: emptyBin, HOME: dir },
		});

		assert.equal(result.success, false, "verify must fail when jewilo missing");
		assert.ok(result.error, "must return error message");
		assert.ok(
			result.error!.toLowerCase().includes("jewilo") ||
			result.error!.toLowerCase().includes("not found") ||
			result.error!.toLowerCase().includes("command"),
			`error must mention jewilo or not found, got: ${result.error}`,
		);
	});

	it("returns error when jewilo exits non-zero", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const jewiloScript = `#!/bin/sh
echo '{"ok":false,"command":"new","error":"verification failed"}'
exit 1
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal".padEnd(500, " "),
			env: hermeticEnv({ PATH: `${fakeBin}:${process.env.PATH}` }),
		});

		assert.equal(result.success, false, "verify must fail on non-zero exit");
		assert.ok(result.error, "must return error message");
	});

	it("returns error when jewilo output has no hash", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const jewiloScript = `#!/bin/sh
echo '{"ok":true,"command":"new","goalId":"no-completion-dir","state":"consensus_pass"}'
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal".padEnd(500, " "),
			env: hermeticEnv({ PATH: `${fakeBin}:${process.env.PATH}`, HOME: dir }),
		});

		assert.equal(result.success, false, "verify must fail when no hash in output");
		assert.ok(result.error, "must return error about missing hash");
	});

	it("passes goal objective text to jewilo", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		// Script that echoes its arguments to a file so we can inspect
		const logFile = path.join(dir, "args.log");
		const goalId = "arg-test-goal";
		const goalsDir = path.join(dir, ".verifier-loop", "goals", goalId);
		fs.mkdirSync(goalsDir, { recursive: true });
		fs.writeFileSync(
			path.join(goalsDir, "completion.json"),
			JSON.stringify({ hash: "080926-abcdef12", goalId }),
		);
		const jewiloScript = `#!/bin/sh
echo "$@" > "${logFile}"
echo '{"ok":true,"goalId":"${goalId}"}'
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const objective = "build the CLI binary with create and verify".padEnd(500, " ");
		await runVerify({
			cwd: dir,
			goalObjective: objective,
			env: hermeticEnv({ PATH: `${fakeBin}:${process.env.PATH}`, HOME: dir }),
		});

		const logged = fs.readFileSync(logFile, "utf8");
		assert.ok(
			logged.includes(objective.trim()) || logged.includes("NEW"),
			"jewilo must receive goal objective as argument",
		);
	});

	it("returns structured result with success, hash?, error?", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const goalId = "shape-test-goal";
		const goalsDir = path.join(dir, ".verifier-loop", "goals", goalId);
		fs.mkdirSync(goalsDir, { recursive: true });
		fs.writeFileSync(
			path.join(goalsDir, "completion.json"),
			JSON.stringify({ hash: "080926-testhash", goalId }),
		);
		const jewiloScript = `#!/bin/sh
echo '{"ok":true,"goalId":"${goalId}"}'
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test".padEnd(500, " "),
			env: hermeticEnv({ PATH: `${fakeBin}:${process.env.PATH}`, HOME: dir }),
		});

		// Result shape: { success: boolean, hash?: string, error?: string }
		assert.equal(typeof result.success, "boolean");
		if (result.success) {
			assert.equal(typeof result.hash, "string");
		} else {
			assert.equal(typeof result.error, "string");
		}
	});
});
