/**
 * Race-condition test for acquireLock (RED phase — proves the TOCTOU bug).
 *
 * Spawns N child processes that all try to acquire the same goal's lock
 * simultaneously via a file-based barrier. Exactly ONE should win.
 *
 * With the buggy writeLockAtomic + verify-read pattern, >1 winners occur
 * because the rename-overwrite is not truly atomic — between process A's
 * write and A's verify-read, process B can overwrite the lock file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { lockDir, writeLockAtomic } from "../extensions/goal-lock.ts";

const LEASE_MS = 180_000;
const NUM_RACERS = 5;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-race-"));
	return dir;
}

const GOAL_LOCK_PATH = path.resolve("extensions/goal-lock.ts");

function writeWorkerScript(tmpDir: string, goalId: string, sessionId: string): string {
	const barrierFile = path.join(tmpDir, ".barrier");
	const script = `
import { acquireLock } from "${GOAL_LOCK_PATH.replace(/\\/g, "\\\\")}";
import * as fs from "node:fs";

const cwd = process.argv[2];
const goalId = process.argv[3];
const sessionId = process.argv[4];
const LEASE_MS = ${LEASE_MS};
const barrierFile = ${JSON.stringify(barrierFile)};

// Signal readiness
fs.writeFileSync(barrierFile + "." + sessionId, "ready");

// Wait for barrier (all workers ready) or timeout (5s)
const start = Date.now();
while (Date.now() - start < 5000) {
    const files = fs.readdirSync(${JSON.stringify(tmpDir)}).filter(f => f.startsWith(".barrier."));
    if (files.length >= ${NUM_RACERS}) break;
    if (Date.now() - start > 4000) break;
}

const self = { sessionId, pid: process.pid };
try {
    const result = acquireLock(cwd, goalId, self, LEASE_MS);
    process.stdout.write(JSON.stringify({ ok: result.ok, sessionId }) + "\\n");
    // Hold the lock for 3s so other racers have time to collide
    if (result.ok) {
        const holdStart = Date.now();
        while (Date.now() - holdStart < 3000) { /* busy wait */ }
    }
} catch(e: any) {
    process.stderr.write("ERROR: " + e.message + "\\n");
    process.stdout.write(JSON.stringify({ ok: false, sessionId, error: e.message }) + "\\n");
}
`;
	const scriptPath = path.join(tmpDir, `worker-${sessionId}.ts`);
	fs.writeFileSync(scriptPath, script);
	return scriptPath;
}

function runWorker(scriptPath: string, cwd: string, goalId: string, sessionId: string): Promise<{ ok: boolean; sessionId: string }> {
	return new Promise((resolve) => {
		const child = spawn("npx", ["tsx", scriptPath, cwd, goalId, sessionId], {
			stdio: ["ignore", "pipe", "pipe"],
			cwd: path.resolve("."), // pi-goal-xx root
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.on("close", () => {
			try {
				const result = JSON.parse(stdout.trim());
				resolve(result);
			} catch {
				resolve({ ok: false, sessionId });
			}
		});
		child.on("error", () => {
			resolve({ ok: false, sessionId });
		});
	});
}

describe("acquireLock race condition (TOCTOU bug)", () => {
	it("exactly one winner among N concurrent racers on a stale lock", async () => {
		const cwd = tmpCwd();
		const goalId = "race-goal";

		// Plant a stale lock (dead PID) so all racers see it as stale
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		const past = Date.now() - 10_000;
		writeLockAtomic(cwd, goalId, {
			goalId,
			owner: { sessionId: "dead", pid: 0x7FFFFFFF },
			acquiredAt: new Date(past).toISOString(),
			expiresAt: new Date(past).toISOString(),
			heartbeatAt: new Date(past).toISOString(),
		});

		// Spawn N workers simultaneously
		const workers: Promise<{ ok: boolean; sessionId: string }>[] = [];
		for (let i = 0; i < NUM_RACERS; i++) {
			const sid = `racer-${i}`;
			const scriptPath = writeWorkerScript(cwd, goalId, sid);
			workers.push(runWorker(scriptPath, cwd, goalId, sid));
		}

		const results = await Promise.all(workers);
		const winners = results.filter((r) => r.ok);

		// Clean up
		fs.rmSync(cwd, { recursive: true, force: true });

		assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}. Winners: ${winners.map((w) => w.sessionId).join(", ")}`);
	});

	it("exactly one winner when no prior lock exists (clean slate)", async () => {
		const cwd = tmpCwd();
		const goalId = "clean-race-goal";

		// No pre-existing lock — all racers start from scratch
		const workers: Promise<{ ok: boolean; sessionId: string }>[] = [];
		for (let i = 0; i < NUM_RACERS; i++) {
			const sid = `clean-${i}`;
			const scriptPath = writeWorkerScript(cwd, goalId, sid);
			workers.push(runWorker(scriptPath, cwd, goalId, sid));
		}

		const results = await Promise.all(workers);
		const winners = results.filter((r) => r.ok);

		// Clean up
		fs.rmSync(cwd, { recursive: true, force: true });

		assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}. Winners: ${winners.map((w) => w.sessionId).join(", ")}`);
	});
});
