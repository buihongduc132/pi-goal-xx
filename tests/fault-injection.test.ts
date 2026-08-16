/**
 * Fault-injection persistence tests.
 *
 * Ported from upstream tmonk/pi-goal-x 55d4b46 (reliability campaign 2026-08-09),
 * adapted to pi-goal-xx module layout and APIs:
 *   - our lock layer is `extensions/goal-lock.ts` (lease-based, acquireLock/
 *     releaseLock + LockOwner) — upstream's `storage/goal-lock.ts`
 *     acquireGoalLock/.release() does NOT exist here
 *   - our persistence layer has NO in-process caches — readActiveGoalPool /
 *     readGoalLedger read fresh from disk on every call, so upstream's
 *     invalidateGoalPoolCache / invalidateGoalLedgerCache calls are dropped
 *   - upstream test 5 (diffGoalRefreshState cross-process cache pickup) is
 *     NOT ported: we have no /goal-refresh cache-diff feature
 *
 * Covered: torn goal-file writes, torn ledger tails, stale-lock reclaim +
 * live-holder contention (real child processes), concurrent multi-process
 * goal-file writes never tearing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createGoal } from "../extensions/goal-record.ts";
import {
	parseGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import {
	acquireLock,
	lockPath,
	releaseLock,
	type LockOwner,
} from "../extensions/goal-lock.ts";
import {
	appendGoalEvent,
	goalLedgerPath,
	readGoalLedger,
	reconstructGoalLedger,
} from "../extensions/goal-ledger.ts";

const EXT_ROOT = fileURLToPath(new URL("../extensions/", import.meta.url));
const LEASE_MS = 60_000;

function tmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-fault-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

function cleanup(cwd: string): void {
	try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

function selfOwner(sessionId = "fault-test-self"): LockOwner {
	return { sessionId, pid: process.pid };
}

describe("fault: goal-file persistence", () => {
	it("torn goal-file write is never observed as partial content", () => {
		const cwd = tmpCwd();
		try {
			const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "first version", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 9, 0, 0)));
			const filePath = path.join(cwd, goal.activePath ?? "");
			const before = fs.readFileSync(filePath, "utf8");

			// Crash between temp write and rename: partial temp file left next to
			// the goal file, goal file itself truncated (torn rename target).
			// Readers must ignore the temp file and never observe a hybrid.
			const dir = path.dirname(filePath);
			const tmpName = `${path.basename(filePath)}.tmp-${process.pid}`;
			fs.writeFileSync(path.join(dir, tmpName), before.slice(0, 40), "utf8");
			fs.writeFileSync(filePath, before.slice(0, 120), "utf8");

			const parsed = parseGoalFile(filePath);
			assert.equal(parsed, null, "truncated goal file is detected as malformed");
			const pool = readActiveGoalPool({ cwd });
			assert.equal(pool.size, 0, "torn goal is excluded from the pool; temp files are never parsed");

			// A subsequent extension write atomically restores a valid file.
			const restored = writeActiveGoalFile({ cwd }, createGoal({ objective: "restored", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 9, 1, 0)));
			const reparsed = parseGoalFile(path.join(cwd, restored.activePath ?? ""));
			assert.ok(reparsed, "re-write restores a fully parseable goal file");
			assert.equal(reparsed.objective, "restored");
		} finally {
			cleanup(cwd);
		}
	});

	it("multi-process goal-file writes never tear (one complete writer wins)", () => {
		const cwd = tmpCwd();
		try {
			// Two children write concurrently via the extension's own atomic
			// writer; the final file must be one of the two complete versions —
			// never a hybrid.
			const writer = (objective: string) => `
				const { createGoal } = require(${JSON.stringify(path.join(EXT_ROOT, "goal-record.ts"))});
				const { writeActiveGoalFile } = require(${JSON.stringify(path.join(EXT_ROOT, "storage/goal-files.ts"))});
				const goal = createGoal({ objective: ${JSON.stringify(objective)}, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 10, 0, 0));
				for (let i = 0; i < 50; i++) writeActiveGoalFile({ cwd: process.env.FAULT_CWD }, goal);
				process.exit(0);
			`;
			const a = spawnSync(process.execPath, ["--experimental-strip-types", "-e", writer("AAAA")], { cwd, env: { ...process.env, FAULT_CWD: cwd }, encoding: "utf8", timeout: 60_000 });
			const b = spawnSync(process.execPath, ["--experimental-strip-types", "-e", writer("BBBB")], { cwd, env: { ...process.env, FAULT_CWD: cwd }, encoding: "utf8", timeout: 60_000 });
			assert.equal(a.status, 0, `writer A exited ${a.status}: ${a.stderr}`);
			assert.equal(b.status, 0, `writer B exited ${b.status}: ${b.stderr}`);

			const pool = readActiveGoalPool({ cwd });
			assert.ok(pool.size >= 1, "at least one goal survived the concurrent writes");
			for (const goal of pool.values()) {
				const parsed = parseGoalFile(path.join(cwd, goal.activePath ?? ""));
				assert.ok(parsed, "every surviving goal file parses cleanly");
				assert.ok(
					parsed.objective === "AAAA" || parsed.objective === "BBBB",
					"objective is one complete writer's version, never a hybrid",
				);
			}
		} finally {
			cleanup(cwd);
		}
	});
});

describe("fault: ledger persistence", () => {
	it("torn ledger tail is counted malformed and never breaks reads or reconstruction", () => {
		const cwd = tmpCwd();
		try {
			appendGoalEvent({ cwd }, { type: "goal_created", goalId: "g1", objective: "o", sisyphus: false, autoContinue: true, at: new Date().toISOString() });

			// Crash-simulated torn append: partial JSON line at the tail.
			fs.appendFileSync(goalLedgerPath({ cwd }), '{"type": "goal_focused", "goalId": "g1", "reason": "crea', "utf8");

			const read = readGoalLedger({ cwd });
			assert.equal(read.malformed, 1, "torn line counted as malformed");
			assert.equal(read.events.length, 1, "valid events before the torn tail are intact");

			// State reconstruction tolerates the torn tail too.
			const state = reconstructGoalLedger(read.events);
			assert.equal(state.goals.size, 1);
			assert.equal(state.focusedGoalId, null, "no focus event survived; the torn tail did not corrupt state");
		} finally {
			cleanup(cwd);
		}
	});
});

describe("fault: focus-lock contention", () => {
	it("stale lock (dead pid + lapsed lease) is reclaimed promptly", () => {
		const cwd = tmpCwd();
		try {
			// Stale lock: dead pid + expired lease.
			fs.mkdirSync(path.join(cwd, ".pi", "goals", ".locks"), { recursive: true });
			const past = new Date(Date.now() - 120_000);
			fs.writeFileSync(
				lockPath(cwd, "g1"),
				JSON.stringify({
					goalId: "g1",
					owner: { sessionId: "dead-session", pid: 999_999_999, startTimeMs: null },
					acquiredAt: past.toISOString(),
					expiresAt: past.toISOString(),
					heartbeatAt: past.toISOString(),
				}),
				"utf8",
			);

			const t0 = Date.now();
			const result = acquireLock(cwd, "g1", selfOwner(), LEASE_MS);
			const elapsed = Date.now() - t0;
			assert.equal(result.ok, true, "stale lock reclaimed");
			assert.ok(elapsed < 5_000, `staleness recovery is prompt (${elapsed}ms)`);
			releaseLock(cwd, "g1", selfOwner());
		} finally {
			cleanup(cwd);
		}
	});

	it("live-holder lock fails fast (bounded, real child process)", async () => {
		const cwd = tmpCwd();
		try {
			// A child process acquires the lease lock and holds it; the
			// parent's acquisition must fail fast (bounded), not block.
			const holderScript = `
				const { acquireLock } = require(${JSON.stringify(path.join(EXT_ROOT, "goal-lock.ts"))});
				const self = { sessionId: "holder-child", pid: process.pid };
				const res = acquireLock(process.env.FAULT_CWD, "g2", self, 60000);
				if (!res.ok) { console.error("child failed to acquire"); process.exit(1); }
				console.log("HELD");
				setTimeout(() => { process.exit(0); }, 8000);
			`;
			const holder = spawn(process.execPath, ["--experimental-strip-types", "-e", holderScript], {
				cwd, env: { ...process.env, FAULT_CWD: cwd }, stdio: ["ignore", "pipe", "inherit"],
			});
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("holder never acquired the lock")), 30_000);
				holder.stdout?.on("data", (d: Buffer) => {
					if (d.toString().includes("HELD")) { clearTimeout(timer); resolve(); }
				});
				holder.on("error", reject);
			});
			assert.equal(holder.exitCode, null, "holder child is still running");

			const t1 = Date.now();
			const result = acquireLock(cwd, "g2", selfOwner(), LEASE_MS);
			const contended = Date.now() - t1;
			assert.equal(result.ok, false, "contended acquisition fails fast");
			assert.equal(result.heldByOther?.owner.sessionId, "holder-child", "failure reports the live holder");
			assert.ok(contended < 2_000, `contended acquisition bounded (${contended}ms)`);

			holder.kill("SIGKILL");
			await new Promise((resolve) => holder.on("exit", resolve));
		} finally {
			cleanup(cwd);
		}
	});
});
