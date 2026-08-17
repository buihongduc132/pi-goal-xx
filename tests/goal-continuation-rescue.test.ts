/**
 * RED phase — continuation idle-rescue tests.
 *
 * Spec: flow/intentions/2026-08-17_continuation-idle-rescue.md
 *
 * Root cause under test: sendQueuedContinuation's cooldown-drop path clears
 * the slot and returns WITHOUT rescheduling. Continuation is the only
 * turn-driver in auto-run → a cooldown drop permanently stalls the goal.
 *
 * Target behavior (all tests MUST FAIL before implementation):
 *
 *  Scheduling:
 *   1. reschedule-on-drop — cooldown drop re-arms the slot
 *      (continuationScheduledFor !== null, timer !== null), does NOT dead-end.
 *   2. activity-stamp — lastAgentActivity stamped on assistant message_end;
 *      armed fireAt = lastActivity + idleRescueMs when T1 is the nearer edge.
 *   3. fire-dispatch — T2 elapsed → send; T1 elapsed + idle + no pending →
 *      send (rescue); neither elapsed / conditions unmet → re-arm with
 *      recomputed fireAt.
 *   4. single-slot — exactly 1 armed continuation max; enqueue while slot
 *      occupied → dropped (existing guard retained).
 *
 *  Send invariants:
 *   5. one-stamp — BOTH T1 and T2 sends path through serializedSend and stamp
 *      lastContinuationSentAt/lastContinuationSentGoalId; next T2 eligibility
 *      = sentAt + minIntervalMs (nextAllowedAt).
 *   6. same-prompt — rescue send reuses continuationPrompt(goal, settings,
 *      cwd) unchanged (checkpoint marker + goalHash line).
 *   7. no-new-bypass — rescue path preserves upstream gates
 *      (isActionableContinuationGoal, D6 focus-lock chokepoint); no new
 *      force/bypass surface (tools/commands).
 *
 *  Cancellation:
 *   8. user-msg-cancel — inbound user message clears armed slot + timer AND
 *      performs resetContinuationThrottle("user_message").
 *   9. lifecycle-cancel — goal pause/abort(archive) clears armed slot+timer.
 *
 *  Config:
 *  10. config-schema — goalContinuation.idleRescueMs: non-negative int,
 *      default 30000, 0 disables T1; validated in asGoalContinuationBlock.
 *  11. config-env — PI_GOAL_CONTINUATION_IDLE_RESCUE_MS resolved with source
 *      ordering env > file > default.
 *
 *  Observability:
 *  12. trace-steps — auto_run.rescue_arm {fireAt, via} and
 *      auto_run.rescue_fire {via} emitted via logGoalTrace.
 *
 * Approach: load the real goal extension into the mock pi harness, drive the
 * public surface (/goals-set, turn_start/tool_call/turn_end/message_end
 * events), read the structured trace log at <cwd>/.pi/goals/goal-trace.jsonl
 * and the captured pi.sentMessages. Env overrides shrink the windows
 * (idleRescueMs / minIntervalMs) so tests run in <2s of wall clock.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
import { continuationPrompt } from "../extensions/prompts/goal-prompts.ts";
import {
	loadGoalSettings,
	parseGoalSettings,
	resolveContinuationGate,
} from "../extensions/goal-settings.ts";
import { lockPath } from "../extensions/goal-lock.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeCommand,
	cleanupTimers,
	flushContinuation,
	countContinuations,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

// ---------------------------------------------------------------------------
// Timing knobs (wall-clock, kept small via env overrides)
// ---------------------------------------------------------------------------

/** Long cooldown: any 2nd send attempt within the test lifetime is a drop. */
const LONG_MIN_INTERVAL_MS = 600_000;
/** Short idle rescue so the rescue timer fires within the test lifetime. */
const FAST_IDLE_RESCUE_MS = 250;
/** Short cooldown so the T2 edge (lastSend + minInterval) fires soon. */
const FAST_MIN_INTERVAL_MS = 1_000;
/** Wall-clock waits sized against the knobs above (with slack). */
const WAIT_RESCUE_MS = 900;
const WAIT_T2_MS = 1_600;

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;
let savedMinIntervalEnv: string | undefined;
let savedIdleRescueEnv: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-idle-rescue-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	savedMinIntervalEnv = process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	savedIdleRescueEnv = process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS;
	// Defaults per-test: long cooldown (forces the cooldown-drop path), fast
	// idle rescue (T1 fires quickly). Individual tests override as needed.
	process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = String(LONG_MIN_INTERVAL_MS);
	process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = String(FAST_IDLE_RESCUE_MS);
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch { /* best-effort */ }
	}
	pi = null;
	restoreGoalEnv(envSnap);
	if (savedMinIntervalEnv === undefined) delete process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	else process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = savedMinIntervalEnv;
	if (savedIdleRescueEnv === undefined) delete process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS;
	else process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = savedIdleRescueEnv;
	fs.rmSync(cwd, { recursive: true, force: true });
});

function freshPi(hasUI = true) {
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

// ---------------------------------------------------------------------------
// Trace-log helpers (pattern: tests/continuation-traces.test.ts)
// ---------------------------------------------------------------------------

interface TraceEntry {
	step: string;
	goalId?: string;
	[key: string]: unknown;
}

function readTraceEntries(): TraceEntry[] {
	const file = path.join(cwd, ".pi", "goals", "goal-trace.jsonl");
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
	const out: TraceEntry[] = [];
	for (const line of lines) {
		try { out.push(JSON.parse(line) as TraceEntry); } catch { /* skip malformed */ }
	}
	return out;
}

function entriesFor(step: string): TraceEntry[] {
	return readTraceEntries().filter((e) => e.step === step);
}

function rescueArmEntries(): TraceEntry[] {
	return entriesFor("auto_run.rescue_arm");
}

function rescueFireEntries(): TraceEntry[] {
	return entriesFor("auto_run.rescue_fire");
}

function sendSuccessEntries(): TraceEntry[] {
	return entriesFor("auto_run.send.success");
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

/** Create a goal via /goals-set and let the first continuation send (gate
 *  fires on lastSentAt=null). Returns after the send settles. */
async function createGoalAndFirstSend(
	p: ReturnType<typeof createMockPi>,
	ctx: any,
	objective: string,
): Promise<void> {
	await invokeCommand(p, ctx, "goals-set", objective);
	await flushContinuation(30);
}

/** Simulate one real work turn: turn_start → meaningful tool_call → assistant
 *  message_end (activity) → turn_end (non-toolUse assistant message) so
 *  queueContinuation runs. Must complete while the cooldown gate is still
 *  closed so sendQueuedContinuation takes the cooldown-drop path. */
async function driveWorkTurn(p: ReturnType<typeof createMockPi>, ctx: any): Promise<void> {
	await emit(p, ctx, "turn_start", {});
	await emit(p, ctx, "tool_call", { toolName: "write", args: { path: "out.txt", content: "x" } });
	await emit(p, ctx, "message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "step done" }], usage: {} },
	});
	await emit(p, ctx, "turn_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: "step done" }],
			stopReason: "endTurn",
			usage: {},
		},
	});
}

/** The single active goal id on disk. */
function soleGoalIdOnDisk(): string {
	const pool = readActiveGoalPool({ cwd });
	const ids = [...pool.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly 1 goal on disk, got ${ids.length}`);
	return ids[0]!;
}

/** Continuation messages captured from pi.sendMessage. */
function continuationMessages(p: ReturnType<typeof createMockPi>) {
	return p.sentMessages.filter((m) => m.customType === "pi-goal-event");
}

/**
 * Full arm sequence: goal created (send #1) → one work turn while cooldown
 * gate closed → cooldown drop → (target behavior) slot re-armed for rescue.
 * Sanity-checks that the drop path was actually taken.
 */
async function armRescueAfterCooldownDrop(
	p: ReturnType<typeof createMockPi>,
	ctx: any,
	objective: string,
): Promise<void> {
	await createGoalAndFirstSend(p, ctx, objective);
	assert.ok(countContinuations(p) >= 1, "sanity: first continuation sent");
	const beforeDrops = entriesFor("auto_run.cooldown_drop").length;
	await driveWorkTurn(p, ctx);
	await flushContinuation(50);
	const drops = entriesFor("auto_run.cooldown_drop");
	assert.ok(drops.length > beforeDrops, "sanity: cooldown-drop path was hit");
}

// ===========================================================================
// 1. Scheduling — reschedule-on-drop
// ===========================================================================

describe("scheduling: reschedule-on-drop", () => {
	it("cooldown drop keeps the continuation slot armed: rescue_arm trace emitted with fireAt and via", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: reschedule on drop. success criteria: done.");

		// Slot stays armed → an arm trace exists with a future fireAt.
		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, `expected auto_run.rescue_arm after cooldown drop; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);
		const arm = arms[0]!;
		assert.equal(typeof arm.fireAt, "number", "rescue_arm carries numeric fireAt");
		assert.ok((arm.fireAt as number) > 0, "fireAt is a real epoch-ms timestamp");
		assert.equal(typeof arm.via, "string", "rescue_arm carries string via");
		assert.ok(String(arm.via).length > 0, "via is non-empty");
	});

	it("cooldown drop does NOT dead-end: rescue fires and sends within idleRescueMs", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: rescue fires after drop. success criteria: done.");

		assert.equal(countContinuations(p), 1, "sanity: exactly 1 send so far");
		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(
			countContinuations(p),
			2,
			`continuation recovered after cooldown drop (expected send #2 within ${FAST_IDLE_RESCUE_MS}ms idle window); got ${countContinuations(p)}`,
		);
	});
});

// ===========================================================================
// 2. Scheduling — activity-stamp
// ===========================================================================

describe("scheduling: activity-stamp (lastAgentActivity)", () => {
	it("assistant message_end stamps lastAgentActivity; armed fireAt = lastActivity + idleRescueMs (T1 nearer than T2)", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFirstSend(p, ctx, "objective: activity stamp. success criteria: done.");

		const stampedAt = Date.now();
		await driveWorkTurn(p, ctx); // assistant message_end inside → activity stamp
		const stampedAtUpper = Date.now();
		await flushContinuation(50);

		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, `expected auto_run.rescue_arm after drop; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);
		const fireAt = arms[0]!.fireAt as number;

		// fireAt anchored to the assistant activity (T1), not the far T2 edge.
		assert.ok(
			fireAt >= stampedAt + FAST_IDLE_RESCUE_MS - 50,
			`fireAt ${fireAt} too early: must be >= lastActivity(${stampedAt}) + idleRescueMs(${FAST_IDLE_RESCUE_MS}) - 50ms skew`,
		);
		assert.ok(
			fireAt <= stampedAtUpper + FAST_IDLE_RESCUE_MS + 500,
			`fireAt ${fireAt} too late: must be <= lastActivity(${stampedAtUpper}) + idleRescueMs(${FAST_IDLE_RESCUE_MS}) + slack`,
		);
		assert.ok(
			fireAt < stampedAt + LONG_MIN_INTERVAL_MS,
			"fireAt is anchored to activity (T1), not lastSend + minIntervalMs (T2)",
		);
	});

	it("later assistant activity is honored: fireAt tracks the MOST RECENT assistant message_end", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFirstSend(p, ctx, "objective: latest activity wins. success criteria: done.");

		await driveWorkTurn(p, ctx);
		await flushContinuation(20);
		// A second, LATER activity burst — fireAt must be based on this one.
		const lateAt = Date.now();
		await emit(p, ctx, "message_end", {
			message: { role: "assistant", content: [{ type: "text", text: "more work" }], usage: {} },
		});
		const lateAtUpper = Date.now();
		await flushContinuation(50);

		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, "expected auto_run.rescue_arm entries");
		const fireAt = arms[arms.length - 1]!.fireAt as number;
		assert.ok(
			fireAt >= lateAt + FAST_IDLE_RESCUE_MS - 50,
			`fireAt ${fireAt} must be >= latest assistant activity(${lateAt}) + idleRescueMs - skew`,
		);
		assert.ok(
			fireAt <= lateAtUpper + FAST_IDLE_RESCUE_MS + 500,
			`fireAt ${fireAt} must be <= latest assistant activity(${lateAtUpper}) + idleRescueMs + slack`,
		);
	});
});

// ===========================================================================
// 3. Scheduling — fire-dispatch routing
// ===========================================================================

describe("scheduling: fire-dispatch routing", () => {
	it("T2 elapsed (now - lastSendAt >= minIntervalMs) → send", async () => {
		// T2 near, T1 far: fireAt = lastSend + minInterval; the fire routes via T2.
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = String(FAST_MIN_INTERVAL_MS);
		process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = String(LONG_MIN_INTERVAL_MS);
		const { pi: p, ctx } = freshPi();
		await createGoalAndFirstSend(p, ctx, "objective: t2 dispatch. success criteria: done.");

		const sends = sendSuccessEntries();
		assert.ok(sends.length >= 1, "sanity: first send traced");
		const firstSentAt = sends[0]!.sentAt as number;
		await driveWorkTurn(p, ctx); // within FAST_MIN_INTERVAL_MS → cooldown drop → arm
		await flushContinuation(50);

		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, "expected auto_run.rescue_arm (T2 edge)");
		const fireAt = arms[0]!.fireAt as number;
		assert.ok(
			fireAt >= firstSentAt + FAST_MIN_INTERVAL_MS - 50,
			`T2 fireAt ${fireAt} must be >= firstSentAt(${firstSentAt}) + minIntervalMs(${FAST_MIN_INTERVAL_MS}) - skew`,
		);

		await flushContinuation(WAIT_T2_MS);
		assert.equal(countContinuations(p), 2, "T2-elapsed fire dispatched a send");
		const fires = rescueFireEntries();
		assert.ok(fires.length >= 1, "auto_run.rescue_fire traced for the T2 send");
	});

	it("T1 elapsed (now - lastActivity >= idleRescueMs) AND idle AND no pending → send (rescue)", async () => {
		// Defaults: T1 near (250ms), T2 far (600s) → rescue via idle.
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: t1 dispatch. success criteria: done.");

		assert.equal(countContinuations(p), 1, "sanity: only first send so far");
		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(countContinuations(p), 2, "T1 idle-rescue fire dispatched a send despite active cooldown");
		assert.ok(rescueFireEntries().length >= 1, "auto_run.rescue_fire traced for the T1 rescue send");
	});

	it("neither T1 nor T2 elapsed → no send; slot stays armed with future fireAt", async () => {
		// Both edges far beyond the test lifetime.
		process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = String(LONG_MIN_INTERVAL_MS);
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: neither elapsed. success criteria: done.");

		assert.equal(countContinuations(p), 1, "sanity: only first send so far");
		await flushContinuation(500);
		assert.equal(countContinuations(p), 1, "no send while neither T1 nor T2 elapsed");

		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, "slot still armed (rescue_arm present)");
		const fireAt = arms[arms.length - 1]!.fireAt as number;
		assert.ok(fireAt > Date.now() - 1_000, `armed fireAt ${fireAt} is in the future relative to now ${Date.now()}`);
		assert.equal(rescueFireEntries().length, 0, "no rescue_fire while neither edge elapsed");
	});

	it("conditions unmet at fire (pending messages) → re-arm; send dispatches once conditions hold", async () => {
		// T1 fast. At the moment of the fire the session is NOT idle-safe
		// (pending messages) → no send → re-arm with recomputed fireAt. Once
		// pending clears, the next fire sends.
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: rearm when busy. success criteria: done.");
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue armed");

		const originalHasPending = (ctx as any).hasPendingMessages;
		(ctx as any).hasPendingMessages = () => true; // busy at fire time
		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(countContinuations(p), 1, "no send while pending messages block the fire");
		assert.equal(rescueFireEntries().length, 0, "no rescue_fire while blocked");

		(ctx as any).hasPendingMessages = originalHasPending; // conditions now hold
		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(
			countContinuations(p),
			2,
			"re-armed fire dispatched the send once idle + no pending held",
		);
		assert.ok(rescueFireEntries().length >= 1, "rescue_fire traced after the re-armed fire");
	});

	it("busy re-arm is cadence-bounded: T1 edge past + pending messages → ≤ 25 re-arms per 500ms (50ms floor, no setTimeout(0) spin)", async () => {
		// Verifier PROBE1 regression: armRescueTimer computed delay =
		// Math.max(0, fireAt - now); with the T1 edge already in the past and
		// the session busy, every fire re-armed at setTimeout(0) → ~590
		// arms/sec (lock read + trace append each). The delay must be floored
		// at CONTINUATION_IDLE_RETRY_MS (50ms) so sustained busy yields at most
		// ~20 arms/sec → ≤ 25 in a 500ms window (slack for scheduling).
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: bounded rearm. success criteria: done.");
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue armed");

		const originalHasPending = (ctx as any).hasPendingMessages;
		(ctx as any).hasPendingMessages = () => true; // busy at every fire
		const armsBefore = rescueArmEntries().length;
		await flushContinuation(500);
		const armsAfter = rescueArmEntries().length;
		(ctx as any).hasPendingMessages = originalHasPending;

		const reArms = armsAfter - armsBefore;
		assert.ok(
			reArms <= 25,
			`busy re-arm storm: ${reArms} rescue_arm entries in 500ms (expected ≤ 25 with the 50ms floor); pre-fix spin was ~295`,
		);
		assert.equal(countContinuations(p), 1, "no send leaked while busy");
	});
});

// ===========================================================================
// 4. Scheduling — single-slot queue
// ===========================================================================

describe("scheduling: single-slot queue (drop rest)", () => {
	it("enqueue while slot occupied → dropped: N rapid work turns yield exactly ONE rescue send", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: single slot. success criteria: done.");

		// Slot is armed. Two MORE work turns each call queueContinuation —
		// both must hit the occupied-slot guard and be dropped.
		await driveWorkTurn(p, ctx);
		await driveWorkTurn(p, ctx);
		await flushContinuation(WAIT_RESCUE_MS);

		assert.equal(
			countContinuations(p),
			2,
			`exactly one armed continuation fired (first send + one rescue); got ${countContinuations(p)}`,
		);
		// Exactly one fire for the whole burst.
		assert.ok(rescueFireEntries().length >= 1, "the single armed slot fired");
	});
});

// ===========================================================================
// 5. Send invariants — one-stamp (T1 and T2 through serializedSend)
// ===========================================================================

describe("send invariant: one-stamp via serializedSend", () => {
	it("rescue (T1) send stamps lastContinuationSentAt/GoalId: send #2 chains on send #1's sentAt", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: one stamp. success criteria: done.");
		const goalId = soleGoalIdOnDisk();

		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(countContinuations(p), 2, "rescue send happened");

		const sends = sendSuccessEntries();
		assert.equal(sends.length, 2, `exactly two auto_run.send.success entries; got ${sends.length}`);
		const [first, second] = sends as Array<Record<string, unknown>>;
		// Both sends went through the same stamped pipeline for the same goal.
		assert.equal(first.goalId, goalId, "send #1 carries goalId");
		assert.equal(second.goalId, goalId, "rescue send #2 carries goalId");
		// One-stamp: rescue send's lastSentAt == first send's sentAt (shared
		// lastContinuationSentAt state, stamped by BOTH paths).
		assert.equal(
			second.lastSentAt,
			first.sentAt,
			`rescue send chains on the previous stamp: lastSentAt(${second.lastSentAt}) === prior sentAt(${first.sentAt})`,
		);
	});

	it("after T1 fire, next T2 eligibility = rescue sentAt + minIntervalMs (nextAllowedAt)", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: t1 stamps cooldown. success criteria: done.");

		await flushContinuation(WAIT_RESCUE_MS);
		const sends = sendSuccessEntries();
		assert.equal(sends.length, 2, "first send + rescue send");
		const rescue = sends[1]!;
		assert.equal(typeof rescue.sentAt, "number", "rescue send.success carries sentAt");
		assert.equal(typeof rescue.minIntervalMs, "number", "rescue send.success carries minIntervalMs");
		assert.equal(
			rescue.nextAllowedAt,
			(rescue.sentAt as number) + (rescue.minIntervalMs as number),
			"next T2 eligibility = rescue sentAt + minIntervalMs (T1 send stamps the cooldown)",
		);
		assert.equal(
			rescue.minIntervalMs,
			LONG_MIN_INTERVAL_MS,
			"rescue send ran through the resolved gate (minIntervalMs present in the trace)",
		);
	});

	it("simultaneous T1+T2 eligibility fires exactly ONE send (no double-send): t2Elapsed checked first, single dispatchContinuationSend", async () => {
		// Both edges eligible at fire time (fast cooldown AND idle ≥ rescue):
		// the fire path must dispatch exactly one send, not one per edge.
		const { pi: p, ctx } = freshPi();
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = String(FAST_MIN_INTERVAL_MS);
		process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = String(FAST_IDLE_RESCUE_MS);
		await createGoalAndFirstSend(p, ctx, "objective: no double send. success criteria: done.");
		assert.equal(countContinuations(p), 1, "sanity: first send happened");

		await driveWorkTurn(p, ctx); // queue → cooldown drop (gate still closed)
		await flushContinuation(WAIT_T2_MS); // both edges elapse: cooldown 1s + idle 250ms

		const sends = sendSuccessEntries();
		const fires = rescueFireEntries();
		assert.equal(
			countContinuations(p),
			2,
			`exactly one send when both T1 and T2 edges are in play; got ${countContinuations(p)}`,
		);
		assert.equal(sends.length, 2, `exactly two send.success entries total (first + one edge fire); got ${sends.length}`);
		assert.ok(fires.length >= 1, "at least one rescue_fire dispatched");
		// Single dispatch regardless of which edge won the race: with
		// idleRescueMs=250 < minIntervalMs=1000, the T1 edge is nearer and may
		// legitimately fire first (T2 not yet elapsed at that moment). The
		// invariant is ONE send per fire — never one per edge.
		const firedVias = fires.map((f) => f.via).filter(Boolean);
		assert.ok(
			firedVias.every((v) => v === "T1" || v === "T2"),
			`fire via attribution is a single known edge; saw ${firedVias.join(",")}`,
		);
		assert.equal(new Set(firedVias).size, firedVias.length === 0 ? 0 : 1, "no mixed-edge multi-fire");
	});

	it("idleRescueMs=0 runtime: T1 disabled → pure cooldown behavior — arms via T2, fires at lastSend+minInterval, no rescue_fire via T1", async () => {
		// Plan tests-scheduling requires a RUNTIME test for idleRescueMs=0
		// (schema/gate tests alone insufficient): the armed timer must route
		// via T2 (cooldown edge) with fireAt = lastSendAt + minIntervalMs,
		// and the eventual send must be attributed via T2 — never T1.
		const { pi: p, ctx } = freshPi();
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = String(FAST_MIN_INTERVAL_MS);
		process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = "0"; // T1 off
		await createGoalAndFirstSend(p, ctx, "objective: t1 disabled. success criteria: done.");
		assert.equal(countContinuations(p), 1, "sanity: first send happened");

		await driveWorkTurn(p, ctx); // cooldown still closed (1s) → drop path
		await flushContinuation(80);

		const arms = rescueArmEntries();
		assert.ok(arms.length >= 1, "cooldown drop armed a rescue timer");
		const arm = arms[arms.length - 1]!;
		assert.equal(arm.via, "T2", `idleRescueMs=0 arms via T2 (cooldown edge); saw via=${arm.via}`);
		const lastSend = sendSuccessEntries()[0]!.sentAt as number;
		assert.ok(
			Math.abs((arm.fireAt as number) - (lastSend + FAST_MIN_INTERVAL_MS)) < 150,
			`fireAt ≈ lastSend+minInterval (${lastSend + FAST_MIN_INTERVAL_MS}); got ${arm.fireAt}`,
		);

		await flushContinuation(WAIT_T2_MS); // cooldown elapses
		assert.equal(countContinuations(p), 2, "T2 fire sent the queued continuation");
		const fires = rescueFireEntries();
		assert.ok(fires.length >= 1, "rescue_fire traced");
		const vias = fires.map((f) => f.via);
		assert.ok(vias.every((v) => v !== "T1"), `no T1 fire when idleRescueMs=0; saw ${vias.join(",")}`);
		assert.ok(vias.includes("T2"), "fire attributed via T2");
	});
});

// ===========================================================================
// 6. Send invariants — same-prompt
// ===========================================================================

describe("send invariant: same-prompt (rescue reuses continuationPrompt)", () => {
	it("rescue send content === continuationPrompt(goal, settings, cwd) with goalHash line", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: same prompt. success criteria: done.");

		await flushContinuation(WAIT_RESCUE_MS);
		const msgs = continuationMessages(p);
		assert.equal(msgs.length, 2, "first send + rescue send");
		const rescueMsg = msgs[1]!;

		const goalId = soleGoalIdOnDisk();
		const pool = readActiveGoalPool({ cwd });
		const goal = pool.get(goalId);
		assert.ok(goal, "goal record readable from disk");
		const settings = loadGoalSettings(cwd);
		const expected = continuationPrompt(goal, settings, cwd);

		assert.equal(
			typeof rescueMsg.content === "string" ? rescueMsg.content : JSON.stringify(rescueMsg.content),
			expected,
			"rescue send reuses continuationPrompt(goal, settings, cwd) unchanged",
		);
		// Same-prompt essentials: checkpoint envelope + goalHash line.
		assert.ok(String(rescueMsg.content).includes("[GOAL CHECKPOINT"), "rescue prompt carries the checkpoint marker");
		assert.ok(/goalHash:/.test(String(rescueMsg.content)), "rescue prompt carries the goalHash line");
	});
});

// ===========================================================================
// 7. Send invariants — no-new-bypass
// ===========================================================================

describe("send invariant: no-new-bypass (upstream gates preserved)", () => {
	it("no new force/bypass surface: no rescue/force continuation tools or commands registered", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: no bypass surface. success criteria: done.");

		// Guard (stays green across GREEN): no tool/command exposes a
		// force/rescue continuation bypass.
		const surface = [...p.tools.keys(), ...p.commands.keys()];
		const bypass = surface.filter((name) => /rescue|force[._-]?continu|continu[._-]?force/i.test(name));
		assert.deepEqual(bypass, [], "no tool/command exposes a continuation force/rescue bypass");

		// RED-discriminating assertion: the rescue path itself must be armed
		// and fire through the EXISTING gated pipeline (send.success trace
		// with the gate fields — not a bare sendMessage side-channel).
		await flushContinuation(WAIT_RESCUE_MS);
		assert.equal(countContinuations(p), 2, "rescue fired");
		const rescueTrace = sendSuccessEntries()[1];
		assert.ok(rescueTrace, "rescue send traced through auto_run.send.success (gated pipeline)");
		assert.equal(rescueTrace.goalId, soleGoalIdOnDisk(), "rescue send carries the focused goalId");
	});

	it("rescue respects isActionableContinuationGoal: after goal replacement, no continuation for the OLD goal id", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective one: replaced goal. success criteria: done.");
		const oldGoalId = soleGoalIdOnDisk();
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue armed for the old goal");

		// Replace the goal → focus change clears the armed slot (setGoal →
		// clearContinuationState). The old goal's rescue must never fire.
		await invokeCommand(p, ctx, "goals-set", "objective two: fresh goal. success criteria: done.");
		await flushContinuation(WAIT_RESCUE_MS);

		const sendsForOldGoal = continuationMessages(p).filter(
			(m) => (m.details as any)?.goalId === oldGoalId,
		);
		assert.equal(
			sendsForOldGoal.length,
			1,
			"only the pre-replacement send exists for the old goal — its armed rescue was cancelled, not bypassed",
		);
	});
});

// ===========================================================================
// 8. Cancellation — user message
// ===========================================================================

describe("cancellation: inbound user message", () => {
	it("user message clears armed slot + timer AND resets the throttle (reason user_message)", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: user msg cancel. success criteria: done.");
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue was armed");

		await emit(p, ctx, "message_end", { message: { role: "user", content: "human says hi" } });
		await flushContinuation(WAIT_RESCUE_MS);

		// Armed slot + timer cleared → no fire, no send, despite the rescue
		// window elapsing while idle.
		assert.equal(countContinuations(p), 1, "armed rescue cancelled by inbound user message");
		assert.equal(rescueFireEntries().length, 0, "no rescue_fire after user-message cancel");

		// Existing resetContinuationThrottle("user_message") still performed.
		const resets = entriesFor("auto_run.throttle.reset");
		assert.ok(
			resets.some((e) => e.reason === "user_message"),
			`throttle reset with reason=user_message; reasons seen: ${resets.map((e) => String(e.reason)).join(", ") || "(none)"}`,
		);
	});
});

// ===========================================================================
// 9. Cancellation — lifecycle (pause / abort-archive)
// ===========================================================================

describe("cancellation: goal lifecycle", () => {
	it("/goal-pause clears the armed slot + timer (no rescue fire)", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: pause cancels. success criteria: done.");
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue was armed");

		await invokeCommand(p, ctx, "goal-pause", "");
		await flushContinuation(WAIT_RESCUE_MS);

		assert.equal(countContinuations(p), 1, "paused goal's armed rescue never fired");
		assert.equal(rescueFireEntries().length, 0, "no rescue_fire after pause");
	});

	it("/goal-abort clears the armed slot + timer and archives (no rescue fire)", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: abort cancels. success criteria: done.");
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue was armed");

		await invokeCommand(p, ctx, "goal-abort", "");
		await flushContinuation(WAIT_RESCUE_MS);

		assert.equal(countContinuations(p), 1, "aborted/archived goal's armed rescue never fired");
		assert.equal(rescueFireEntries().length, 0, "no rescue_fire after abort");
	});

	it("focus-lock loss invalidates the armed rescue: no send when the lock file is gone at fire time", async () => {
		// D6 chokepoint preservation: the armed slot must not outlive the
		// session's hold on the focus lock. Simulate lease loss by deleting
		// the lock file after arming; the fire must not produce a send.
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: lock loss cancels. success criteria: done.");
		const goalId = soleGoalIdOnDisk();
		assert.ok(rescueArmEntries().length >= 1, "sanity: rescue was armed");

		fs.rmSync(lockPath(cwd, goalId), { force: true }); // lease lost
		await flushContinuation(WAIT_RESCUE_MS);

		assert.equal(countContinuations(p), 1, "no rescue send after focus-lock loss");
	});
});

// ===========================================================================
// 10. Config — schema
// ===========================================================================

describe("config: goalContinuation.idleRescueMs schema", () => {
	it("parseGoalSettings accepts { goalContinuation: { idleRescueMs: 45000 } }", () => {
		const s = parseGoalSettings({ goalContinuation: { idleRescueMs: 45000 } });
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 45000);
	});

	it("parseGoalSettings accepts idleRescueMs: 0 (T1 rescue disabled)", () => {
		const s = parseGoalSettings({ goalContinuation: { idleRescueMs: 0 } });
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 0);
	});

	it("asGoalContinuationBlock rejects negative idleRescueMs", () => {
		assert.throws(() => parseGoalSettings({ goalContinuation: { idleRescueMs: -1 } }), /idleRescueMs|goalContinuation/i);
	});

	it("asGoalContinuationBlock rejects non-integer idleRescueMs", () => {
		assert.throws(() => parseGoalSettings({ goalContinuation: { idleRescueMs: 1.5 } }));
	});

	it("parseGoalSettings accepts minIntervalMs and idleRescueMs together", () => {
		const s = parseGoalSettings({ goalContinuation: { minIntervalMs: 600000, idleRescueMs: 30000 } });
		assert.strictEqual(s.goalContinuation?.minIntervalMs, 600000);
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 30000);
	});

	it("resolveContinuationGate defaults idleRescueMs to 30000 when unconfigured", () => {
		const gate = resolveContinuationGate(parseGoalSettings({}));
		assert.strictEqual(gate.idleRescueMs, 30000, "default idleRescueMs = 30000 (30s)");
	});

	it("resolveContinuationGate surfaces file-configured idleRescueMs", () => {
		const gate = resolveContinuationGate(parseGoalSettings({ goalContinuation: { idleRescueMs: 12345 } }));
		assert.strictEqual(gate.idleRescueMs, 12345);
	});

	it("idleRescueMs: 0 flows through resolveContinuationGate (T1 disabled, T2 still active)", () => {
		const gate = resolveContinuationGate(parseGoalSettings({ goalContinuation: { idleRescueMs: 0, minIntervalMs: 600000 } }));
		assert.strictEqual(gate.idleRescueMs, 0);
		assert.strictEqual(gate.minIntervalMs, 600000);
	});
});

// ===========================================================================
// 11. Config — env override
// ===========================================================================

describe("config: PI_GOAL_CONTINUATION_IDLE_RESCUE_MS env override", () => {
	const BASE_ENV: Record<string, string> = { PI_CODING_AGENT_DIR: "/tmp/pgxx-idle-rescue-env" };

	it("loadGoalSettings default idleRescueMs is 30000", () => {
		const s = loadGoalSettings("/tmp/pgxx-idle-rescue-cwd", { ...BASE_ENV });
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 30000);
	});

	it("env PI_GOAL_CONTINUATION_IDLE_RESCUE_MS=1000 overrides the default", () => {
		const s = loadGoalSettings("/tmp/pgxx-idle-rescue-cwd", {
			...BASE_ENV,
			PI_GOAL_CONTINUATION_IDLE_RESCUE_MS: "1000",
		});
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 1000);
	});

	it("env PI_GOAL_CONTINUATION_IDLE_RESCUE_MS beats the file value (env > file > default)", () => {
		const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-idle-rescue-file-"));
		try {
			fs.mkdirSync(path.join(fileDir, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(fileDir, ".pi", "pi-goal-xx-settings.json"),
				JSON.stringify({ goalContinuation: { idleRescueMs: 4444 } }),
			);
			const s = loadGoalSettings(fileDir, {
				...BASE_ENV,
				PI_GOAL_CONTINUATION_IDLE_RESCUE_MS: "1000",
			});
			assert.strictEqual(s.goalContinuation?.idleRescueMs, 1000, "env wins over file");
		} finally {
			fs.rmSync(fileDir, { recursive: true, force: true });
		}
	});

	it("file value beats the default when env is unset (file > default)", () => {
		const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-idle-rescue-file2-"));
		try {
			fs.mkdirSync(path.join(fileDir, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(fileDir, ".pi", "pi-goal-xx-settings.json"),
				JSON.stringify({ goalContinuation: { idleRescueMs: 4444 } }),
			);
			const s = loadGoalSettings(fileDir, { ...BASE_ENV });
			assert.strictEqual(s.goalContinuation?.idleRescueMs, 4444, "file wins over default");
		} finally {
			fs.rmSync(fileDir, { recursive: true, force: true });
		}
	});

	it("env PI_GOAL_CONTINUATION_IDLE_RESCUE_MS=0 disables the T1 rescue", () => {
		const s = loadGoalSettings("/tmp/pgxx-idle-rescue-cwd", {
			...BASE_ENV,
			PI_GOAL_CONTINUATION_IDLE_RESCUE_MS: "0",
		});
		assert.strictEqual(s.goalContinuation?.idleRescueMs, 0);
	});

	it("resolveContinuationGate honors the live env override (source ordering env first)", () => {
		process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = "7777";
		try {
			const gate = resolveContinuationGate(parseGoalSettings({ goalContinuation: { idleRescueMs: 4444 } }), cwd);
			assert.strictEqual(gate.idleRescueMs, 7777, "env > file > default at gate resolution");
		} finally {
			if (savedIdleRescueEnv === undefined) delete process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS;
			else process.env.PI_GOAL_CONTINUATION_IDLE_RESCUE_MS = savedIdleRescueEnv;
		}
	});
});

// ===========================================================================
// 12. Observability — trace steps
// ===========================================================================

describe("observability: rescue trace steps", () => {
	it("auto_run.rescue_arm emitted via logGoalTrace with fields fireAt and via", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: trace arm. success criteria: done.");
		const goalId = soleGoalIdOnDisk();

		const arms = rescueArmEntries();
		assert.ok(
			arms.length >= 1,
			`auto_run.rescue_arm present in goal-trace.jsonl; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`,
		);
		const arm = arms[0]!;
		assert.equal(typeof arm.fireAt, "number", "rescue_arm.fireAt is numeric (epoch ms)");
		assert.ok((arm.fireAt as number) > 0, "rescue_arm.fireAt is a positive timestamp");
		assert.equal(typeof arm.via, "string", "rescue_arm.via is a string");
		assert.ok(String(arm.via).length > 0, "rescue_arm.via non-empty");
		assert.equal(arm.goalId, goalId, "rescue_arm carries the goalId");
	});

	it("auto_run.rescue_fire emitted via logGoalTrace with field via", async () => {
		const { pi: p, ctx } = freshPi();
		await armRescueAfterCooldownDrop(p, ctx, "objective: trace fire. success criteria: done.");

		await flushContinuation(WAIT_RESCUE_MS);
		const fires = rescueFireEntries();
		assert.ok(
			fires.length >= 1,
			`auto_run.rescue_fire present after the rescue send; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`,
		);
		const fire = fires[0]!;
		assert.equal(typeof fire.via, "string", "rescue_fire.via is a string");
		assert.ok(String(fire.via).length > 0, "rescue_fire.via non-empty");
		assert.equal(fire.goalId, soleGoalIdOnDisk(), "rescue_fire carries the goalId");
	});
});
