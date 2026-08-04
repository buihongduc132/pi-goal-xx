/**
 * RED PHASE — auditor customTools allowlist gap.
 *
 * Bug: goal-auditor.ts passes `tools: resolved.tools.filter(...)` as the allowlist
 * to createAgentSession. pi-coding-agent's _refreshToolRegistry filters ALL tools
 * (including customTools) through `isAllowedTool(name)`. Since `early_disapprove`
 * and `report_auditor_progress` are NOT in `resolved.tools` (they're customTools),
 * they get filtered OUT — the auditor can't call them.
 *
 * Fix: add EARLY_DISAPPROVE_TOOL_NAME and REPORT_AUDITOR_PROGRESS_TOOL_NAME to
 * the tools allowlist.
 *
 * This test FAILS before fix, PASSES after.
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
		id: "g-allowlist-test",
		objective: "Test the allowlist",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-allowlist-"));
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

describe("Auditor customTools allowlist — early_disapprove and report_auditor_progress must be callable", () => {
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

	it("tools allowlist includes early_disapprove so auditor can call it", async () => {
		let capturedTools: string[] | undefined;

		const createSession = (sessionArgs: any) => {
			capturedTools = sessionArgs.tools;
			const session = {
				subscribe(_cb: any) { return () => {}; },
				prompt(_text: string): Promise<void> {
					return new Promise((resolve) => setTimeout(resolve, 5));
				},
				abort() { return Promise.resolve(); },
			};
			return Promise.resolve({ session });
		};

		await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Test",
			detailedSummary: "Test",
			createSession,
		});

		assert.ok(capturedTools, "tools allowlist must be passed to createSession");
		assert.ok(
			capturedTools!.includes("early_disapprove"),
			`tools allowlist must include "early_disapprove" so auditor can call it. Got: ${capturedTools!.join(", ")}`
		);
	});

	it("tools allowlist includes report_auditor_progress so auditor can call it", async () => {
		let capturedTools: string[] | undefined;

		const createSession = (sessionArgs: any) => {
			capturedTools = sessionArgs.tools;
			const session = {
				subscribe(_cb: any) { return () => {}; },
				prompt(_text: string): Promise<void> {
					return new Promise((resolve) => setTimeout(resolve, 5));
				},
				abort() { return Promise.resolve(); },
			};
			return Promise.resolve({ session });
		};

		await runGoalCompletionAuditor({
			ctx: makeCtx(tmpCwd),
			goal: makeGoal(),
			completionSummary: "Test",
			detailedSummary: "Test",
			createSession,
		});

		assert.ok(capturedTools, "tools allowlist must be passed to createSession");
		assert.ok(
			capturedTools!.includes("report_auditor_progress"),
			`tools allowlist must include "report_auditor_progress" so auditor can call it. Got: ${capturedTools!.join(", ")}`
		);
	});
});
