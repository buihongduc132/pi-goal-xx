/**
 * RED phase — continuation lifecycle trace tests.
 *
 * Contract under test (4 trace points, happy path only):
 *
 *  1. queueContinuation entry — logGoalTrace step `auto_run.queue` with goalId.
 *  2. sendQueuedContinuation SUCCESS — step `auto_run.send.success` with
 *     goalId, lastSentAt, sentAt, nextAllowedAt, minIntervalMs, source.
 *  3. resetContinuationThrottle — step `auto_run.throttle.reset` with
 *     reason (goal_created|goal_resumed|user_message|session_compact|
 *     auditor_rejection), previousLastSentAt, previousGoalId.
 *  4. resolveContinuationGate — step `auto_run.gate.resolve` with
 *     minIntervalMs, source (file|env|default).
 *
 * Tests are written BEFORE the trace points exist. They MUST fail now.
 *
 * Approach: load the real goal extension into the mock pi harness, drive the
 * public surface (/goals-set command, message_end event), then read the
 * structured trace log at <cwd>/.pi/goals/goal-trace.jsonl and assert the
 * expected step entries with their fields.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { readActiveGoalPool } from "../extensions/storage/goal-files.ts";
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

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;
let savedContEnv: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-cont-trace-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	savedContEnv = process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	delete process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	if (savedContEnv === undefined) delete process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS;
	else process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = savedContEnv;
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

/** Create a goal via /goals-set, wait for the queued continuation to fire. */
async function createGoalAndFlush(piLocal: ReturnType<typeof createMockPi>, ctx: any, objective: string) {
	await invokeCommand(piLocal, ctx, "goals-set", objective);
	await flushContinuation(50);
}

/** The single active goal id on disk. */
function soleGoalIdOnDisk(): string {
	const pool = readActiveGoalPool({ cwd });
	const ids = [...pool.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly 1 goal on disk, got ${ids.length}`);
	return ids[0]!;
}

// ---------------------------------------------------------------------------
// 1. queueContinuation entry — step `auto_run.queue`
// ---------------------------------------------------------------------------

describe("trace: queueContinuation entry (auto_run.queue)", () => {
	it("logs step auto_run.queue with the focused goalId when a continuation is queued", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace queue entry. success criteria: done.");

		assert.ok(countContinuations(p) >= 1, "sanity: continuation actually fired (precondition of the trace contract)");

		const entries = entriesFor("auto_run.queue");
		assert.ok(entries.length >= 1, `expected at least one auto_run.queue entry; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);
		const goalId = soleGoalIdOnDisk();
		assert.equal(entries[0]!.goalId, goalId, "auto_run.queue entry carries the focused goalId");
	});
});

// ---------------------------------------------------------------------------
// 2. sendQueuedContinuation SUCCESS — step `auto_run.send.success`
// ---------------------------------------------------------------------------

describe("trace: sendQueuedContinuation success (auto_run.send.success)", () => {
	it("logs step auto_run.send.success with goalId, lastSentAt, sentAt, nextAllowedAt, minIntervalMs, source", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace send success. success criteria: done.");

		assert.ok(countContinuations(p) >= 1, "sanity: continuation send actually happened");

		const entries = entriesFor("auto_run.send.success");
		assert.ok(entries.length >= 1, `expected at least one auto_run.send.success entry; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);

		const e = entries[0]!;
		const goalId = soleGoalIdOnDisk();
		assert.equal(e.goalId, goalId, "send.success carries the focused goalId");
		// First send for a fresh goal: lastSentAt may be null but MUST be present.
		assert.ok("lastSentAt" in e, "send.success carries lastSentAt");
		assert.equal(typeof e.sentAt, "number", "send.success carries numeric sentAt");
		assert.equal(typeof e.minIntervalMs, "number", "send.success carries numeric minIntervalMs");
		assert.equal(typeof e.nextAllowedAt, "number", "send.success carries numeric nextAllowedAt");
		assert.equal(typeof e.source, "string", "send.success carries string source");
		assert.equal((e.nextAllowedAt as number), (e.sentAt as number) + (e.minIntervalMs as number), "nextAllowedAt = sentAt + minIntervalMs");
	});
});

// ---------------------------------------------------------------------------
// 3. resetContinuationThrottle — step `auto_run.throttle.reset`
// ---------------------------------------------------------------------------

describe("trace: resetContinuationThrottle (auto_run.throttle.reset)", () => {
	it("logs step auto_run.throttle.reset with reason goal_created and previous-state fields on goal creation", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace throttle reset on create. success criteria: done.");

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, `expected at least one auto_run.throttle.reset entry; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);

		const e = entries[0]!;
		assert.equal(e.reason, "goal_created", "reset on fresh goal creation carries reason=goal_created");
		assert.ok("previousLastSentAt" in e, "throttle.reset carries previousLastSentAt");
		assert.ok("previousGoalId" in e, "throttle.reset carries previousGoalId");
	});

	it("logs step auto_run.throttle.reset with reason user_message on inbound user message_end", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace throttle reset on user msg. success criteria: done.");

		await emit(p, ctx, "message_end", { message: { role: "user", content: "hello" } });
		await flushContinuation(25);

		const entries = entriesFor("auto_run.throttle.reset");
		assert.ok(entries.length >= 1, "expected at least one auto_run.throttle.reset entry after user message");
		assert.ok(
			entries.some((e) => e.reason === "user_message"),
			`expected a reset entry with reason=user_message; reasons seen: ${entries.map((e) => String(e.reason)).join(", ") || "(none)"}`,
		);
	});
});

// ---------------------------------------------------------------------------
// 4. resolveContinuationGate — step `auto_run.gate.resolve`
// ---------------------------------------------------------------------------

describe("trace: resolveContinuationGate (auto_run.gate.resolve)", () => {
	it("logs step auto_run.gate.resolve with source default and minIntervalMs 600000 when unconfigured", async () => {
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace gate resolve default. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, `expected at least one auto_run.gate.resolve entry; steps seen: ${readTraceEntries().map((e) => e.step).join(", ") || "(none)"}`);

		const e = entries[0]!;
		assert.equal(e.source, "default", "unconfigured gate resolves with source=default");
		assert.equal(e.minIntervalMs, 600000, "default minIntervalMs is 600000 (10 minutes)");
	});

	it("logs step auto_run.gate.resolve with source env and the env-overridden minIntervalMs", async () => {
		process.env.PI_GOAL_CONTINUATION_MIN_INTERVAL_MS = "1500";
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace gate resolve env. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, "expected at least one auto_run.gate.resolve entry (env override)");
		assert.ok(
			entries.some((e) => e.source === "env" && e.minIntervalMs === 1500),
			`expected a gate.resolve entry with source=env and minIntervalMs=1500; got: ${JSON.stringify(entries.map(({ step, source, minIntervalMs }) => ({ step, source, minIntervalMs })))}`,
		);
	});

	it("logs step auto_run.gate.resolve with source file when settings file sets goalContinuation.minIntervalMs", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalContinuation: { minIntervalMs: 4242 } }),
		);
		const { pi: p, ctx } = freshPi();
		await createGoalAndFlush(p, ctx, "objective: trace gate resolve file. success criteria: done.");

		const entries = entriesFor("auto_run.gate.resolve");
		assert.ok(entries.length >= 1, "expected at least one auto_run.gate.resolve entry (file config)");
		assert.ok(
			entries.some((e) => e.source === "file" && e.minIntervalMs === 4242),
			`expected a gate.resolve entry with source=file and minIntervalMs=4242; got: ${JSON.stringify(entries.map(({ step, source, minIntervalMs }) => ({ step, source, minIntervalMs })))}`,
		);
	});
});
