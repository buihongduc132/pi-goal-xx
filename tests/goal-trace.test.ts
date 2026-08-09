/**
 * Unified operational trace logger tests.
 *
 * Covers extensions/goal-trace.ts:
 *   - Low-level invariants: never throws, appends JSONL, level filtering,
 *     rotation reuse.
 *   - Span helper traceStep: start/end/duration and error rethrow.
 *   - wrapExecuteWithTrace: wraps a fn, recovers cwd from ctx.
 *   - Integration: a real tool invocation writes tool.<name> start+end spans.
 *
 * The logger mirrors auditor-log.ts conventions (sync appendFileSync, rotation
 * via rotateIfNeeded, never-throw). Crash-safety is asserted by pointing the
 * sink at an unwritable cwd.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	invokeTool,
	invokeCommand,
	cleanupTimers,
	forceNonWorkerEnv,
	restoreGoalEnv,
	emit,
} from "./_harness.ts";
import {
	logGoalTrace,
	goalTraceLogPath,
	traceStep,
	wrapExecuteWithTrace,
	resolveTraceSink,
	TRACE_SINK_OFF,
	TRACE_SINK_DEFAULT,
	previewBytes,
	previewError,
	newTraceId,
	newSpanId,
	isValidTraceId,
	isValidSpanId,
	getCurrentSpan,
	type GoalTraceSinkConfig,
} from "../extensions/goal-trace.ts";

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gtrace-"));
	fs.mkdirSync(path.join(tmp, ".pi", "goals"), { recursive: true });
	return tmp;
}

function readTrace(cwd: string): Record<string, unknown>[] {
	const p = goalTraceLogPath(cwd);
	if (!fs.existsSync(p)) return [];
	return fs.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("goal-trace — low-level invariants", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("never throws on an unwritable cwd (file-as-cwd)", () => {
		const fileAsCwd = path.join(makeTmpCwd(), "i-am-a-file");
		fs.writeFileSync(fileAsCwd, "x");
		assert.doesNotThrow(() =>
			logGoalTrace(fileAsCwd, { level: "info", step: "test", message: "x" }),
		);
		try { fs.rmSync(path.dirname(fileAsCwd), { recursive: true, force: true }); } catch {}
	});

	it("appends a structured JSONL entry with ts + phase defaulted", () => {
		logGoalTrace(cwd, { level: "warn", step: "lock.release", goalId: "g1", message: "hi" });
		const entries = readTrace(cwd);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].level, "warn");
		assert.equal(entries[0].step, "lock.release");
		assert.equal(entries[0].goalId, "g1");
		assert.equal(entries[0].phase, "event");
		assert.equal(typeof entries[0].ts, "string");
	});

	it("appends multiple entries in order", () => {
		logGoalTrace(cwd, { level: "info", step: "a" });
		logGoalTrace(cwd, { level: "info", step: "b" });
		const entries = readTrace(cwd);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].step, "a");
		assert.equal(entries[1].step, "b");
	});

	it("goalTraceLogPath points at <cwd>/.pi/goals/goal-trace.jsonl", () => {
		assert.equal(
			goalTraceLogPath(cwd),
			path.join(cwd, ".pi", "goals", "goal-trace.jsonl"),
		);
	});
});

describe("goal-trace — level filtering", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("writes nothing when sink is OFF", () => {
		logGoalTrace(cwd, { level: "error", step: "x" }, TRACE_SINK_OFF);
		assert.equal(readTrace(cwd).length, 0);
	});

	it("error sink writes only error-level entries", () => {
		const sink = resolveTraceSink({ level: "error" });
		logGoalTrace(cwd, { level: "debug", step: "d" }, sink);
		logGoalTrace(cwd, { level: "info", step: "i" }, sink);
		logGoalTrace(cwd, { level: "warn", step: "w" }, sink);
		logGoalTrace(cwd, { level: "error", step: "e" }, sink);
		const entries = readTrace(cwd);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].step, "e");
	});

	it("warn sink writes warn + error", () => {
		const sink = resolveTraceSink({ level: "warn" });
		logGoalTrace(cwd, { level: "debug", step: "d" }, sink);
		logGoalTrace(cwd, { level: "info", step: "i" }, sink);
		logGoalTrace(cwd, { level: "warn", step: "w" }, sink);
		logGoalTrace(cwd, { level: "error", step: "e" }, sink);
		const steps = readTrace(cwd).map((e) => e.step);
		assert.deepEqual(steps.sort(), ["e", "w"]);
	});

	it("info sink (default) writes info/warn/error but not debug", () => {
		const sink = TRACE_SINK_DEFAULT;
		logGoalTrace(cwd, { level: "debug", step: "d" }, sink);
		logGoalTrace(cwd, { level: "info", step: "i" }, sink);
		logGoalTrace(cwd, { level: "warn", step: "w" }, sink);
		logGoalTrace(cwd, { level: "error", step: "e" }, sink);
		const steps = readTrace(cwd).map((e) => e.step);
		assert.deepEqual(steps.sort(), ["e", "i", "w"]);
	});

	it("debug sink writes everything", () => {
		const sink = resolveTraceSink({ level: "debug" });
		logGoalTrace(cwd, { level: "debug", step: "d" }, sink);
		logGoalTrace(cwd, { level: "error", step: "e" }, sink);
		assert.equal(readTrace(cwd).length, 2);
	});

	it("omitting sink uses the default (info) floor", () => {
		logGoalTrace(cwd, { level: "debug", step: "d" });
		logGoalTrace(cwd, { level: "info", step: "i" });
		const steps = readTrace(cwd).map((e) => e.step);
		assert.deepEqual(steps, ["i"]);
	});
});

describe("goal-trace — resolveTraceSink", () => {
	it("off level → POSITIVE_INFINITY floor", () => {
		assert.equal(resolveTraceSink({ level: "off" }).levelFloor, Number.POSITIVE_INFINITY);
	});

	it("missing input → default (info)", () => {
		assert.deepEqual(resolveTraceSink(undefined), TRACE_SINK_DEFAULT);
		assert.deepEqual(resolveTraceSink(null), TRACE_SINK_DEFAULT);
	});

	it("invalid level → default (info), never throws", () => {
		assert.deepEqual(resolveTraceSink({ level: "bogus" }), TRACE_SINK_DEFAULT);
	});

	it("toStderr passes through", () => {
		assert.equal(resolveTraceSink({ toStderr: true }).toStderr, true);
	});

	it("TRACE_SINK_OFF disables writes", () => {
		assert.equal(TRACE_SINK_OFF.levelFloor, Number.POSITIVE_INFINITY);
		assert.equal(TRACE_SINK_OFF.toStderr, false);
	});
});

describe("goal-trace — previewBytes / previewError", () => {
	it("previewBytes truncates with a byte-count suffix", () => {
		const out = previewBytes("abcdefghij", 4);
		assert.equal(out, "abcd…(+6 bytes)");
	});

	it("previewBytes leaves short strings intact", () => {
		assert.equal(previewBytes("abc", 10), "abc");
	});

	it("previewError renders an Error message", () => {
		const msg = previewError(new Error("boom"));
		assert.ok(typeof msg === "string");
		assert.ok(msg.includes("boom"));
	});

	it("previewError renders a string", () => {
		assert.equal(previewError("oops").includes("oops"), true);
	});

	it("previewError renders unserialisable input without throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const msg = previewError(cyclic);
		assert.ok(typeof msg === "string");
	});
});

describe("goal-trace — traceStep span helper", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("writes start + end for a sync success and returns the value", () => {
		const result = traceStep("op.sync", cwd, () => 42);
		assert.equal(result, 42);
		const phases = readTrace(cwd).map((e) => e.phase);
		assert.deepEqual(phases, ["start", "end"]);
	});

	it("writes start + end for an async success", async () => {
		const result = await traceStep("op.async", cwd, async () => "ok");
		assert.equal(result, "ok");
		const entries = readTrace(cwd);
		assert.deepEqual(entries.map((e) => e.phase), ["start", "end"]);
	});

	it("end entry carries durationMs", () => {
		traceStep("op.dur", cwd, () => 1);
		const end = readTrace(cwd).find((e) => e.phase === "end");
		assert.ok(typeof end?.durationMs === "number");
		assert.ok((end.durationMs as number) >= 0);
	});

	it("writes an error entry and rethrows on sync failure", () => {
		assert.throws(
			() => traceStep("op.throw", cwd, () => { throw new Error("sync-fail"); }),
			/sync-fail/,
		);
		const entries = readTrace(cwd);
		const errEntry = entries.find((e) => e.phase === "error");
		assert.ok(errEntry, "expected an error trace entry");
		assert.equal(errEntry.level, "error");
		assert.ok(String(errEntry.error).includes("sync-fail"));
	});

	it("writes an error entry and rejects on async failure", async () => {
		await assert.rejects(
			traceStep("op.athrow", cwd, async () => { throw new Error("async-fail"); }),
			/async-fail/,
		);
		const errEntry = readTrace(cwd).find((e) => e.phase === "error");
		assert.ok(errEntry, "expected an error trace entry");
		assert.ok(String(errEntry.error).includes("async-fail"));
	});

	it("respects the sink — OFF writes nothing but still returns/rethrows", () => {
		const result = traceStep("op.off", cwd, () => 7, { sink: TRACE_SINK_OFF });
		assert.equal(result, 7);
		assert.equal(readTrace(cwd).length, 0);
	});

	it("goalId + extra context propagate to the start entry", () => {
		traceStep("op.ctx", cwd, () => 1, { goalId: "g9", extra: { requestId: "r1" } });
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.goalId, "g9");
		assert.equal(start?.requestId, "r1");
	});
});

describe("goal-trace — wrapExecuteWithTrace", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("wraps a function, recovers cwd from ctx arg, writes a span", async () => {
		const original = async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => {
			return { ok: true, ctxCwd: ctx.cwd };
		};
		const wrapped = wrapExecuteWithTrace("tool.demo", original as (...a: unknown[]) => unknown, { fallbackCwd: "/fallback" });
		const result = await wrapped("tcall", {}, undefined, undefined, { cwd });
		assert.deepEqual(result, { ok: true, ctxCwd: cwd });
		const entries = readTrace(cwd);
		assert.deepEqual(entries.map((e) => e.phase), ["start", "end"]);
		assert.equal(entries[0].step, "tool.demo");
	});

	it("falls back to fallbackCwd when no ctx.cwd is present", () => {
		const fallback = makeTmpCwd();
		const original = () => "done";
		const wrapped = wrapExecuteWithTrace("tool.nocwd", original as (...a: unknown[]) => unknown, { fallbackCwd: fallback });
		wrapped();
		// Span written to fallback cwd, not the test's cwd.
		const entries = readTrace(fallback);
		assert.equal(entries.length, 2);
		try { fs.rmSync(fallback, { recursive: true, force: true }); } catch {}
		// And nothing in the test cwd.
		assert.equal(readTrace(cwd).length, 0);
	});

	it("rethrows and traces when the wrapped function throws", () => {
		const original = () => { throw new Error("wrapped-fail"); };
		const wrapped = wrapExecuteWithTrace("tool.throwy", original as (...a: unknown[]) => unknown, { fallbackCwd: cwd });
		assert.throws(() => wrapped(), /wrapped-fail/);
		const errEntry = readTrace(cwd).find((e) => e.phase === "error");
		assert.ok(errEntry);
		assert.ok(String(errEntry.error).includes("wrapped-fail"));
	});

	it("honours an OFF sink (writes nothing, still calls fn)", () => {
		let called = false;
		const original = () => { called = true; return 1; };
		const wrapped = wrapExecuteWithTrace("tool.off", original as (...a: unknown[]) => unknown, { fallbackCwd: cwd, sink: TRACE_SINK_OFF });
		const result = wrapped();
		assert.equal(result, 1);
		assert.equal(called, true);
		assert.equal(readTrace(cwd).length, 0);
	});
});

describe("goal-trace — rotation reuse", () => {
	it("appends a valid JSONL line after an existing file (rotation never corrupts)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gtrace-rot-"));
		const cwd = path.join(dir, "proj");
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		const target = goalTraceLogPath(cwd);
		// Pre-seed the trace with a valid prior line (mimics an existing log).
		fs.writeFileSync(target, JSON.stringify({ ts: "t0", level: "info", phase: "event", step: "prior" }) + "\n");
		// A new write must succeed and the appended line must be valid JSON.
		assert.doesNotThrow(() =>
			logGoalTrace(cwd, { level: "info", step: "appended", message: "still works" }),
		);
		const lines = fs.readFileSync(target, "utf8").split("\n").filter((l) => l.trim());
		assert.ok(lines.length >= 2, "expected the seed line + the new line");
		const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
		assert.equal(last.step, "appended");
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});
});

// ---------------------------------------------------------------------------
// Integration: drive a real tool via the harness, assert the trace spans land.
// ---------------------------------------------------------------------------
describe("goal-trace — integration: tool spans via the extension", () => {
	let pi: any;
	let cwd: string;
	let envSnap: ReturnType<typeof forceNonWorkerEnv>;

	beforeEach(() => {
		envSnap = forceNonWorkerEnv();
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-gtrace-int-"));
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		pi = createMockPi({ cwd });
		goalExtension(pi);
	});

	afterEach(async () => {
		try { await cleanupTimers(pi, cwd); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
		restoreGoalEnv(envSnap);
	});

	it("a get_goal tool call writes tool.get_goal start+end spans", async () => {
		const ctx = createMockCtx(pi, { cwd });
		await invokeTool(pi, ctx, "get_goal", {});
		const entries = readTrace(cwd).filter((e) => e.step === "tool.get_goal");
		assert.ok(entries.length >= 2, `expected >=2 get_goal trace entries, got ${entries.length}`);
		const phases = entries.map((e) => e.phase);
		assert.ok(phases.includes("start"), "expected a start phase");
		assert.ok(phases.includes("end"), "expected an end phase");
		// The end entry should carry a duration.
		const end = entries.find((e) => e.phase === "end");
		assert.ok(typeof end?.durationMs === "number");
	});

	it("a command invocation writes a cmd.<name> span", async () => {
		const ctx = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx, "goal-status", "");
		const entries = readTrace(cwd).filter((e) => typeof e.step === "string" && (e.step as string).startsWith("cmd."));
		assert.ok(entries.length >= 2, `expected >=2 cmd trace entries, got ${entries.length}`);
		assert.ok(entries.some((e) => e.phase === "start"));
		assert.ok(entries.some((e) => e.phase === "end"));
	});

	it("logging.level off in settings disables tool spans", async () => {
		// Write a settings file with logging off BEFORE the next ctx load.
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ logging: { level: "off" } }),
		);
		const ctx = createMockCtx(pi, { cwd });
		// session_start refreshes the cached sink from settings.
		await emit(pi, ctx, "session_start", { reason: "initial" });
		await invokeTool(pi, ctx, "get_goal", {});
		assert.equal(readTrace(cwd).length, 0, "off level must suppress all trace writes");
	});
});

// ---------------------------------------------------------------------------
// OTel-shaped JSONL: id generation, span-context propagation, field stamping.
// ---------------------------------------------------------------------------
describe("goal-trace — OTel id generation", () => {
	it("newTraceId produces a valid W3C trace id (32 lowercase hex)", () => {
		const id = newTraceId();
		assert.equal(id.length, 32);
		assert.ok(isValidTraceId(id), `${id} should be a valid trace id`);
	});

	it("newSpanId produces a valid W3C span id (16 lowercase hex)", () => {
		const id = newSpanId();
		assert.equal(id.length, 16);
		assert.ok(isValidSpanId(id), `${id} should be a valid span id`);
	});

	it("newSpanId never returns the all-zero id", () => {
		// Re-roll many times; W3C forbids 0000000000000000.
		for (let i = 0; i < 100; i++) {
			assert.notEqual(newSpanId(), "0000000000000000");
		}
	});

	it("isValidTraceId rejects all-zero and wrong-length", () => {
		assert.ok(!isValidTraceId("0".repeat(32)));
		assert.ok(!isValidTraceId("abc"));
		assert.ok(!isValidTraceId("Z".repeat(32))); // non-hex
	});

	it("isValidSpanId rejects all-zero and wrong-length", () => {
		assert.ok(!isValidSpanId("0".repeat(16)));
		assert.ok(!isValidSpanId("abc"));
	});

	it("ids are unique across many calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) ids.add(newTraceId());
		assert.equal(ids.size, 200);
	});
});

describe("goal-trace — OTel fields on emitted entries", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("traceStep emits traceId + spanId + spanName + spanKind on every line", () => {
		traceStep("op.otel", cwd, () => 1);
		const entries = readTrace(cwd);
		assert.equal(entries.length, 2);
		for (const e of entries) {
			assert.ok(isValidTraceId(String(e.traceId)), `entry ${e.phase} has valid traceId`);
			assert.ok(isValidSpanId(String(e.spanId)), `entry ${e.phase} has valid spanId`);
			assert.equal(e.spanName, "op.otel");
			assert.equal(e.spanKind, "INTERNAL");
			assert.ok(typeof e.attrs === "object");
		}
	});

	it("start entry has status UNSET", () => {
		traceStep("op.s", cwd, () => 1);
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.status, "UNSET");
	});

	it("end entry has status OK", () => {
		traceStep("op.ok", cwd, () => 1);
		const end = readTrace(cwd).find((e) => e.phase === "end");
		assert.equal(end?.status, "OK");
	});

	it("goalId is carried into the attrs bag as goal.id", () => {
		traceStep("op.g", cwd, () => 1, { goalId: "gX" });
		const end = readTrace(cwd).find((e) => e.phase === "end");
		assert.equal(end?.attrs?.["goal.id"], "gX");
	});

	it("extra context is carried into the attrs bag", () => {
		traceStep("op.ex", cwd, () => 1, { extra: { requestId: "r7" } });
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.attrs?.["requestId"], "r7");
	});
});

describe("goal-trace — OTel span pair correlation", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("a successful span's start+end share traceId + spanId", () => {
		traceStep("op.pair", cwd, () => 1);
		const entries = readTrace(cwd);
		const start = entries.find((e) => e.phase === "start");
		const end = entries.find((e) => e.phase === "end");
		assert.ok(start && end);
		assert.equal(start.traceId, end.traceId, "traceId must match across the pair");
		assert.equal(start.spanId, end.spanId, "spanId must match across the pair");
	});

	it("a throwing span's start+error share traceId + spanId", () => {
		assert.throws(() => traceStep("op.err", cwd, () => { throw new Error("boom"); }));
		const entries = readTrace(cwd);
		const start = entries.find((e) => e.phase === "start");
		const err = entries.find((e) => e.phase === "error");
		assert.ok(start && err);
		assert.equal(start.traceId, err.traceId);
		assert.equal(start.spanId, err.spanId);
		assert.equal(err.status, "ERROR");
		assert.ok(String(err.statusMessage).includes("boom"));
	});

	it("an async throwing span's start+error share ids", async () => {
		await assert.rejects(
			traceStep("op.aerr", cwd, async () => { throw new Error("aboom"); }),
		);
		const entries = readTrace(cwd);
		const start = entries.find((e) => e.phase === "start");
		const err = entries.find((e) => e.phase === "error");
		assert.ok(start && err);
		assert.equal(start.traceId, err.traceId);
		assert.equal(start.spanId, err.spanId);
		assert.equal(err.status, "ERROR");
	});

	it("two unrelated spans have different traceIds", () => {
		traceStep("op.a", cwd, () => 1);
		traceStep("op.b", cwd, () => 2);
		const entries = readTrace(cwd);
		const aStart = entries.find((e) => e.phase === "start" && e.step === "op.a");
		const bStart = entries.find((e) => e.phase === "start" && e.step === "op.b");
		assert.ok(aStart && bStart);
		assert.notEqual(aStart.traceId, bStart.traceId, "sibling spans get distinct traces");
		assert.notEqual(aStart.spanId, bStart.spanId);
	});
});

describe("goal-trace — OTel parent linking (nested spans)", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("a nested traceStep inherits the parent's spanId and traceId (sync)", () => {
		traceStep("op.outer", cwd, () => {
			traceStep("op.inner", cwd, () => 1);
			return 2;
		});
		const entries = readTrace(cwd);
		const outerStart = entries.find((e) => e.step === "op.outer" && e.phase === "start");
		const innerStart = entries.find((e) => e.step === "op.inner" && e.phase === "start");
		assert.ok(outerStart && innerStart);
		// Same trace:
		assert.equal(innerStart.traceId, outerStart.traceId, "inner shares the outer trace");
		// Inner's parent is the outer's span:
		assert.equal(innerStart.parentSpanId, outerStart.spanId, "inner.parentSpanId === outer.spanId");
		// Outer has no parent (top-level):
		assert.equal(outerStart.parentSpanId, undefined, "outer span has no parent");
	});

	it("a nested async traceStep chains parent across awaits", async () => {
		const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
		await traceStep("op.outerAsync", cwd, async () => {
			await wait(1);
			await traceStep("op.innerAsync", cwd, async () => {
				await wait(1);
			});
		});
		const entries = readTrace(cwd);
		const outerStart = entries.find((e) => e.step === "op.outerAsync" && e.phase === "start");
		const innerStart = entries.find((e) => e.step === "op.innerAsync" && e.phase === "start");
		assert.ok(outerStart && innerStart);
		assert.equal(innerStart.traceId, outerStart.traceId);
		assert.equal(innerStart.parentSpanId, outerStart.spanId);
	});

	it("getCurrentSpan returns the active span inside traceStep, undefined outside", () => {
		let captured: { traceId: string; spanId: string } | undefined;
		traceStep("op.ctx", cwd, () => {
			captured = getCurrentSpan();
			return 1;
		});
		assert.ok(captured, "getCurrentSpan returned a value inside traceStep");
		assert.ok(isValidTraceId(captured!.traceId));
		assert.equal(getCurrentSpan(), undefined, "no active span outside traceStep");
	});
});

describe("goal-trace — OTel spanKind via wrapExecuteWithTrace", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });

	it("emits spanKind CLIENT when requested", async () => {
		const wrapped = wrapExecuteWithTrace("tool.t", (async () => 1) as (...a: unknown[]) => unknown, { spanKind: "CLIENT", fallbackCwd: cwd });
		await wrapped();
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.spanKind, "CLIENT");
	});

	it("emits spanKind SERVER when requested", async () => {
		const wrapped = wrapExecuteWithTrace("cmd.c", (async () => 1) as (...a: unknown[]) => unknown, { spanKind: "SERVER", fallbackCwd: cwd });
		await wrapped();
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.spanKind, "SERVER");
	});

	it("defaults to INTERNAL when no spanKind given", async () => {
		const wrapped = wrapExecuteWithTrace("op.i", (async () => 1) as (...a: unknown[]) => unknown, { fallbackCwd: cwd });
		await wrapped();
		const start = readTrace(cwd).find((e) => e.phase === "start");
		assert.equal(start?.spanKind, "INTERNAL");
	});
});

