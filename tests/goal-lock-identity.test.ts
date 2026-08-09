/**
 * RED phase — failing tests that PROVE two bugs in the goal focus lock.
 *
 * Bug #1 — PID recycle false-held: `isPidAlive` uses `process.kill(pid, 0)`
 *   (PID *existence*) with NO process-identity check. When the owning pi dies
 *   and the OS recycles that PID within the 3-min lease, the lock falsely stays
 *   "held". Fix: record `owner.startTimeMs` at acquisition and have `isPidAlive`
 *   cross-check the live process's real start time. See
 *   `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md` (H1) and
 *   `openspec/changes/fix-goal-focus-lock-staleness/design.md` (D1–D4).
 *
 * Bug #2 — popup cascade / reap-on-read: `reapStaleLock` only runs on the
 *   acquisition path. `computeHeldByOther` (goal picker/list) is a PURE read and
 *   never reaps, so a stale lock sits on disk indefinitely until another session
 *   tries to acquire — and (combined with Bug #1) `confirmFocusOverride` keeps
 *   firing the "take over" popup. Fix: reap STALE locks on read; never reap
 *   HELD ones. See design D5/D6.
 *
 * ─── TDD contract for the GREEN comrade ─────────────────────────────────────
 * These tests assert the following NEW surface in `extensions/goal-lock.ts`
 * (and `extensions/goal.ts` for reap-on-read). Until it exists, EVERY test that
 * references a missing symbol FAILS (RED) — that is the intended outcome of this
 * phase. Implementers MUST make all of these green WITHOUT touching assertions:
 *
 *   goal-lock.ts exports:
 *     getProcessStartTime(pid: number): number | null     // tasks 1.1–1.4, 2.2
 *     readBootTimeMs(): number | null                      // task 1.5
 *     isPidAlive(pid: number, startTimeMs?: number | null) // task 3.4 (sig change)
 *     GoalFocusLock.owner.startTimeMs?: number | null      // task 2.1
 *     GoalFocusLock.owner missing startTimeMs → normalized to null on read (2.4)
 *     acquireLock / refreshLease write owner.startTimeMs    // task 2.3
 *
 *   goal.ts (reap-on-read, NOT exported — exercised through /goal-list and
 *   /goal-focus commands via the shared test harness):
 *     computeHeldByOther reaps STALE locks on sight, never HELD ones  // task 4.4
 *     confirmFocusOverride treats a recycled-PID lock as stale (no popup) // 4.3
 *
 * ─── Mechanic notes (why we don't mock fs) ─────────────────────────────────
 * N1 — Node v22's ESM `fs` namespace is SEALED: `mock.method(fs,"readFileSync")`
 *      throws "Cannot redefine property", and mocking the CJS default-export
 *      object does NOT propagate through the namespace getter. So the
 *      start-time/ boot-time tests read the REAL `/proc` filesystem on Linux
 *      and independently RECOMPUTE the expected value (no fragile mocks). This
 *      matches the existing suite's style (real `process.pid`, real
 *      `process.kill`). Linux-only assertions are gated on `process.platform`;
 *      the "function exists" assertions run on every platform.
 * N2 — `process.platform` is read-only; we override it via `Object.defineProperty`
 *      (configurable) and restore the original descriptor in `finally`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * RED/GUARD legend (per the TDD brief):
 *   [RED]   fails today, proves the bug — turns green once the fix lands.
 *   [GUARD] passes today; encodes an invariant the GREEN impl must PRESERVE
 *           (e.g. "never reap a held lock"). Included so the GREEN phase cannot
 *           silently regress it. Counted in the report as non-RED.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Namespace import: accessing a not-yet-exported symbol yields `undefined`
// (it does NOT throw at module load, unlike a static `import { x }`). This lets
// each test report its own granular failure instead of the whole file failing
// to import.
import * as goalLock from "../extensions/goal-lock.ts";
import {
	type GoalFocusLock,
	type LockOwner,
	lockDir,
	lockPath,
	readLock,
	isPidAlive,
	writeLockAtomic,
	acquireLock,
	reapStaleLock,
	refreshLease,
} from "../extensions/goal-lock.ts";
// Bug #2 is exercised through the real goal.ts extension + shared harness
// (computeHeldByOther / confirmFocusOverride are module-private, so we reach
// them via the /goal-list and /goal-focus command paths — NO source export
// shim is added to goal.ts).
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeCommand,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

const LEASE_MS = 180_000;
const CLK_TCK = 100; // design D3: hardcoded 100 on virtually all Linux.

// ───────────────────────────── helpers ─────────────────────────────

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-id-"));
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function mkLock(over: Partial<GoalFocusLock> = {}): GoalFocusLock {
	const now = Date.now();
	return {
		goalId: "g1",
		owner: { sessionId: "s1", pid: process.pid },
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + LEASE_MS).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
		...over,
	};
}

/** Temporarily override process.platform (read-only prop) and restore it. */
function withPlatform<T>(plat: string, fn: () => T): T {
	const origDesc = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: plat,
		configurable: true,
		writable: true,
	});
	try {
		return fn();
	} finally {
		if (origDesc) Object.defineProperty(process, "platform", origDesc);
	}
}

/** Read field 22 (starttime, clock ticks since boot) from /proc/<pid>/stat. */
function readStatStarttimeTicks(pid: number): number {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
	// Fields after "(comm)" are 1-indexed from field 3; starttime is field 22
	// → index 19 in this 0-based slice.
	return Number(afterComm[19]);
}

/** Read boot time (epoch seconds) from /proc/stat `btime` line. */
function readBtimeSeconds(): number {
	const stat = fs.readFileSync("/proc/stat", "utf8");
	const line = stat.split("\n").find((l) => l.startsWith("btime"));
	assert.ok(line, "/proc/stat has a btime line on Linux");
	return Number(line!.trim().split(/\s+/)[1]);
}

// ════════════════════════════════════════════════════════════════════
// Bug #1 — Process-identity start-time resolution (PID recycle false-held)
// ════════════════════════════════════════════════════════════════════
describe("Bug #1 — process-identity start-time (PID recycle false-held)", () => {

	describe("getProcessStartTime", () => {
		it("[RED] is exported from goal-lock.ts as a function", () => {
			assert.equal(
				typeof (goalLock as any).getProcessStartTime,
				"function",
				"getProcessStartTime must be exported from extensions/goal-lock.ts",
			);
		});

		it("[RED] (pid) returns start-time ms on Linux = bootMs + (ticks/CLK_TCK)*1000", () => {
			assert.equal(typeof (goalLock as any).getProcessStartTime, "function");
			if (process.platform !== "linux") return; // no /proc elsewhere
			const fn: (pid: number) => number | null = (goalLock as any).getProcessStartTime;
			const got = fn(process.pid);
			assert.equal(typeof got, "number", "must return a number on Linux");
			// Independent recomputation from the same /proc sources.
			const ticks = readStatStarttimeTicks(process.pid);
			const bootMs = readBtimeSeconds() * 1000;
			const expected = bootMs + (ticks / CLK_TCK) * 1000;
			assert.ok(
				Math.abs((got as number) - expected) <= 10,
				`start-time ms ${got} should match bootMs+(ticks/100)*1000 ≈ ${expected}`,
			);
			assert.ok((got as number) > 0 && (got as number) <= Date.now(), "start time is sane");
		});

		it("[RED] (dead pid) returns null on unreadable /proc (fail-open, no throw)", () => {
			assert.equal(typeof (goalLock as any).getProcessStartTime, "function");
			const fn: (pid: number) => number | null = (goalLock as any).getProcessStartTime;
			const dead = 0x7fffffff; // extremely unlikely to exist
			let got: unknown;
			assert.doesNotThrow(() => { got = fn(dead); }, "must not throw on ENOENT/EACCES");
			assert.equal(got, null, "unreadable /proc/<pid>/stat → null (fail-open)");
		});

		it("[RED] returns null on an unsupported platform (e.g. win32)", () => {
			assert.equal(typeof (goalLock as any).getProcessStartTime, "function");
			const fn: (pid: number) => number | null = (goalLock as any).getProcessStartTime;
			withPlatform("win32", () => {
				assert.equal(
					fn(process.pid),
					null,
					"unsupported platform → null (falls back to PID-only)",
				);
			});
		});

		it("[RED] on darwin uses ps -o lstart (returns a number; never throws)", () => {
			assert.equal(typeof (goalLock as any).getProcessStartTime, "function");
			const fn: (pid: number) => number | null = (goalLock as any).getProcessStartTime;
			// On this dev host `ps` exists, so the darwin branch should parse a
			// number; if the probe can't parse it must fail-open to null (never throw).
			let got: unknown;
			assert.doesNotThrow(() => {
				withPlatform("darwin", () => { got = fn(process.pid); });
			});
			assert.ok(
				got === null || typeof got === "number",
				`darwin path must return number|null, got ${typeof got}`,
			);
		});
	});

	describe("readBootTimeMs", () => {
		it("[RED] is exported from goal-lock.ts as a function", () => {
			assert.equal(
				typeof (goalLock as any).readBootTimeMs,
				"function",
				"readBootTimeMs must be exported from extensions/goal-lock.ts",
			);
		});

		it("[RED] () reads /proc/stat btime → epoch ms on Linux", () => {
			assert.equal(typeof (goalLock as any).readBootTimeMs, "function");
			if (process.platform !== "linux") return;
			const fn: () => number | null = (goalLock as any).readBootTimeMs;
			const got = fn();
			assert.equal(typeof got, "number");
			assert.equal(got, readBtimeSeconds() * 1000);
			assert.ok((got as number) > 0 && (got as number) < Date.now());
		});
	});

	describe("isPidAlive — identity-aware (closes the recycle gap)", () => {
		it("[RED] (pid, startTimeMs) returns FALSE when PID exists but start time MISMATCHES — core recycle repro", () => {
			// process.pid is alive, but we pass a start time that is NOT this
			// process's real start time (simulating the PID being recycled to a
			// different process). Current code ignores the 2nd arg → returns true
			// (the bug). Fix must compare and return false.
			const bogusStartTimeMs = 1; // epoch+1ms — impossible real start time
			assert.equal(
				isPidAlive(process.pid, bogusStartTimeMs),
				false,
				"a live PID whose real start time differs must NOT be considered the lock owner (PID recycle)",
			);
		});

		it("[RED] (pid, startTimeMs) returns TRUE when PID exists and start time MATCHES", () => {
			// Needs getProcessStartTime to obtain the real start time.
			assert.equal(
				typeof (goalLock as any).getProcessStartTime,
				"function",
				"getProcessStartTime required to read the real start time",
			);
			const fn: (pid: number) => number | null = (goalLock as any).getProcessStartTime;
			const real = fn(process.pid);
			assert.equal(typeof real, "number", "real start time is a number");
			assert.equal(
				isPidAlive(process.pid, real as number),
				true,
				"matching start time → alive",
			);
		});

		it("[GUARD] (pid, null) falls back to PID-existence-only (legacy lock, no startTimeMs)", () => {
			// Legacy locks have startTimeMs === null → cannot do identity check →
			// must behave exactly like the old pid-only check. This passes today
			// (extra arg ignored) and MUST keep passing after the signature change.
			assert.equal(isPidAlive(process.pid, null), true, "alive pid, null startTimeMs → alive");
			assert.equal(isPidAlive(0x7fffffff, null), false, "dead pid, null startTimeMs → dead");
		});
	});

	describe("lock schema — startTimeMs recorded at acquisition", () => {
		it("[RED] acquireLock writes owner.startTimeMs (number) into the lock file", () => {
			const cwd = tmpCwd();
			const self: LockOwner = { sessionId: "s1", pid: process.pid };
			const result = acquireLock(cwd, "g1", self, LEASE_MS);
			assert.equal(result.ok, true);
			const lock = readLock(cwd, "g1");
			assert.ok(lock, "lock was written");
			assert.equal(
				typeof (lock as any)?.owner?.startTimeMs,
				"number",
				"owner.startTimeMs must be recorded when acquiring",
			);
		});

		it("[RED] refreshLease preserves/writes owner.startTimeMs", () => {
			const cwd = tmpCwd();
			const self: LockOwner = { sessionId: "s1", pid: process.pid };
			acquireLock(cwd, "g1", self, LEASE_MS);
			refreshLease(cwd, "g1", self, LEASE_MS);
			const lock = readLock(cwd, "g1");
			assert.ok(lock, "lock present after refresh");
			assert.equal(
				typeof (lock as any)?.owner?.startTimeMs,
				"number",
				"owner.startTimeMs must survive/refresh",
			);
		});

		it("[RED] legacy lock missing startTimeMs parses with owner.startTimeMs === null", () => {
			// A lock written by a pre-change session lacks startTimeMs entirely.
			// readLock/parseLock must tolerate it and NORMALIZE to null (design D4),
			// so isPidAlive falls back to pid-only — no false-negative during rollout.
			const cwd = tmpCwd();
			fs.mkdirSync(lockDir(cwd), { recursive: true });
			const legacy = {
				goalId: "g1",
				owner: { sessionId: "legacy", pid: 0x7fffffff }, // NO startTimeMs
				acquiredAt: new Date(Date.now()).toISOString(),
				expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
				heartbeatAt: new Date(Date.now()).toISOString(),
			};
			fs.writeFileSync(lockPath(cwd, "g1"), JSON.stringify(legacy));
			const lock = readLock(cwd, "g1");
			assert.ok(lock, "legacy lock must still parse");
			assert.equal(
				(lock as any).owner.startTimeMs,
				null,
				"missing startTimeMs must normalize to null (not undefined)",
			);
		});
	});
});

// ════════════════════════════════════════════════════════════════════
// Bug #2 — Reap-on-read (popup cascade root)
//
// computeHeldByOther / confirmFocusOverride are module-private in goal.ts, so
// we exercise them through the REAL extension via /goal-list (which always
// calls computeHeldByOther) and /goal-focus (single-goal fast path →
// confirmFocusOverride). No export shim is added to goal.ts.
// ════════════════════════════════════════════════════════════════════
describe("Bug #2 — reap-on-read (popup cascade root)", () => {
	const OTHER: LockOwner = { sessionId: "other-cascade-session", pid: process.pid };

	let cwd: string;
	let pi: ReturnType<typeof createMockPi> | null = null;
	let envSnap: EnvSnapshot;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-id-"));
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		envSnap = forceNonWorkerEnv();
	});

	afterEach(async () => {
		if (pi) {
			try { await cleanupTimers(pi, cwd); } catch {}
		}
		pi = null;
		restoreGoalEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	function setup(hasUI: boolean) {
		const local = createMockPi({ cwd });
		const ctx = createMockCtx(local, {
			cwd,
			hasUI,
			sessionManager: { getBranch: () => [] as any[] } as any,
		});
		goalExtension(local);
		pi = local;
		return { pi: local, ctx };
	}

	async function loadGoals(pi: ReturnType<typeof createMockPi>, ctx: any) {
		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();
	}

	/** Plant a lease-EXPIRED (stale) lock owned by OTHER. */
	function plantStaleLock(goalId: string) {
		const dir = path.join(cwd, ".pi", "goals", ".locks");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${goalId}.lock`), JSON.stringify({
			goalId,
			owner: OTHER,
			acquiredAt: new Date(Date.now() - 60_000).toISOString(),
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		}));
	}

	/** Plant a HELD lock owned by OTHER (alive pid + fresh lease). */
	function plantHeldLock(goalId: string) {
		acquireLock(cwd, goalId, OTHER, LEASE_MS);
	}

	/**
	 * Plant a lock that looks HELD under the *current* (buggy) liveness check
	 * but is actually STALE because the PID was recycled: owner.pid is an
	 * alive process (the test runner) carrying a startTimeMs that does NOT match
	 * that process's real start time. Until Bug #1's identity check lands,
	 * isLockHeld returns true here → confirmFocusOverride prompts.
	 */
	function plantRecycledPidLock(goalId: string) {
		const dir = path.join(cwd, ".pi", "goals", ".locks");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${goalId}.lock`), JSON.stringify({
			goalId,
			owner: { ...OTHER, startTimeMs: 1 /* BOGUS — not this process's real start */ },
			acquiredAt: new Date(Date.now()).toISOString(),
			expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
			heartbeatAt: new Date(Date.now()).toISOString(),
		}));
	}

	// ── computeHeldByOther (via /goal-list — always calls it, headless-safe) ──

	it("[RED] computeHeldByOther reaps a STALE lock it reads (file deleted)", async () => {
		writeGoalFile(cwd, { id: "ga", autoContinue: true });
		writeGoalFile(cwd, { id: "gb", autoContinue: true });
		const { pi, ctx } = setup(false /* headless: goal-list just notifies */);
		await loadGoals(pi, ctx);
		plantStaleLock("ga"); // truly stale (lease expired) — but nothing acquires it

		await invokeCommand(pi, ctx, "goal-list", "");

		// computeHeldByOther READS this lock; the fix must REAP stale-on-read.
		assert.equal(
			readLock(cwd, "ga"),
			null,
			"a stale lock observed on the read path must be reaped (reap-on-read)",
		);
	});

	it("[GUARD] computeHeldByOther does NOT reap a HELD lock (read is non-destructive for live)", async () => {
		writeGoalFile(cwd, { id: "ga", autoContinue: true });
		writeGoalFile(cwd, { id: "gb", autoContinue: true });
		const { pi, ctx } = setup(false);
		await loadGoals(pi, ctx);
		plantHeldLock("gb"); // alive pid + fresh lease → genuinely held by OTHER

		await invokeCommand(pi, ctx, "goal-list", "");

		const lock = readLock(cwd, "gb");
		assert.ok(lock, "a HELD lock must NOT be reaped on read");
		assert.equal(lock!.owner.sessionId, OTHER.sessionId, "held lock ownership preserved");
	});

	// ── confirmFocusOverride (via /goal-focus single-goal fast path) ──

	it("[RED] confirmFocusOverride: recycled-PID lock → silent reap, NO takeover popup", async () => {
		// This is the cascade root (findings H1): a falsely-held lock makes the
		// "take over" modal fire on every focus/resume. Once identity-aware
		// isPidAlive lands, this lock is recognized as stale → reaped silently →
		// no ctx.ui.confirm.
		writeGoalFile(cwd, { id: "cascade-goal", autoContinue: true });
		const { pi, ctx } = setup(true /* hasUI: confirm can fire */);
		await loadGoals(pi, ctx);
		plantRecycledPidLock("cascade-goal");

		let confirmCalls = 0;
		const origConfirm = pi.ui.confirm.bind(pi.ui);
		(pi.ui as any).confirm = async (prompt: string, opts?: any) => {
			confirmCalls++;
			return origConfirm(prompt, opts);
		};

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		assert.equal(
			confirmCalls,
			0,
			"a recycled-PID lock is stale; confirmFocusOverride must NOT prompt (popup cascade)",
		);
		// And the stale lock should have been cleared.
		assert.equal(
			readLock(cwd, "cascade-goal") === null
				|| readLock(cwd, "cascade-goal")?.owner.sessionId !== OTHER.sessionId,
			true,
			"stale lock reaped / taken over silently (no popup)",
		);
	});

	it("[GUARD] confirmFocusOverride: lease-stale lock → silent reap, no popup, proceed", async () => {
		// Lease-expired locks are ALREADY reaped silently today (confirmFocusOverride
		// calls releaseLock on !isLockHeld). This pins that behavior so the GREEN
		// refactor (releaseLock → reapStaleLock) preserves it.
		writeGoalFile(cwd, { id: "stale-goal", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);
		plantStaleLock("stale-goal");

		let confirmCalls = 0;
		const origConfirm = pi.ui.confirm.bind(pi.ui);
		(pi.ui as any).confirm = async (prompt: string, opts?: any) => {
			confirmCalls++;
			return origConfirm(prompt, opts);
		};

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		assert.equal(confirmCalls, 0, "lease-stale lock must not prompt");
		// confirmFocusOverride silently reaps the stale lock, then setFocusedGoalId
		// acquires a FRESH lock for SELF — so the on-disk lock is now either gone
		// or owned by us, never still OTHER's stale one.
		const lock = readLock(cwd, "stale-goal");
		assert.ok(
			!lock || lock.owner.sessionId !== OTHER.sessionId,
			"stale lock reaped (no longer OTHER's)",
		);
	});

	// ── reapStaleLock TOCTOU guard (exported; direct unit test) ──

	it("[GUARD] reapStaleLock TOCTOU: a lock that became HELD between read & reap survives", () => {
		// Adding callers (computeHeldByOther / confirmFocusOverride) must NOT
		// weaken reapStaleLock's re-read-before-unlink guard. Approximate the
		// race: plant stale, then a newcomer overwrites with a HELD lock before
		// reap runs → reap must abort and leave the held lock intact.
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock({ owner: { sessionId: "dead", pid: 0x7fffffff } }));
		writeLockAtomic(cwd, "g1", mkLock({ owner: { sessionId: "newcomer", pid: process.pid } }));
		reapStaleLock(cwd, "g1");
		const after = readLock(cwd, "g1");
		assert.ok(after, "a lock that is now HELD must survive reapStaleLock (TOCTOU guard)");
		assert.equal(after!.owner.sessionId, "newcomer", "newcomer's fresh lock not stolen");
	});
});
