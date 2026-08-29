/**
 * Tests for auditor timeout verdict recovery.
 *
 * Plan: flow/plans/auditor-timeout-verdict-recovery.md
 *
 * Bug: when an audit runs and outputs a verdict marker (<approved/> or <disapproved/>)
 * before the timeout expires, but the session.prompt promise does not resolve in time
 * (or timeout fires before prompt unblocks), the timeout handler previously returned
 * { approved: false, error: "Auditor timeout after ...ms" }, ignoring the already captured
 * streamed output buffers.
 *
 * Fix:
 *  1) On timeout, evaluate parseAuditorDecision on captured output (outputParts + textDeltaAccum).
 *  2) If a verdict marker exists, return that verdict with recoveredFromTimeout: true and no error.
 *  3) If no marker exists, preserve existing timeout error behavior.
 *  4) Log { phase: "timeout", verdictRecovered: ... } to auditor-trace.jsonl.
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
		id: "g-timeout-recovery",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-timeout-recovery-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function makeCtx(cwd: string): any {
	const model = { provider: "mock", id: "mock-model", name: "mock-model" };
	return {
		cwd,
		model,
		modelRegistry: {
			find: (p: string, i: string) => ({ provider: p, id: i, name: i }),
			getAvailable: () => [model],
		},
		hasUI: false,
	};
}

function readTraceEntries(cwd: string): any[] {
	const tracePath = path.join(cwd, ".pi", "goals", "auditor-trace.jsonl");
	if (!fs.existsSync(tracePath)) return [];
	return fs
		.readFileSync(tracePath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Fake session factory whose prompt() emits streamed events and then hangs forever,
 * triggering the auditor's timeout handler.
 */
function makeHangingStreamSession(opts: {
	textDeltas?: string[];
	textEnd?: string;
	messageEndText?: string;
}): any {
	return (_args: any) => {
		let subscriber: ((event: any) => void) | null = null;
		const session = {
			subscribe(cb: (event: any) => void) {
				subscriber = cb;
				return () => { subscriber = null; };
			},
			prompt(_text: string): Promise<void> {
				if (opts.textDeltas) {
					for (const delta of opts.textDeltas) {
						subscriber?.({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", delta },
						});
					}
				}
				if (opts.textEnd) {
					subscriber?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_end",
							content: opts.textEnd,
							partial: { role: "assistant", content: [{ type: "text", text: opts.textEnd }] },
						},
					});
				}
				if (opts.messageEndText) {
					subscriber?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: opts.messageEndText }] },
					});
				}
				// Hang indefinitely so timeout fires
				return new Promise<void>(() => {});
			},
			abort(): Promise<void> {
				return Promise.resolve();
			},
		};
		return Promise.resolve({ session });
	};
}

describe("Auditor timeout verdict recovery", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
		// Configure fast timeout and small floor for testing
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50, auditorTimeoutFloorMs: 20 }),
		);
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("test-recover-approved: timeout fires with streamed output ending with <approved/> -> result approved:true, no timeout error", async () => {
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "verification details",
			createSession: makeHangingStreamSession({
				textDeltas: ["All checklist criteria verified.\n\n", "<approved/>"],
			}),
		});

		assert.equal(result.approved, true, "recovered result must be approved: true");
		assert.equal(result.disapproved, false, "recovered result must be disapproved: false");
		assert.equal(result.error, undefined, "recovered result must not have an error");
		assert.equal(result.timedOut, true, "timedOut flag must remain true");
		assert.equal(result.recoveredFromTimeout, true, "recoveredFromTimeout must be true");
		assert.match(result.output, /<approved\/>/);

		// Trace verification
		const entries = readTraceEntries(cwd);
		const timeoutEntry = entries.find((e) => e.phase === "timeout");
		assert.ok(timeoutEntry, "auditor trace must include a timeout phase entry");
		assert.equal(timeoutEntry.verdictRecovered, "approved", "timeout entry must record verdictRecovered: 'approved'");

		const endEntry = entries.find((e) => e.phase === "end");
		assert.ok(endEntry, "auditor trace must record terminal phase 'end'");
		assert.equal(endEntry.approved, true);
		assert.equal(endEntry.error, undefined);
	});

	it("test-recover-disapproved: timeout fires with streamed output ending with <disapproved/> -> result disapproved:true, no timeout error", async () => {
		const disapprovedOutput = "Requirement 3 is missing test coverage.\n\n<disapproved/>";
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "verification details",
			createSession: makeHangingStreamSession({
				textEnd: disapprovedOutput,
			}),
		});

		assert.equal(result.approved, false, "recovered result must be approved: false");
		assert.equal(result.disapproved, true, "recovered result must be disapproved: true");
		assert.equal(result.error, undefined, "recovered result must not have an error");
		assert.equal(result.timedOut, true, "timedOut flag must remain true");
		assert.equal(result.recoveredFromTimeout, true, "recoveredFromTimeout must be true");
		assert.match(result.output, /<disapproved\/>/);

		// Trace verification
		const entries = readTraceEntries(cwd);
		const timeoutEntry = entries.find((e) => e.phase === "timeout");
		assert.ok(timeoutEntry, "auditor trace must include a timeout phase entry");
		assert.equal(timeoutEntry.verdictRecovered, "disapproved", "timeout entry must record verdictRecovered: 'disapproved'");

		const endEntry = entries.find((e) => e.phase === "end");
		assert.ok(endEntry, "auditor trace must record terminal phase 'end'");
		assert.equal(endEntry.disapproved, true);
		assert.equal(endEntry.error, undefined);
	});

	it("test-timeout-no-verdict: timeout fires with no verdict marker -> existing timeout error preserved", async () => {
		const incompleteOutput = "Still inspecting files...";
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "verification details",
			createSession: makeHangingStreamSession({
				textDeltas: [incompleteOutput],
			}),
		});

		assert.equal(result.approved, false, "result must not be approved");
		assert.equal(result.disapproved, true, "result must be disapproved on unrecovered timeout");
		assert.equal(result.timedOut, true, "timedOut flag must be true");
		assert.equal(result.recoveredFromTimeout, undefined, "recoveredFromTimeout must be undefined");
		assert.match(result.error ?? "", /Auditor timeout after 50ms/);

		// Trace verification
		const entries = readTraceEntries(cwd);
		const timeoutEntry = entries.find((e) => e.phase === "timeout");
		assert.ok(timeoutEntry, "auditor trace must include a timeout phase entry");
		assert.equal(timeoutEntry.verdictRecovered, null, "timeout entry must record verdictRecovered: null");

		const errorEntry = entries.find((e) => e.phase === "error");
		assert.ok(errorEntry, "auditor trace must record terminal phase 'error'");
		assert.match(errorEntry.error ?? "", /Auditor timeout after 50ms/);
	});
});
