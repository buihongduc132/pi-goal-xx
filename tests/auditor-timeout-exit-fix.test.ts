/**
 * Bug: auditor timeout kills the host process (pi exits on auditor timeout).
 *
 * Root cause (3 independent counterfactual analyses): `session.abort()` is
 * async (it awaits `agent.waitForIdle()`). `safeAbort` fire-and-forgets it
 * inside a `try/catch` — which is a NO-OP for async rejections. The OUTER
 * finally removes the `unhandledRejection`/`uncaughtException` process guards
 * BEFORE the floating `session.abort()` promise settles. The floating
 * rejection then escapes to Node's default handler → pi's crash handler →
 * `process.exit(1)`.
 *
 * Fix (4 changes):
 *  F1: `safeAbort` (and the `sessionRef?.abort()` fail-fast site) attach a
 *      swallowing `.catch(() => {})` SYNCHRONOUSLY to the async `abort()`
 *      return value. A promise rejection is "handled" the instant the
 *      `.catch` handler is attached — regardless of when it settles — so the
 *      late rejection can never become unhandled, even after the OUTER
 *      finally removes the process guards. (A `Promise.allSettled` drain in
 *      the finally was rejected: `abort()` awaits `waitForIdle()`, which can
 *      hang, and awaiting it would bypass the timeout ceiling.) Closes the
 *      exit vector without any collection/await.
 *  F2: default timeout ceiling 5min → 15min (createSession ~45s + real test
 *      suites 240s+ make 5min self-defeating).
 *  F3: `effectiveTimeoutMs = Math.max(timeoutMs, 60_000)` sanity floor so a
 *      config typo (e.g. `auditorTimeoutMs: 1`) cannot abort instantly.
 *  F4: comment reflects the new 15min default.
 *
 * Worst-first zones:
 *  Zone 4 (error propagation): async abort() rejection must not escape.
 *  Zone 3 (multi-component):   timeout + guard removal + late rejection.
 *  Zone 2 (boundary):          config typo floor.
 *  Zone 5 (state mutation):    a second audit runs cleanly after a timeout.
 *
 * Mock patterns reused from tests/goal-auditor-crash-safe.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-timeout-exit",
		objective: "Build the thing",
		status: "active",
		autoContinue: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-timeout-exit-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function makeCtx(cwd: string): any {
	const model = { provider: "def", id: "m1", name: "m1" };
	return {
		cwd,
		model,
		modelRegistry: {
			find: (p: string, i: string) => (p === "def" && i === "m1" ? model : undefined),
			getAvailable: () => [model],
		},
		hasUI: false,
	};
}

/**
 * createSession whose `prompt()` hangs forever and whose `abort()` returns a
 * Promise that REJECTS after a delay. This models the real pi-agent-core
 * `session.abort()` (async: `await agent.waitForIdle()`) for the case where
 * waitForIdle rejects. Before the fix, `safeAbort` fire-and-forgets this
 * rejection; it escapes AFTER the outer finally removes the process guards.
 */
function makeLateRejectingAbortCreateSession(rejectDelayMs: number): any {
	return (_args: any) => {
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				// Hang forever — only the timeout race unblocks the audit.
				return new Promise<void>(() => {});
			},
			abort(): Promise<void> {
				// async abort that rejects after a delay — emulates waitForIdle
				// rejecting AFTER the audit's outer finally removes the guards.
				return new Promise<void>((_, reject) => {
					setTimeout(() => reject(new Error("abort-rejection-boom")), rejectDelayMs);
				});
			},
		};
		return Promise.resolve({ session });
	};
}

/**
 * createSession whose `prompt()` resolves quickly. Used by tests that must NOT
 * wait for a real timeout (e.g. the floor test, which only inspects what was
 * scheduled).
 */
function makeApprovingCreateSession(delayMs: number = 10): any {
	return (_args: any) => {
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

/**
 * Run `fn` with every pre-existing `unhandledRejection` listener detached and
 * a single `tracker` attached in its place, restoring the originals in a
 * finally. This (a) prevents the test runner from failing the test on a
 * floating rejection during the RED phase and (b) prevents Node's default
 * termination (the tracker "handles" the event). Returns whatever `fn`
 * captured via `tracker`.
 *
 * Pattern adapted from the counterfactual test in
 * tests/goal-auditor-crash-safe.test.ts.
 */
async function withIsolatedUnhandledRejection<T>(
	tracker: (reason: unknown) => void,
	fn: () => Promise<T>,
): Promise<T> {
	const detached: NodeJS.UnhandledRejectionListener[] = [];
	for (const l of process.listeners("unhandledRejection")) {
		process.off("unhandledRejection", l);
		detached.push(l);
	}
	process.on("unhandledRejection", tracker);
	try {
		return await fn();
	} finally {
		process.off("unhandledRejection", tracker);
		for (const l of detached) process.on("unhandledRejection", l);
	}
}

// ---------------------------------------------------------------------------
// Zone 4 — error propagation: safeAbort must capture async abort() rejection
// ---------------------------------------------------------------------------
describe("Fix 1 (Zone 4) — async session.abort() rejection is captured, not escaped", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("behavioral: audit returns a clean timeout result even when abort() rejects asynchronously", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeLateRejectingAbortCreateSession(30),
		});
		// The audit must return a timeout result — the abort() rejection must
		// NOT throw out of runGoalCompletionAuditor or kill the process.
		assert.equal(result.timedOut, true);
		assert.equal(result.approved, false);
		assert.match(result.error ?? "", /Auditor timeout after 50ms/);
	});
});

// ---------------------------------------------------------------------------
// Zone 3 — multi-component interaction: timeout + guard removal + late rejection
// ---------------------------------------------------------------------------
describe("Fix 1 (Zone 3) — late abort() rejection does not escape after guard removal", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("behavioral: an abort() rejection that settles AFTER guard removal is swallowed", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);
		const captured: unknown[] = [];
		const tracker = (reason: unknown) => { captured.push(reason); };
		await withIsolatedUnhandledRejection(tracker, async () => {
			await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "detailed",
				// abort rejects 120ms AFTER the 50ms timeout — i.e. AFTER the
				// outer finally has removed the process guards. Before the fix
				// this floating rejection escapes as unhandledRejection.
				createSession: makeLateRejectingAbortCreateSession(120),
			});
			// Let any floating rejection surface past the audit's return.
			await new Promise<void>((r) => setTimeout(r, 250));
		});
		const boomSeen = captured.some(
			(r) => r instanceof Error && r.message === "abort-rejection-boom",
		);
		assert.equal(
			boomSeen,
			false,
			`Fix 1: late abort() rejection must NOT escape as unhandledRejection; saw: ${captured.map(String).join(", ")}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Zone 2 — boundary: config typo floor
// ---------------------------------------------------------------------------
describe("Fix 3 (Zone 2) — auditorTimeoutMs is floored to prevent instant-abort", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("behavioral: auditorTimeoutMs=1 does not schedule a ~1ms timer (floored)", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 1 }),
		);
		// Capture the ms passed to setTimeout. Without the floor, the prompt
		// timeout setTimeout is called with ~1ms; with the floor it is raised
		// to EFFECTIVE_TIMEOUT_FLOOR_MS (minus elapsed). Use an approving (fast)
		// session so the floored timer never actually fires — we only inspect
		// what was scheduled.
		const realSetTimeout = globalThis.setTimeout;
		const scheduledMs: number[] = [];
		globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
			if (typeof ms === "number") scheduledMs.push(ms);
			return realSetTimeout(fn, ms, ...rest);
		}) as any;
		try {
			await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "detailed",
				createSession: makeApprovingCreateSession(5),
			});
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		// The floor must prevent the typo value (1) from being used directly as
		// a timeout delay. After flooring, the prompt/createSession timers are
		// scheduled at ~FLOOR (minus a few ms of elapsed time). Assert that NO
		// scheduled timer is at the pathological typo value, and that at least
		// one timer was raised to a clearly-floored magnitude.
		const atTypo = scheduledMs.some((ms) => ms <= 1);
		assert.equal(
			atTypo,
			false,
			`Fix 3: with auditorTimeoutMs=1, no timer may be scheduled at the typo value (<=1ms); saw: ${JSON.stringify(scheduledMs)}`,
		);
		const flooredTimer = scheduledMs.some((ms) => ms >= 500);
		assert.ok(
			flooredTimer,
			`Fix 3: with auditorTimeoutMs=1, a floored timer (>=500ms) must be scheduled; saw: ${JSON.stringify(scheduledMs)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Zone 5 — state mutation: a second audit runs cleanly after a previous timeout
// ---------------------------------------------------------------------------
describe("Fix 1 (Zone 5) — second audit after a previous timeout (no leaked state)", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("behavioral: two sequential timeout audits each return a clean result, no leaked rejection", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);
		const captured: unknown[] = [];
		const tracker = (reason: unknown) => { captured.push(reason); };
		const cs = makeLateRejectingAbortCreateSession(20);
		await withIsolatedUnhandledRejection(tracker, async () => {
			const first = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "first",
				createSession: cs,
			});
			assert.equal(first.timedOut, true, "first audit must time out");
			// Second run must start cleanly: no leaked listeners or session
			// references from the first run poisoning it. If the first run's
			// abort() rejection had killed the process (the bug), this second
			// call would never execute.
			const second = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "second",
				createSession: cs,
			});
			assert.equal(second.timedOut, true, "second audit must also time out cleanly");
			assert.equal(second.approved, false);
			assert.match(second.error ?? "", /Auditor timeout after 50ms/);
			// Settle any trailing abort rejections before restoring listeners.
			await new Promise<void>((r) => setTimeout(r, 150));
		});
		const boomSeen = captured.some(
			(r) => r instanceof Error && r.message === "abort-rejection-boom",
		);
		assert.equal(
			boomSeen,
			false,
			"Fix 1: neither audit's abort() rejection may escape as unhandledRejection",
		);
	});
});
