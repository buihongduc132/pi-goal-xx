/**
 * Step-1 tests: forensic trace logging for the auditor.
 *
 * Reproduces the failure mode the logger exists to catch: when an audit run
 * completes (or aborts/errors), the trace file MUST contain structured
 * entries that let us diagnose a crash/hang afterwards. The original crash
 * left "no trace" — these tests assert the trace is written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	logAuditorTrace,
	buildStartEntry,
	buildEndEntry,
	buildEventEntry,
	previewBytes,
	auditorTraceLogPath,
} from "../extensions/auditor-log.ts";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-trace-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-trace",
		objective: "OBJ-TRACE",
		status: "active",
		autoContinue: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
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

function makeMockCreateSession(opts: { finalOutput?: string; events?: any[]; throwInPrompt?: Error; promptHook?: (t: string) => void }): any {
	return async (_sessionArgs: any) => {
		let subscriber: ((event: any) => void) | null = null;
		const session = {
			prompted: [] as string[],
			abortCalled: false,
			subscribe(cb: (event: any) => void) { subscriber = cb; return () => { subscriber = null; }; },
			async prompt(text: string) {
				this.prompted.push(text);
				opts.promptHook?.(text);
				for (const ev of (opts as any).events ?? []) subscriber?.(ev);
				if (opts.throwInPrompt) throw opts.throwInPrompt;
				if (opts.finalOutput !== undefined) {
					subscriber?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: opts.finalOutput }] },
					});
				}
			},
			abort() { this.abortCalled = true; },
		};
		return { session };
	};
}

function readTrace(cwd: string): any[] {
	const p = auditorTraceLogPath(cwd);
	if (!fs.existsSync(p)) return [];
	return fs.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

describe("auditor-log — low-level invariants", () => {
	it("logAuditorTrace never throws on a bad cwd (read-only filesystem simulation)", () => {
		// Path that cannot be created — should swallow.
		// (Use a file path as a cwd so mkdir fails.)
		const fileAsCwd = path.join(makeTmpCwd(), "i-am-a-file");
		fs.writeFileSync(fileAsCwd, "x");
		assert.doesNotThrow(() => {
			logAuditorTrace(fileAsCwd, { ts: new Date().toISOString(), phase: "start" });
		});
	});

	it("previewBytes truncates with byte-count marker", () => {
		const big = "x".repeat(100);
		const out = previewBytes(big, 10);
		assert.equal(out.length > 10, true);
		assert.match(out, /\+\d+ bytes/);
		assert.ok(out.startsWith("xxxxxxxxxx"));
	});

	it("previewBytes leaves small strings untouched", () => {
		assert.equal(previewBytes("short", 100), "short");
	});
});

describe("auditor-log — runGoalCompletionAuditor writes trace", () => {
	it("writes pre-createSession, start, and end entries on a successful approved audit", async () => {
		const cwd = makeTmpCwd();
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		const entries = readTrace(cwd);
		const phases = entries.map((e) => e.phase);
		assert.ok(phases.includes("pre-createSession"), `expected pre-createSession in ${JSON.stringify(phases)}`);
		assert.ok(phases.includes("start"), `expected start in ${JSON.stringify(phases)}`);
		assert.ok(phases.includes("end"), `expected end in ${JSON.stringify(phases)}`);
		const end = entries.find((e) => e.phase === "end");
		assert.equal(end.approved, true);
		assert.equal(end.error, undefined);
		assert.equal(end.goalId, "g-trace");
		assert.match(end.outputPreview, /<approved\/>/);
	});

	it("writes a phase=error entry when createSession throws", async () => {
		const cwd = makeTmpCwd();
		// createSession that rejects — simulates an extension onLoad crash,
		// the exact scenario that left "no trace" in production.
		const throwingCreate: any = async () => { throw new Error("ext onLoad boom"); };
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: throwingCreate,
		});
		const entries = readTrace(cwd);
		const phases = entries.map((e) => e.phase);
		assert.ok(phases.includes("pre-createSession"), "pre-createSession must be logged BEFORE createSession runs");
		assert.ok(phases.includes("error"), `expected error phase in ${JSON.stringify(phases)}`);
		const errEntry = entries.find((e) => e.phase === "error");
		assert.match(errEntry.error, /ext onLoad boom/);
		assert.equal(errEntry.source, "createSession");
	});

	it("writes a phase=error entry when prompt throws a generic error", async () => {
		const cwd = makeTmpCwd();
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ throwInPrompt: new Error("prompt boom") }),
		});
		const entries = readTrace(cwd);
		const errEntry = entries.find((e) => e.phase === "error");
		assert.ok(errEntry, "expected an error trace entry");
		assert.match(errEntry.error, /prompt boom/);
	});

	it("writes a phase=abort entry when signal aborts", async () => {
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		ac.abort();
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		const entries = readTrace(cwd);
		// Pre-createSession still logged; the abort path logs a terminal abort entry.
		const abort = entries.find((e) => e.phase === "abort");
		assert.ok(abort, "expected abort phase entry on signal abort");
		assert.match(abort.error, /Auditor aborted/);
	});

	it("logs each session event with type and bounded argsPreview", async () => {
		const cwd = makeTmpCwd();
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					{ type: "tool_execution_start", toolName: "read", args: { p: "/some/path" } },
					{ type: "tool_execution_end" },
				],
			}),
		});
		const entries = readTrace(cwd);
		const eventEntries = entries.filter((e) => e.phase === "event");
		const types = eventEntries.map((e) => e.eventType);
		assert.ok(types.includes("tool_execution_start"));
		assert.ok(types.includes("tool_execution_end"));
		const toolStart = eventEntries.find((e) => e.eventType === "tool_execution_start");
		assert.equal(toolStart.tool, "read");
		assert.match(toolStart.argsPreview, /\/some\/path/);
	});

	it("truncates extremely long tool args in the trace (bounded log size)", async () => {
		const cwd = makeTmpCwd();
		const hugeArgs = { blob: "A".repeat(50_000) };
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [{ type: "tool_execution_start", toolName: "write", args: hugeArgs }],
			}),
		});
		const entries = readTrace(cwd);
		const toolStart = entries.find((e) => e.phase === "event" && e.eventType === "tool_execution_start");
		// argsPreview is bounded — must be well under the 50k source bytes
		assert.ok(toolStart.argsPreview.length < 2_000, `argsPreview too large: ${toolStart.argsPreview.length}`);
		assert.match(toolStart.argsPreview, /\+\d+ bytes/);
	});

	it("prompt preview is bounded in the start entry", async () => {
		const cwd = makeTmpCwd();
		const hugeObjective = "Z".repeat(200_000);
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal({ objective: hugeObjective }), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		const entries = readTrace(cwd);
		const start = entries.find((e) => e.phase === "start");
		// Step-8 guard caps the prompt to ~50k per field, so total promptBytes
		// should be well under 200k (was >200k before the guard).
		assert.ok(start.promptBytes < 60_000, `prompt should be capped by step-8 guard, got ${start.promptBytes} bytes`);
		assert.ok(start.promptPreview.length < 5_000, `promptPreview too large: ${start.promptPreview.length}`);
	});
});
