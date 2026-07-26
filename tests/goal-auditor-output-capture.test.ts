/**
 * Regression tests for auditor output capture.
 *
 * Bug: auditor produced output (8660 bytes with <disapproved/>) but 4 of 5
 * audit attempts showed empty output to user. Root cause: text_end handler
 * used ?? (nullish coalescing) instead of ||, so empty string content didn't
 * fall back to partial.content[0].text. Plus no fallback when text_end never
 * fires (model stuck in tool loop).
 *
 * Fix: accumulate text_delta events into textDeltaAccum buffer, change ?? to ||
 * logic, use accumulated deltas if outputParts empty before computing output.
 *
 * Evidence: beet-orches goal ms1gpeuc-ocpq37 auditor-trace.jsonl shows 5 attempts,
 * first 4 report_len=0, 5th report_len=8660 with <disapproved/>.
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
		id: "g-output-capture",
		objective: "Test output capture",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-output-capture-"));
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
 * Mock session that emits events in the real pi-core format:
 * - message_update with assistantMessageEvent: { type: "text_end", content, partial }
 * - message_update with assistantMessageEvent: { type: "text_delta", delta }
 * - message_end with message: { role: "assistant", content: [{ type: "text", text }] }
 */
function makeEventEmittingCreateSession(events: any[]): any {
	return (_sessionArgs: any) => {
		const session = {
			subscribe(cb: (event: any) => void) {
				// Emit events synchronously
				for (const event of events) {
					cb(event);
				}
				return () => {};
			},
			prompt(_text: string): Promise<void> {
				return Promise.resolve();
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

describe("Auditor output capture — text_end with empty content", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpCwd();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("captures output from partial.content[0].text when text_end.content is empty string", async () => {
		// Simulate text_end firing with content="" but partial.content[0].text has the verdict
		const events = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_end",
					content: "", // Empty string — should fall back to partial
					partial: {
						content: [{ type: "text", text: "## Audit Report\n\n<disapproved/>" }],
					},
				},
			},
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		// Should capture output from partial.content[0].text
		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<disapproved/>"), "output should contain verdict");
		assert.equal(result.disapproved, true, "should parse disapproved verdict");
	});

	it("captures output from partial.content[0].text when text_end.content is whitespace-only", async () => {
		const events = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_end",
					content: "   \n\t  ", // Whitespace-only — should fall back to partial
					partial: {
						content: [{ type: "text", text: "## Audit\n\n<approved/>" }],
					},
				},
			},
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<approved/>"), "output should contain verdict");
		assert.equal(result.approved, true, "should parse approved verdict");
	});
});

describe("Auditor output capture — missing text_end event", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpCwd();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("captures output from text_delta accumulation when text_end never fires", async () => {
		// Simulate model producing text through deltas but never firing text_end
		// (observed with some LiteLLM-proxied models stuck in tool-calling loops)
		const events = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "## Audit Report\n\n",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "The objective is not satisfied.\n\n",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "<disapproved/>",
				},
			},
			// No text_end event — model ended without finalizing text
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		// Should capture output from accumulated deltas
		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<disapproved/>"), "output should contain verdict");
		assert.equal(result.disapproved, true, "should parse disapproved verdict");
	});

	it("captures output from text_delta when only partial text is produced", async () => {
		const events = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Partial audit: ",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "<approved/>",
				},
			},
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<approved/>"), "output should contain verdict");
		assert.equal(result.approved, true, "should parse approved verdict");
	});
});

describe("Auditor output capture — message_end fallback", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpCwd();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("captures output from message_end when text_end and text_delta both absent", async () => {
		// Simulate model producing only message_end with final content
		const events = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "## Final Report\n\n<approved/>" }],
				},
			},
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<approved/>"), "output should contain verdict");
		assert.equal(result.approved, true, "should parse approved verdict");
	});
});

describe("Auditor output capture — combined events", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpCwd();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("prefers text_end.content when non-empty, ignores text_delta accumulation", async () => {
		// Simulate normal flow: text_delta events + text_end with content
		const events = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Partial text that should be ignored",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_end",
					content: "## Final Report\n\n<disapproved/>",
					partial: {
						content: [{ type: "text", text: "Should not use this" }],
					},
				},
			},
		];

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "Goal: Test output capture",
			createSession: makeEventEmittingCreateSession(events),
		});

		assert.ok(result.output.length > 0, "output should not be empty");
		assert.ok(result.output.includes("<disapproved/>"), "output should contain verdict");
		assert.ok(result.output.includes("Final Report"), "output should contain text_end content");
		assert.equal(result.disapproved, true, "should parse disapproved verdict");
	});
});
