/**
 * G5 — Auditor reasoning-budget exhaustion detection.
 *
 * 2026-09-02 incident: role-smart (glm-5.3 via LiteLLM router) spent the ENTIRE
 * completion budget on reasoning_content, producing 0 bytes of text. The G4
 * follow-up fired, the model again returned reasoning-only, and the final
 * result was a SILENT {approved:false, disapproved:true} with no error —
 * indistinguishable from a real disapproval. The user perceived "auditor
 * disabled".
 *
 * Industry precedent: hermes-agent PR #96973 / issue #83915 — detect
 * (empty text + non-empty structured reasoning + no tool calls) as
 * reasoning-budget EXHAUSTION, a distinct failure class from truncation and
 * from genuine disapproval.
 *
 * Contract (this file defines the EXPECTED behavior; RED until implemented):
 *   When the auditor session streams thinking deltas but never produces text
 *   (even after the G4 follow-up), the result MUST:
 *     1. carry error = "Auditor reasoning budget exhausted (no text output)"
 *     2. NOT be treated as a genuine disapproval marker parse
 *     3. be visible in the auditor trace (phase "end" with the error field)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { isolatedSettingsEnv } from "./_test-helpers.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-g5-test",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-g5-"));
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
 * Mock session that streams ONLY thinking deltas — never text — on EVERY
 * prompt (main + G4 follow-up). This is the exact role-smart/glm-5.3 shape:
 * finish_reason=length with reasoning_content populated, content empty.
 */
function makeReasoningOnlyCreateSession(thinkingCharCount = 5000): any {
	let storedCb: ((event: any) => void) | null = null;
	const fire = (e: any) => storedCb?.(e);
	return (_sessionArgs: any) => {
		const session = {
			subscribe(cb: (event: any) => void) {
				storedCb = cb;
				return () => {};
			},
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						// Structured reasoning flows (the "thinking" channel)...
						fire({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
						fire({
							type: "message_update",
							assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(thinkingCharCount) },
						});
						fire({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
						// ...but message ends with NO text content at all.
						fire({
							type: "message_end",
							message: { role: "assistant", content: [] },
						});
						resolve();
					}, 10);
				});
			},
			abort() {
				return Promise.resolve();
			},
		};
		return Promise.resolve({ session });
	};
}

describe("G5 — Auditor reasoning-budget exhaustion detection", () => {
	let tmpCwd: string;
	let origCwd: string;
	let origEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		origCwd = process.cwd();
		tmpCwd = makeTmpCwd();
		process.chdir(tmpCwd);
		// Isolate from the real ~/.pi/pi-goal-xx-settings.json (would inject
		// a provider/model that the mock modelRegistry cannot resolve).
		origEnv = { ...process.env };
		Object.assign(process.env, isolatedSettingsEnv());
	});

	afterEach(() => {
		process.chdir(origCwd);
		process.env = origEnv;
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("classifies thinking-only + text-empty output as exhaustion error, not silent disapprove", async () => {
		const goal = makeGoal();
		const ctx = makeCtx(tmpCwd);

		const result = await runGoalCompletionAuditor({
			ctx,
			goal,
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession: makeReasoningOnlyCreateSession(),
		});

		// Exhaustion MUST surface as a classified error...
		assert.ok(
			typeof result.error === "string" && /exhaust/i.test(result.error),
			`expected exhaustion error, got: ${JSON.stringify(result.error)}`,
		);
		// ...NOT as a marker-parsed verdict. Neither approved nor the silent
		// disapprove-from-empty-output shape is acceptable here.
		assert.equal(result.approved, false, "must not approve");
		assert.equal(result.disapproved, false, "must NOT report marker-disapproval for empty output (that is exhaustion)");
	});

	it("does NOT classify empty-output-without-thinking as exhaustion (pure infra failure stays as-is)", async () => {
		const goal = makeGoal();
		const ctx = makeCtx(tmpCwd);

		// No thinking deltas at all AND no text — e.g. network-dead session.
		// This is NOT exhaustion; behavior for this shape is unchanged by G5.
		let storedCb: ((event: any) => void) | null = null;
		const createSession = (_a: any) => {
			const session = {
				subscribe(cb: (event: any) => void) {
					storedCb = cb;
					return () => {};
				},
				prompt(_t: string) {
					return new Promise<void>((resolve) => {
						setTimeout(() => {
							storedCb?.({ type: "message_end", message: { role: "assistant", content: [] } });
							resolve();
						}, 10);
					});
				},
				abort() {
					return Promise.resolve();
				},
			};
			return Promise.resolve({ session });
		};

		const result = await runGoalCompletionAuditor({
			ctx,
			goal,
			completionSummary: "Done",
			detailedSummary: "All tasks complete",
			createSession,
		});

		assert.ok(!(/exhaust/i.test(String(result.error ?? ""))), "no thinking evidence → not exhaustion");
	});
});
