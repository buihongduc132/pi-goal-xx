/**
 * RED PHASE — auditor early-disapproval integration (LD1 + LD9, OT8, OT16).
 *
 * Spec: flow/findings/2026-07-31-auditor-capabilities-gaps/
 *   - 2026-07-31-locked-decisions.yaml → LD1 (auditor can abort mid-stream when it
 *     finds a disqualifying issue), LD9 (signal = tool call early_disapprove(reason))
 *   - 2026-07-31-open-threads.yaml → OT8 (Rank 1 CRITICAL: trigger on the
 *     `tool_execution_start` event for toolName === "early_disapprove", NOT on
 *     text_delta — text_delta matching false-positives on quoted <disapproved/>
 *     markers), OT16 (early abort must still capture text produced before the abort)
 * Plan: flow/plans/2026-07-31_pre-audit-hooks-and-early-disapprove.md (RED-B).
 *
 * Contract under test (GREEN implements in extensions/goal-auditor.ts):
 *  - GoalAuditorResult gains optional fields:
 *        earlyDisapproved?: boolean
 *        earlyDisapprovalReason?: string
 *  - In the session.subscribe callback, when an event arrives with
 *        type === "tool_execution_start" && toolName === "early_disapprove"
 *    the auditor captures event.args.reason, aborts the session, and marks the
 *    result as early-disapproved.
 *  - The returned result then has:
 *        approved === false, disapproved === true,
 *        earlyDisapproved === true, earlyDisapprovalReason === <the reason>
 *  - A normal audit (no early_disapprove call) still returns the parsed verdict
 *    (regression guard).
 *
 * Today these FAIL: the auditor neither detects the early_disapprove tool call nor
 * sets the new result fields, so earlyDisapproved is undefined and session.abort is
 * never called. Project `tsc --noEmit` stays green (tests excluded from tsconfig).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	runGoalCompletionAuditor,
	type GoalAuditorResult,
} from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

/**
 * The result shape the GREEN implementation must expose. Declared locally so the
 * test type-checks today and so the new fields are explicit; when GREEN adds the
 * fields to GoalAuditorResult this intersection stays valid.
 */
type GoalAuditorResultWithEarlyDisapprove = GoalAuditorResult & {
	earlyDisapproved?: boolean;
	earlyDisapprovalReason?: string;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-early-disapprove",
		objective: "Build the thing for real",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-early-disapprove-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

// Typed as `any` to mirror the partial-mock pattern in auditor-g4-followup.test.ts:
// ExtensionContext has ~15 fields; we only need cwd/model/modelRegistry for the audit.
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

interface EventLike {
	type: string;
	[key: string]: unknown;
}

interface SessionLike {
	subscribe(cb: (event: EventLike) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void> | void;
}

/**
 * Mock createSession that, on the first prompt, emits a `tool_execution_start`
 * event for `early_disapprove` carrying the given reason (the OT8 trigger).
 *
 * Optionally emits assistant text (message_end) BEFORE the tool call so we can
 * assert OT16: the result must still capture text produced before the abort.
 *
 * abort() mirrors real pi-agent-core behavior: it causes the in-flight prompt()
 * promise to resolve. It also records that it was called so the test can assert
 * the auditor actually aborted on the OT8 trigger.
 *
 * A short safety-net timeout resolves the first prompt regardless, so in the RED
 * state (no detection wired yet) the test fails on its assertions instead of
 * hanging until the auditor timeout.
 */
// Factory typed as `any` (matches auditor-g4-followup.test.ts createSession mock):
// runGoalCompletionAuditor expects typeof createAgentSession; we provide a partial mock.
function makeEarlyDisapproveCreateSession(opts: {
	reason: string;
	preAbortText?: string;
	abortCalls: { count: number };
}): any {
	let storedCb: ((event: EventLike) => void) | null = null;
	let firstPromptResolve: ((v: void) => void) | null = null;
	let promptCount = 0;

	const session: SessionLike = {
		subscribe(cb: (event: EventLike) => void) {
			storedCb = cb;
			return () => { storedCb = null; };
		},
		prompt(_text: string): Promise<void> {
			promptCount++;
			return new Promise<void>((resolve) => {
				if (promptCount > 1) {
					// G4 verdict follow-up (or any later prompt): resolve promptly, no events.
					setTimeout(resolve, 5);
					return;
				}
				firstPromptResolve = resolve;
				setTimeout(() => {
					// OT16: optionally surface assistant text produced before the abort.
					if (opts.preAbortText && storedCb) {
						storedCb({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: opts.preAbortText }],
							},
						});
					}
					// OT8 trigger: the early_disapprove tool call. This is the ONLY signal
					// the auditor may act on for early disapproval. (Watching text_delta
					// for <disapproved/> is the REJECTED approach — see OT8.)
					if (storedCb) {
						storedCb({
							type: "tool_execution_start",
							toolName: "early_disapprove",
							toolCallId: "tc-early-disapprove-1",
							args: { reason: opts.reason },
						});
					}
					// Safety net: if the auditor never calls abort() (current RED state),
					// still resolve so the test fails on assertions, not on a timeout.
					setTimeout(() => { resolve(); }, 50);
				}, 10);
			});
		},
		abort(): Promise<void> | void {
			opts.abortCalls.count++;
			// Real behavior: abort() unblocks the in-flight prompt().
			if (firstPromptResolve) {
				const r = firstPromptResolve;
				firstPromptResolve = null;
				r();
			}
			return Promise.resolve();
		},
	};

	return () => Promise.resolve({ session });
}

/**
 * Mock createSession for the regression case: a normal audit that ends with a
 * verdict and never calls early_disapprove.
 */
// Factory typed as `any` — partial mock of createAgentSession (see makeCtx note).
function makeNormalVerdictCreateSession(verdictMarker: "<approved/>" | "<disapproved/>"): any {
	let storedCb: ((event: EventLike) => void) | null = null;
	let promptCount = 0;
	const session: SessionLike = {
		subscribe(cb: (event: EventLike) => void) {
			storedCb = cb;
			return () => { storedCb = null; };
		},
		prompt(_text: string): Promise<void> {
			promptCount++;
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					if (storedCb) {
						storedCb({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: `Audit report body.\n\n${verdictMarker}` }],
							},
						});
					}
					resolve();
				}, 10);
			});
		},
		abort() { return Promise.resolve(); },
	};
	return () => Promise.resolve({ session });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Auditor early-disapproval — OT8 trigger via tool_execution_start", () => {
	let tmpCwd: string;
	let origCwd: string;

	beforeEach(() => {
		origCwd = process.cwd();
		tmpCwd = makeTmpCwd();
		process.chdir(tmpCwd);
	});

	afterEach(() => {
		process.chdir(origCwd);
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("aborts the session and marks the result early-disapproved when early_disapprove is called", async () => {
		const reason = "fundamental objective unmet — only a scaffold exists, not the real artifact";
		const abortCalls = { count: 0 };

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeEarlyDisapproveCreateSession({ reason, abortCalls }),
		}) as GoalAuditorResultWithEarlyDisapprove;

		// OT8: the abort must fire on the tool_execution_start event for early_disapprove.
		assert.ok(abortCalls.count >= 1, "session.abort() must be called when early_disapprove fires");
		// Result fields (LD1 / LD9).
		assert.equal(result.earlyDisapproved, true, "result.earlyDisapproved must be true");
		assert.equal(result.earlyDisapprovalReason, reason, "result.earlyDisapprovalReason must carry the structured reason");
		assert.equal(result.approved, false, "early disapproval is not an approval");
		assert.equal(result.disapproved, true, "early disapproval counts as disapproved");
	});

	it("does NOT rely on text_delta for the trigger (regression vs the rejected OT1 approach)", async () => {
		// The mock emits ONLY a tool_execution_start event — no <disapproved/> text
		// anywhere. If the auditor were watching text_delta (the rejected approach),
		// it would NOT abort here and earlyDisapproved would stay undefined.
		const reason = "no text marker present — trigger must come from the tool call only";
		const abortCalls = { count: 0 };

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeEarlyDisapproveCreateSession({ reason, abortCalls }),
		}) as GoalAuditorResultWithEarlyDisapprove;

		assert.ok(abortCalls.count >= 1, "abort must be driven by the tool call, not by any text");
		assert.equal(result.earlyDisapproved, true);
		assert.equal(result.earlyDisapprovalReason, reason);
	});
});

describe("Auditor early-disapproval — OT16: text produced before the abort is captured", () => {
	let tmpCwd: string;
	let origCwd: string;

	beforeEach(() => {
		origCwd = process.cwd();
		tmpCwd = makeTmpCwd();
		process.chdir(tmpCwd);
	});

	afterEach(() => {
		process.chdir(origCwd);
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("result.output includes assistant text streamed before the early_disapprove call", async () => {
		const reason = "disqualifying issue found after partial analysis";
		const preAbortText = "PARTIAL-EVIDENCE-MARKER: inspected src/main.ts and found only stubs.";
		const abortCalls = { count: 0 };

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeEarlyDisapproveCreateSession({ reason, preAbortText, abortCalls }),
		}) as GoalAuditorResultWithEarlyDisapprove;

		assert.equal(result.earlyDisapproved, true, "still early-disapproved");
		assert.equal(result.earlyDisapprovalReason, reason);
		assert.ok(
			result.output.includes("PARTIAL-EVIDENCE-MARKER"),
			"output must capture text produced before the abort (OT16)",
		);
	});
});

describe("Auditor early-disapproval — regression: normal audit still works", () => {
	let tmpCwd: string;
	let origCwd: string;

	beforeEach(() => {
		origCwd = process.cwd();
		tmpCwd = makeTmpCwd();
		process.chdir(tmpCwd);
	});

	afterEach(() => {
		process.chdir(origCwd);
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("approves normally when the auditor ends with <approved/> and never calls early_disapprove", async () => {
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeNormalVerdictCreateSession("<approved/>"),
		}) as GoalAuditorResultWithEarlyDisapprove;

		assert.equal(result.approved, true, "normal approval must still work");
		assert.equal(result.disapproved, false);
		assert.ok(!result.earlyDisapproved, "earlyDisapproved must be absent/falsy on a normal audit");
		assert.equal(result.earlyDisapprovalReason, undefined, "no early-disapproval reason on a normal audit");
	});

	it("disapproves normally (parsed verdict) without engaging the early-disapproval path", async () => {
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeNormalVerdictCreateSession("<disapproved/>"),
		}) as GoalAuditorResultWithEarlyDisapprove;

		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(!result.earlyDisapproved, "a parsed <disapproved/> verdict is NOT an early disapproval");
	});
});
