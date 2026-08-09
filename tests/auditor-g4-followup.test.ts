/**
 * G4 — Auditor empty-output follow-up test.
 *
 * Validates that when the auditor receives no text output from the main
 * session (e.g., reasoning model produces thinking but no verdict), it
 * sends a follow-up prompt to force a verdict.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { loadGoalSettings } from "../extensions/goal-settings.ts";
import { isolatedSettingsEnv } from "./_test-helpers.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-g4-test",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-g4-"));
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
 * Mock session that produces NO text on first prompt (simulating reasoning model
 * that only produces thinking), then produces verdict on second prompt.
 */
function makeEmptyThenVerdictCreateSession(): any {
	let promptCount = 0;
	let storedCb: ((event: any) => void) | null = null;
	return (_sessionArgs: any) => {
		const session = {
			subscribe(cb: (event: any) => void) {
				storedCb = cb;
				return () => {};
			},
			prompt(_text: string): Promise<void> {
				promptCount++;
				return new Promise<void>((resolve) => {
					if (promptCount === 1) {
						// First prompt: no text output (empty response)
						setTimeout(resolve, 10);
					} else {
						// Second prompt (G4 follow-up): produce verdict via message_end
						setTimeout(() => {
							if (storedCb) {
								storedCb({
									type: "message_end",
									message: {
										role: "assistant",
										content: [{ type: "text", text: "<approved/>" }],
									},
								});
							}
							resolve();
						}, 10);
					}
				});
			},
			abort() {
				return Promise.resolve();
			},
		};
		return Promise.resolve({ session });
	};
}

describe("G4 — Auditor empty-output follow-up", () => {
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

	it("sends follow-up prompt when main session produces no text", async () => {
		const goal = makeGoal();
		const ctx = makeCtx(tmpCwd);

		const result = await runGoalCompletionAuditor({
			ctx,
			goal,
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeEmptyThenVerdictCreateSession(),
		});

		// Should have approved after G4 follow-up
		assert.equal(result.approved, true, "Should approve after G4 follow-up");
		assert.equal(result.disapproved, false, "Should not disapprove");
		assert.ok(result.output.includes("<approved/>"), "Output should contain <approved/>");
	});
});
