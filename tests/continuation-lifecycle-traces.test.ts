/**
 * RED phase — continuation lifecycle trace tests (FULL lifecycle).
 *
 * Contract under test: every step of the continuation (auto-run) lifecycle is
 * logged to <cwd>/.pi/goals/goal-trace.jsonl via logGoalTrace with full
 * context, so a troubleshooting session can explain every event from logs
 * alone. Trace points:
 *
 *   queueContinuation entry / early returns:
 *     - auto_run.queue          { goalId, reason: turn_end|force_path|resume }
 *     - auto_run.queue.skip     { reason: not_active|no_auto_continue|
 *                                 confirmation_intent|tweak_drafting|
 *                                 already_queued }
 *     - auto_run.blocked        (lock not held by self — already exists, verify)
 *
 *   sendQueuedContinuation entry / early returns / success:
 *     - auto_run.send.start     { goalId, lastSentAt, goalIdMatch, minIntervalMs }
 *     - auto_run.send.skip      { reason: not_actionable|no_goal }
 *     - auto_run.send.retry     { delayMs }
 *     - auto_run.cooldown_drop  (already exists, verify)
 *     - auto_run.send.success   { goalId, lastSentAt (pre-update), sentAt,
 *                                 nextAllowedAt = sentAt + minIntervalMs,
 *                                 minIntervalMs, source: file|env|default }
 *                                 (implemented in b5126ec — kept as regression)
 *
 *   resetContinuationThrottle:
 *     - auto_run.throttle.reset { reason: goal_created|goal_resumed|
 *                                 user_message|session_compact|auditor_rejection,
 *                                 previousLastSentAt, previousGoalId }
 *                                 (implemented in b5126ec — kept as regression)
 *
 *   resolveContinuationGate:
 *     - auto_run.gate.resolve   { minIntervalMs, source: file|env|default }
 *                                 (implemented in b5126ec — kept as regression)
 *
 * The still-unimplemented points (queue reason field, all queue.skip variants,
 * send.start, send.retry, send.skip) MUST fail now (RED).
 *
 * Approach: load the real goal extension into the mock pi harness, drive the
 * public surface (session_start event, /goals-set, /goal-pause, /goal-clear,
 * /goals, /goal-tweak, turn_start/tool_call/turn_end, agent_end,
 * session_compact, message_end), then parse goal-trace.jsonl and assert steps
 * + fields.
 *
 * Test-hygiene notes (hard-won):
 *  - goal.ts keeps `confirmationIntent` / `tweakDraftingFor` at MODULE level:
 *    they leak across freshPi() loads in one process. afterEach invokes
 *    /goal-abort to clear both (it cancels any in-progress drafting).
 *  - `syncActiveGoalEnv` sets PI_GOAL_XX_ACTIVE in process.env; scrubbed in
 *    beforeEach/afterEach (same pattern as goal-active-env-focus.test.ts).
 *  - After a successful send, `continuationQueuedFor` stays set, so
 *    turn_end/session_compact queue attempts return at the already-queued
 *    guard. `agent_end` is the reliable re-queue trigger (it nulls
 *    continuationQueuedFor before queueing).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
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
	writeGoalFile,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;
let savedContEnv: string | undefined;
let savedAgentDir: string | undefined;
let savedActiveEnv: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cont-life-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	// PI_GOAL_XX_ACTIVE leaks across tests (set by syncActiveGoalEnv) and would
	// hijack focus resolution in later tests — scrub it.
	savedActiveEnv = process.env.PI_GOAL_XX_ACTIVE;
	delete process.env.PI_GOAL_XX_ACTIVE;
	// Isolate the continuation gate config: no env override, and redirect the
	// global settings file path away from the host's ~/.pi/pi-goal-xx-settings.json
	// so "source=default" tests are deterministic on any machine.
	savedContEnv = process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	delete process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "agent");
});

afterEach(async () => {
	if (pi) {
		// goal.ts keeps confirmationIntent/tweakDraftingFor at MODULE level —
		// they survive freshPi() loads. /goal-abort clears both (drafting
		// cancel branch) so later tests start clean.
		try {
			const cleanupCtx = createMockCtx(pi, { cwd, sessionManager: { getBranch: () => [] as any[] } as any });
			await invokeCommand(pi, cleanupCtx, "goal-abort", "");
		} catch {}
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	if (savedContEnv === undefined) delete process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	else process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = savedContEnv;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedActiveEnv === undefined) delete process.env.PI_GOAL_XX_ACTIVE;
	else process.env.PI_GOAL_XX_ACTIVE = savedActiveEnv;
	fs.rmSync(cwd, { recursive: true, force: true });
});

/** Load the extension into a fresh mock pi. idle=false keeps queued
 *  continuations in the retry-timer state (send does not complete). */
function freshPi(idle = true) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: true,
		idle,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

interface TraceEntry {
	step: string;
	goalId?: string;
	[key: string]: unknown;
}

/** Parse every entry of the goal trace log (goal-trace.jsonl) under cwd. */
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

/** Entries whose step matches exactly. */
function entriesFor(step: string): TraceEntry[] {
	return readTraceEntries().filter((e) => e.step === step);
}

/** Human-readable step list for failure messages. */
function stepsSeen(): string {
	return readTraceEntries().map((e) => e.step).join(", ") || "(none)";
}

/** Create a goal via /goals-set and let the queued continuation fire once. */
async function createGoalAndFlush(
	piLocal: ReturnType<typeof createMockPi>,
	ctx: any,
	objective: string,
): Promise<string> {
	await invokeCommand(piLocal, ctx, "goals-set", objective);
	await flushContinuation(50);
	const pool = readActiveGoalPool({ cwd });
	const ids = [...pool.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly 1 goal on disk, got ${ids.length}`);
	return ids[0]!;
}

/** Drive one full turn: turn_start + meaningful tool_call + turn_end. */
async function completeTurn(
	piLocal: ReturnType<typeof createMockPi>,
	ctx: any,
): Promise<void> {
	await emit(piLocal, ctx, "turn_start", {});
	await emit(piLocal, ctx, "tool_call", { toolName: "edit", args: { path: "src/x.ts" } });
	await emit(piLocal, ctx, "turn_end", {
		message: { role: "assistant", content: [{ type: "text", text: "work done" }] },
	});
}

// ---------------------------------------------------------------------------
// 1. queueContinuation entry — step `auto_run.queue` with goalId + reason
// ---------------------------------------------------------------------------

describe("trace: queueContinuation entry (auto_run.queue)", () => {
	it("session_start resume queues with step auto_run.queue, goalId and reason=resume", async () => {
		writeGoalFile(cwd, { id: "resume-q", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(50);

		assert.ok(countContinuations(p) >= 1, "sanity: continuation actually fired");
		const entries = entriesFor("auto_run.queue");
		assert.ok(entries.length >= 1, `expected auto_run.queue entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.goalId, "resume-q", "auto_run.queue carries the focused goalId");
		assert.equal(e.reason, "resume", "auto_run.queue carries reason=resume for session_start");
	});

	it("turn_end queues with step auto_run.queue and reason=turn_end", async () => {
		writeGoalFile(cwd, { id: "turn-end-q", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(50); // first send fires (no cooldown for first send)

		await completeTurn(p, ctx);
		await flushContinuation(50);

		const entries = entriesFor("auto_run.queue");
		assert.ok(entries.length >= 1, `expected auto_run.queue entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "turn_end" && e.goalId === "turn-end-q"),
			`expected auto_run.queue with reason=turn_end; got: ${JSON.stringify(entries.map(({ goalId, reason }) => ({ goalId, reason })))}`,
		);
	});

	it("goals-set (force path) queues with step auto_run.queue and reason=force_path", async () => {
		const { pi: p, ctx } = freshPi();
		await invokeCommand(p, ctx, "goals-set", "objective: force path queue trace. success criteria: done.");
		await flushContinuation(50);

		assert.ok(countContinuations(p) >= 1, "sanity: continuation actually fired");
		const entries = entriesFor("auto_run.queue");
		assert.ok(entries.length >= 1, `expected auto_run.queue entry; steps seen: ${stepsSeen()}`);
		assert.equal(entries[0]!.reason, "force_path", "auto_run.queue carries reason=force_path for /goals-set");
	});
});

// ---------------------------------------------------------------------------
// 2. queueContinuation early returns — step `auto_run.queue.skip`
// ---------------------------------------------------------------------------

describe("trace: queueContinuation early returns (auto_run.queue.skip)", () => {
	it("no focused goal → skip with reason=not_active", async () => {
		const { pi: p, ctx } = freshPi();
		// No goal on disk: session_start tail still invokes queueContinuation.
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		const entries = entriesFor("auto_run.queue.skip");
		assert.ok(entries.length >= 1, `expected auto_run.queue.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "not_active"),
			`expected skip reason=not_active; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("goal without autoContinue → skip with reason=no_auto_continue", async () => {
		writeGoalFile(cwd, { id: "no-auto-cont", autoContinue: false });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		assert.equal(countContinuations(p), 0, "sanity: no continuation fired");
		const entries = entriesFor("auto_run.queue.skip");
		assert.ok(entries.length >= 1, `expected auto_run.queue.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "no_auto_continue"),
			`expected skip reason=no_auto_continue; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("confirmation intent active (/goals topic) → skip with reason=confirmation_intent", async () => {
		writeGoalFile(cwd, { id: "intent-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		// /goals <topic> sets the in-memory (module-level) confirmation intent.
		await invokeCommand(p, ctx, "goals", "research the caching layer redesign");
		// A later queue trigger (e.g. re-attached session) must log the skip.
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		const entries = entriesFor("auto_run.queue.skip");
		assert.ok(entries.length >= 1, `expected auto_run.queue.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "confirmation_intent"),
			`expected skip reason=confirmation_intent; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("tweak drafting active (/goal-tweak) → skip with reason=tweak_drafting", async () => {
		writeGoalFile(cwd, { id: "tweak-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		await invokeCommand(p, ctx, "goal-tweak", "tighten the done criteria");
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		const entries = entriesFor("auto_run.queue.skip");
		assert.ok(entries.length >= 1, `expected auto_run.queue.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "tweak_drafting"),
			`expected skip reason=tweak_drafting; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("already queued/scheduled → skip with reason=already_queued", async () => {
		writeGoalFile(cwd, { id: "dup-q", autoContinue: true });
		// idle=false keeps the first queue in the retry-timer state (scheduled).
		const { pi: p, ctx } = freshPi(false);
		await emit(p, ctx, "session_start", { reason: "resume" });

		// Second queue trigger while the first is still scheduled.
		await emit(p, ctx, "session_compact", {});
		await flushContinuation(25);

		const entries = entriesFor("auto_run.queue.skip");
		assert.ok(entries.length >= 1, `expected auto_run.queue.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "already_queued" && e.goalId === "dup-q"),
			`expected skip reason=already_queued; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("lock not held by self → auto_run.blocked is logged (existing behavior, verify)", async () => {
		writeGoalFile(cwd, { id: "lockless-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(25);

		// Steal the lock away (other session took over / lease reaped).
		fs.rmSync(lockPath(cwd, "lockless-g"), { force: true });

		await completeTurn(p, ctx);
		await flushContinuation(25);

		const entries = entriesFor("auto_run.blocked");
		assert.ok(entries.length >= 1, `expected auto_run.blocked entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.goalId === "lockless-g"),
			"auto_run.blocked carries the focused goalId",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. sendQueuedContinuation entry — step `auto_run.send.start`
// ---------------------------------------------------------------------------

describe("trace: sendQueuedContinuation entry (auto_run.send.start)", () => {
	it("logs step auto_run.send.start with goalId, lastSentAt, goalIdMatch and minIntervalMs", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: send start trace. success criteria: done.");

		assert.ok(countContinuations(p) >= 1, "sanity: continuation actually fired");
		const entries = entriesFor("auto_run.send.start");
		assert.ok(entries.length >= 1, `expected auto_run.send.start entry; steps seen: ${stepsSeen()}`);

		const e = entries[0]!;
		const goalId = [...readActiveGoalPool({ cwd }).keys()][0]!;
		assert.equal(e.goalId, goalId, "send.start carries the goalId");
		assert.ok("lastSentAt" in e, "send.start carries lastSentAt");
		assert.equal(e.lastSentAt, null, "first send has lastSentAt=null");
		assert.equal(typeof e.goalIdMatch, "boolean", "send.start carries boolean goalIdMatch");
		assert.equal(e.goalIdMatch, true, "first send for this goal has goalIdMatch=true");
		assert.equal(typeof e.minIntervalMs, "number", "send.start carries numeric minIntervalMs");
	});
});

// ---------------------------------------------------------------------------
// 4. sendQueuedContinuation early returns — send.retry / send.skip
// ---------------------------------------------------------------------------

describe("trace: sendQueuedContinuation early returns (auto_run.send.retry / auto_run.send.skip)", () => {
	it("ctx not idle → logs step auto_run.send.retry with delayMs", async () => {
		writeGoalFile(cwd, { id: "busy-g", autoContinue: true });
		const { pi: p, ctx } = freshPi(false); // ctx.isIdle() === false
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(150); // retry timer (50ms) fires while not idle

		const entries = entriesFor("auto_run.send.retry");
		assert.ok(entries.length >= 1, `expected auto_run.send.retry entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.goalId, "busy-g", "send.retry carries the goalId");
		assert.equal(e.delayMs, 50, "send.retry carries delayMs (CONTINUATION_IDLE_RETRY_MS)");
	});

	it("goal paused while continuation armed → B3: paused goal is still actionable (no not_actionable skip, retry continues)", async () => {
		writeGoalFile(cwd, { id: "pause-g", autoContinue: true });
		const { pi: p, ctx } = freshPi(false); // keep the send in retry state
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(60); // one retry armed, goal still active

		await invokeCommand(p, ctx, "goal-pause", "");
		await flushContinuation(150);

		// B3 (main, f3517e1): staleness is an IDENTITY question only. A queued
		// checkpoint for the focused goal is actionable regardless of transient
		// status drift (pause races). The send must NOT be skipped with
		// not_actionable; the retry loop continues until the session is idle.
		const skips = entriesFor("auto_run.send.skip");
		assert.ok(
			!skips.some((e) => e.reason === "not_actionable"),
			`B3: paused goal must not produce not_actionable skip; got: ${JSON.stringify(skips.map((e) => e.reason))}`,
		);
		const retries = entriesFor("auto_run.send.retry");
		assert.ok(retries.length >= 2, `B3: retry loop must continue after pause; retries seen: ${retries.length}`);
	});

	it("goal cleared while continuation armed → send fires and logs skip reason=no_goal", async () => {
		writeGoalFile(cwd, { id: "clear-g", autoContinue: true });
		const { pi: p, ctx } = freshPi(false);
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(60);

		await invokeCommand(p, ctx, "goal-clear", "");
		await flushContinuation(150);

		const entries = entriesFor("auto_run.send.skip");
		assert.ok(entries.length >= 1, `expected auto_run.send.skip entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "no_goal"),
			`expected skip reason=no_goal; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("second send within cooldown → auto_run.cooldown_drop is logged (existing behavior, verify)", async () => {
		writeGoalFile(cwd, { id: "cool-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(50); // send #1 → lastSentAt set (default cooldown 600000ms)

		// agent_end is the reliable re-queue trigger: it nulls
		// continuationQueuedFor (left set by send #1) before queueing.
		await emit(p, ctx, "agent_end", { messages: [] });
		await flushContinuation(50);

		assert.equal(countContinuations(p), 1, "sanity: second send dropped by cooldown");
		const entries = entriesFor("auto_run.cooldown_drop");
		assert.ok(entries.length >= 1, `expected auto_run.cooldown_drop entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.goalId === "cool-g"),
			"cooldown_drop carries the goalId",
		);
	});
});

// ---------------------------------------------------------------------------
// 5. sendQueuedContinuation SUCCESS — step `auto_run.send.success`
//    (implemented in b5126ec — regression coverage with full field contract)
// ---------------------------------------------------------------------------

describe("trace: sendQueuedContinuation success (auto_run.send.success)", () => {
	it("first send (lastSentAt=null): logs full context with nextAllowedAt = sentAt + minIntervalMs, source=default", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: send success trace. success criteria: done.");

		assert.ok(countContinuations(p) >= 1, "sanity: continuation actually fired");
		const entries = entriesFor("auto_run.send.success");
		assert.ok(entries.length >= 1, `expected auto_run.send.success entry; steps seen: ${stepsSeen()}`);

		const e = entries[0]!;
		const goalId = [...readActiveGoalPool({ cwd }).keys()][0]!;
		assert.equal(e.goalId, goalId, "send.success carries the goalId");
		assert.equal(e.lastSentAt, null, "first send logs lastSentAt=null (pre-update value)");
		const sentAt = e.sentAt as unknown;
		assert.equal(typeof sentAt, "number", "send.success carries numeric sentAt");
		assert.ok(Math.abs((sentAt as number) - Date.now()) < 10_000, "sentAt is a current epoch-ms timestamp");
		assert.equal(e.minIntervalMs, 600_000, "default minIntervalMs is 600000 (10 minutes)");
		assert.equal(e.source, "default", "unconfigured gate resolves with source=default");
		assert.equal(
			e.nextAllowedAt,
			(sentAt as number) + 600_000,
			"nextAllowedAt = sentAt + minIntervalMs (edge: first send)",
		);
	});

	it("env override: send.success carries source=env and the env-overridden minIntervalMs", async () => {
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = "1500";
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: env gate trace. success criteria: done.");

		const entries = entriesFor("auto_run.send.success");
		assert.ok(entries.length >= 1, `expected auto_run.send.success entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.source, "env", "env override beats file/default → source=env");
		assert.equal(e.minIntervalMs, 1500, "env-overridden minIntervalMs is logged");
		assert.equal(e.nextAllowedAt, (e.sentAt as number) + 1500, "nextAllowedAt = sentAt + env minIntervalMs");
	});

	it("file config: send.success carries source=file and the file minIntervalMs", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalContinuation: { minIntervalMs: 4242 } }),
		);
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: file gate trace. success criteria: done.");

		const entries = entriesFor("auto_run.send.success");
		assert.ok(entries.length >= 1, `expected auto_run.send.success entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.source, "file", "file config beats default → source=file");
		assert.equal(e.minIntervalMs, 4242, "file-configured minIntervalMs is logged");
	});
});

// ---------------------------------------------------------------------------
// 6. resetContinuationThrottle — step `auto_run.throttle.reset`
//    (implemented in b5126ec — regression coverage with full field contract)
// ---------------------------------------------------------------------------

describe("trace: resetContinuationThrottle (auto_run.throttle.reset)", () => {
	it("goal creation logs reset with reason=goal_created and previous-state fields", async () => {
		const { pi: p, ctx } = freshPi();
		await invokeCommand(p, ctx, "goals-set", "objective: reset-on-create trace. success criteria: done.");
		await flushContinuation(50);

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, `expected auto_run.throttle.reset entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.reason, "goal_created", "reset on /goals-set carries reason=goal_created");
		assert.ok("previousLastSentAt" in e, "throttle.reset carries previousLastSentAt");
		assert.ok("previousGoalId" in e, "throttle.reset carries previousGoalId");
	});

	it("inbound user message after a send logs reset with reason=user_message and the previous send's context", async () => {
		const { pi: p, ctx } = freshPi();
		const goalId = await createGoalAndFlush(p, ctx, "objective: reset-on-user-msg trace. success criteria: done.");

		const success = entriesFor("auto_run.send.success");
		assert.ok(success.length >= 1, "precondition: a send happened");
		const firstSentAt = success[0]!.sentAt as number;

		await emit(p, ctx, "message_end", { message: { role: "user", content: "keep going" } });
		await flushContinuation(25);

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, `expected auto_run.throttle.reset entry; steps seen: ${stepsSeen()}`);
		const e = entries.find((x) => x.reason === "user_message");
		assert.ok(e, `expected reason=user_message; got: ${JSON.stringify(entries.map((x) => x.reason))}`);
		assert.equal(e!.previousLastSentAt, firstSentAt, "previousLastSentAt = timestamp of the last send");
		assert.equal(e!.previousGoalId, goalId, "previousGoalId = the goal the throttle was tracking");
	});

	it("/goal-resume logs reset with reason=goal_resumed", async () => {
		writeGoalFile(cwd, { id: "resume-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(50);

		await invokeCommand(p, ctx, "goal-pause", "");
		await flushContinuation(25);
		await invokeCommand(p, ctx, "goal-resume", "");
		await flushContinuation(50);

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, `expected auto_run.throttle.reset entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "goal_resumed"),
			`expected reason=goal_resumed; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});

	it("session_compact logs reset with reason=session_compact", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: reset-on-compact trace. success criteria: done.");

		await emit(p, ctx, "session_compact", {});
		await flushContinuation(50);

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, `expected auto_run.throttle.reset entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.reason === "session_compact"),
			`expected reason=session_compact; got: ${JSON.stringify(entries.map((e) => e.reason))}`,
		);
	});
});

// ---------------------------------------------------------------------------
// 7. resolveContinuationGate — step `auto_run.gate.resolve`
//    (implemented in b5126ec — regression coverage with full field contract)
// ---------------------------------------------------------------------------

describe("trace: resolveContinuationGate (auto_run.gate.resolve)", () => {
	it("logs minIntervalMs=600000 with source=default when unconfigured", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: gate default trace. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, `expected auto_run.gate.resolve entry; steps seen: ${stepsSeen()}`);
		const e = entries[0]!;
		assert.equal(e.source, "default", "unconfigured → source=default");
		assert.equal(e.minIntervalMs, 600_000, "default minIntervalMs is 600000");
	});

	it("logs source=env with the env-overridden minIntervalMs (env beats file)", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalContinuation: { minIntervalMs: 4242 } }),
		);
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = "1500"; // env beats file
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: gate env trace. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, `expected auto_run.gate.resolve entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.source === "env" && e.minIntervalMs === 1500),
			`expected source=env + minIntervalMs=1500; got: ${JSON.stringify(entries.map(({ source, minIntervalMs }) => ({ source, minIntervalMs })))}`,
		);
	});

	it("logs source=file with the file-configured minIntervalMs (file beats default)", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalContinuation: { minIntervalMs: 4242 } }),
		);
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: gate file trace. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, `expected auto_run.gate.resolve entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.source === "file" && e.minIntervalMs === 4242),
			`expected source=file + minIntervalMs=4242; got: ${JSON.stringify(entries.map(({ source, minIntervalMs }) => ({ source, minIntervalMs })))}`,
		);
	});

	it("logs source=file when the file EXPLICITLY sets minIntervalMs=600000 (equal to default — no value-diff inference)", async () => {
		// RED first (cubic PR#68 R2-1): value-diff inference reported "default"
		// here because 600000 === DEFAULT_CONTINUATION_MIN_INTERVAL_MS. True
		// provenance must report "file" for an explicit file setting.
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalContinuation: { minIntervalMs: 600_000 } }),
		);
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: gate explicit-default file trace. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, `expected auto_run.gate.resolve entry; steps seen: ${stepsSeen()}`);
		assert.ok(
			entries.some((e) => e.source === "file" && e.minIntervalMs === 600_000),
			`expected source=file + minIntervalMs=600000 for explicit file setting; got: ${JSON.stringify(entries.map(({ source, minIntervalMs }) => ({ source, minIntervalMs })))}`,
		);
	});
});

// ---------------------------------------------------------------------------
// 8. Edge cases
// ---------------------------------------------------------------------------

describe("trace: continuation lifecycle edge cases", () => {
	it("force-path reset (session_compact) → next send for the SAME goal bypasses the 10-min cooldown", async () => {
		writeGoalFile(cwd, { id: "bypass-g", autoContinue: true });
		const { pi: p, ctx } = freshPi();
		await emit(p, ctx, "session_start", { reason: "resume" });
		await flushContinuation(50); // send #1 → lastSentAt set, cooldown armed (600000ms)

		// session_compact resets the throttle; agent_end re-queues (it nulls
		// the leftover continuationQueuedFor from send #1) so the post-reset
		// send actually fires.
		await emit(p, ctx, "session_compact", {}); // resets throttle
		await emit(p, ctx, "agent_end", { messages: [] }); // re-queue
		await flushContinuation(50);

		assert.ok(countContinuations(p) >= 2, `sanity: second continuation fired despite cooldown; steps seen: ${stepsSeen()}`);
		const successes = entriesFor("auto_run.send.success");
		assert.ok(successes.length >= 2, `expected two send.success entries; steps seen: ${stepsSeen()}`);
		const second = successes[1]!;
		assert.equal(second.goalId, "bypass-g", "second send is for the same goal");
		assert.equal(second.lastSentAt, null, "throttle reset → lastSentAt=null on the next send");
		assert.equal(
			second.nextAllowedAt,
			(second.sentAt as number) + (second.minIntervalMs as number),
			"nextAllowedAt = sentAt + minIntervalMs on the post-reset send",
		);
	});

	it("goal switch (force path) starts a fresh throttle: goalIdMatch=false context is visible in the trace", async () => {
		const { pi: p, ctx } = freshPi();
		const firstGoalId = await createGoalAndFlush(p, ctx, "objective: first goal. success criteria: done.");

		// Second goal via /goals-set (replaceGoal force path) while the first
		// goal's throttle is armed — the new goal must not inherit the cooldown.
		await invokeCommand(p, ctx, "goals-set", "objective: second goal. success criteria: done.");
		await flushContinuation(50);

		const successes = entriesFor("auto_run.send.success");
		assert.ok(successes.length >= 2, `expected two send.success entries; steps seen: ${stepsSeen()}`);
		const second = successes[1]!;
		assert.notEqual(second.goalId, firstGoalId, "second send is for the new goal");
		assert.equal(second.lastSentAt, null, "new goal → lastSentAt=null (throttle tracked per goal)");
	});
});
