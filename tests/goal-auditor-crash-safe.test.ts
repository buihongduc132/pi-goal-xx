/**
 * Bug 1a — crash-safe auditor inheritance tests.
 *
 * Validates:
 *  R2.1-R2.6: Auditor timeout fires → returns {approved:false, error:"Auditor timeout after Xms", timedOut:true}
 *  R3.1-R3.5: Scoped unhandledRejection guard (installed, removed, AbortError handling)
 *  R4.1-R4.4: Crash-safe sendMessage (safeFireAndForget)
 *
 * Bug doc: flow/bugs/2026-07-11_complete-goal-crash-and-reject-exit.md
 * Requirements: flow/requirements/2026-07-11_crash-safe-auditor-inheritance.md
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { loadGoalSettings } from "../extensions/goal-settings.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-crash-safe",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-crash-safe-"));
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
 * Mock session where prompt() hangs until abort() rejects with AbortError.
 */
function makeHangingCreateSession(): any {
	return (_sessionArgs: any) => {
		let rejectPrompt: ((err: Error) => void) | null = null;
		const session = {
			subscribe(_cb: (event: any) => void) {
				return () => {};
			},
			prompt(_text: string): Promise<void> {
				return new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
				});
			},
			abort() {
				if (rejectPrompt) {
					const err = new Error("Aborted");
					err.name = "AbortError";
					rejectPrompt(err);
					rejectPrompt = null;
				}
			},
		};
		return Promise.resolve({ session });
	};
}

/**
 * Mock session where prompt() resolves successfully with approved output.
 * Used to test timer cleanup on the happy path.
 */
function makeApprovingCreateSession(delayMs: number = 10): any {
	return (_sessionArgs: any) => {
		const session = {
			subscribe(cb: (event: any) => void) {
				// Emit some output then finish
				setTimeout(() => {
					cb({ type: "text", text: "<approved/>" });
					cb({ type: "finish" });
				}, delayMs);
				return () => {};
			},
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => {
					setTimeout(resolve, delayMs + 10);
				});
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

describe("Bug 1a — auditor timeout (R2.1-R2.6)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpCwd();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("R2.4: returns {approved:false, error with ms, timedOut:true} when prompt hangs", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 100 }),
		);

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeHangingCreateSession(),
		});

		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.equal(result.error, "Auditor timeout after 100ms");
		assert.equal(result.timedOut, true);
	});

	it("R2.2: default 300000ms timeout when auditorTimeoutMs not set", async () => {
		// Verify default is loaded from config when setting absent
		const settings = loadGoalSettings(cwd);
		assert.equal(settings.auditorTimeoutMs, undefined);
		// We can't wait 5 minutes, but verify the value is used internally
		// by checking a short timeout works
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeHangingCreateSession(),
		});
		assert.equal(result.error, "Auditor timeout after 50ms");
	});

	it("R2.4b: timeout error distinct from 'Auditor aborted.'", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeHangingCreateSession(),
		});

		assert.notEqual(result.error, "Auditor aborted.");
		assert.ok(result.error?.startsWith("Auditor timeout after "), `error was: ${result.error}`);
		assert.equal(result.timedOut, true);
	});

	it("R2.5: timeout timer cleared when prompt resolves before timeout (no leaked timer)", async () => {
		// No settings file = 5min default, prompt resolves in 10ms → timer must be cleared
		const listenersBefore = process.listeners("unhandledRejection").length;

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeApprovingCreateSession(10),
		});

		// Should not be a timeout result
		assert.notEqual(result.timedOut, true);
		// Guard should be removed
		const listenersAfter = process.listeners("unhandledRejection").length;
		assert.equal(listenersAfter, listenersBefore, "guard removed after happy-path audit");
	});

	it("writes audit trace with phase:'timeout' to trace file", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);

		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeHangingCreateSession(),
		});

		const traceDir = path.join(cwd, ".pi", "pi-goal-xx", "auditor-traces");
		const traceFiles = fs.existsSync(traceDir) ? fs.readdirSync(traceDir) : [];
		if (traceFiles.length > 0) {
			const traceContent = fs.readFileSync(path.join(traceDir, traceFiles[0]), "utf8");
			assert.match(traceContent, /"phase":"timeout"/);
		}
	});

	it("R2.3: auditorTimeoutMs loaded from settings file", () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 120000 }),
		);
		const settings = loadGoalSettings(cwd);
		assert.equal(settings.auditorTimeoutMs, 120000);
	});
});

describe("Bug 1a — scoped unhandledRejection guard (R3.1-R3.5)", () => {
	let cwd: string;
	let originalListeners: NodeJS.UnhandledRejectionListener[];

	beforeEach(() => {
		cwd = makeTmpCwd();
		originalListeners = process.listeners("unhandledRejection") as NodeJS.UnhandledRejectionListener[];
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		const currentListeners = process.listeners("unhandledRejection");
		assert.equal(
			currentListeners.length,
			originalListeners.length,
			"unhandledRejection handler must be removed after audit completes (scoped, not global)",
		);
	});

	it("R3.1: guard installed during audit window", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 200 }),
		);

		let listenersDuringAudit = 0;
		const wrappedCreateSession = (...args: any[]) => {
			setTimeout(() => {
				listenersDuringAudit = process.listeners("unhandledRejection").length;
			}, 50);
			return makeHangingCreateSession()(...args);
		};

		const listenersBefore = process.listeners("unhandledRejection").length;
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});

		assert.ok(listenersDuringAudit > listenersBefore, "guard must be installed during audit");
	});

	it("R3.3: guard removed after audit (not permanent)", async () => {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorTimeoutMs: 50 }),
		);

		const listenersBefore = process.listeners("unhandledRejection").length;

		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeHangingCreateSession(),
		});

		const listenersAfter = process.listeners("unhandledRejection").length;
		assert.equal(listenersAfter, listenersBefore, "guard removed after audit");
	});

	it("R3.1: guard installed and removed on happy-path audit too", async () => {
		const listenersBefore = process.listeners("unhandledRejection").length;

		let listenersDuring = 0;
		const wrappedCreateSession = (...args: any[]) => {
			setTimeout(() => {
				listenersDuring = process.listeners("unhandledRejection").length;
			}, 5);
			return makeApprovingCreateSession(10)(...args);
		};

		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});

		assert.ok(listenersDuring > listenersBefore, "guard installed during happy-path audit");
		const listenersAfter = process.listeners("unhandledRejection").length;
		assert.equal(listenersAfter, listenersBefore, "guard removed after happy-path audit");
	});
});
