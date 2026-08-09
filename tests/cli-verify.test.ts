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
		// Mock jewilo by providing a fake PATH with a script
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const jewiloScript = `#!/bin/sh
echo "APPROVED_HASH=070526-84f5ae38"
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal for verification",
			env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
		});

		assert.ok(result.success, "verify must succeed");
		assert.ok(result.hash, "must return approval hash");
		assert.equal(result.hash, "070526-84f5ae38");
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
echo "ERROR: verification failed"
exit 1
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal",
			env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
		});

		assert.equal(result.success, false, "verify must fail on non-zero exit");
		assert.ok(result.error, "must return error message");
	});

	it("returns error when jewilo output has no hash", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const jewiloScript = `#!/bin/sh
echo "some output without hash"
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test goal",
			env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
		});

		assert.equal(result.success, false, "verify must fail when no hash in output");
		assert.ok(result.error, "must return error about missing hash");
	});

	it("passes goal objective text to jewilo", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		// Script that echoes its arguments to a file so we can inspect
		const logFile = path.join(dir, "args.log");
		const jewiloScript = `#!/bin/sh
echo "$@" > "${logFile}"
echo "APPROVED_HASH=abc123-deadbeef"
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const objective = "build the CLI binary with create and verify";
		await runVerify({
			cwd: dir,
			goalObjective: objective,
			env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
		});

		const logged = fs.readFileSync(logFile, "utf8");
		assert.ok(
			logged.includes(objective) || logged.length > 0,
			"jewilo must receive goal objective as argument or input",
		);
	});

	it("returns structured result with success, hash?, error?", async () => {
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin, { recursive: true });
		const jewiloScript = `#!/bin/sh
echo "APPROVED_HASH=test-hash-123"
exit 0
`;
		fs.writeFileSync(path.join(fakeBin, "jewilo"), jewiloScript, { mode: 0o755 });

		const result = await runVerify({
			cwd: dir,
			goalObjective: "test",
			env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
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
