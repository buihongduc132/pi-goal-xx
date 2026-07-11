/**
 * G1-G7 crash/break vector tests for pi-goal-xx.
 *
 * TDD: written RED-first against the intended fixed behavior.
 * See task: "FIX G1-G7 CRASH/BREAK VECTORS IN pi-goal-xx".
 *
 *  G1 (CRASH)      : unhandledRejection + uncaughtException guards installed
 *                    BEFORE createSession (host extensions fire onLoad during it).
 *  G2 (DEGRADE)    : process handlers registered during the audit window are
 *                    removed after the audit completes (mitigation, not full fix).
 *  G3 (LEAK)       : session references cleared / unsubscribe called post-audit,
 *                    including on the createSession-failure path.
 *  G4 (CORRUPT)    : writeActiveGoalFile failures are caught + surfaced, not
 *                    thrown into the caller's control flow.
 *  G5 (DISK FILL)  : auditor-trace.jsonl + goal_events.jsonl rotate at a size
 *                    cap (keep last N rotations).
 *  G6 (MEMORY)     : oversized objective / verificationSummary / completionSummary
 *                    are rejected with a clear error.
 *  G7 (MEMORY)     : serialized-send chain resets to a fresh Promise after drain
 *                    (bounded memory growth).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import { logAuditorTrace, auditorTraceLogPath } from "../extensions/auditor-log.ts";
import { appendGoalEvent, GOAL_LEDGER_FILE } from "../extensions/goal-ledger.ts";
import { validateGoalDraftProposal } from "../extensions/goal-draft.ts";
import { validateVerificationSummary, validateFieldLength } from "../extensions/goal-policy.ts";
import { writeActiveGoalFileSafe } from "../extensions/storage/goal-files.ts";
import { SerializedSender } from "../extensions/serialized-send.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-g17",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-g17-"));
	fs.mkdirSync(path.join(tmp, ".pi", "goals"), { recursive: true });
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

/** createSession mock: records whether guards are registered SYNCHRONOUSLY at call time. */
function makeGuardProbingCreateSession(probe: { rejectionSeen: boolean; exceptionSeen: boolean; called: boolean }): any {
	return (_sessionArgs: any) => {
		probe.called = true;
		// Synchronous check: are our guards already installed BEFORE createSession runs?
		probe.rejectionSeen = process.listeners("unhandledRejection").length > 0;
		probe.exceptionSeen = process.listeners("uncaughtException").length > 0;
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> { return Promise.resolve(); },
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

// ── G1: guards installed before createSession ───────────────────────────────

describe("G1 — process guards installed BEFORE createSession", () => {
	let cwd: string;
	let baselineRej: number;
	let baselineExc: number;

	beforeEach(() => {
		cwd = makeTmpCwd();
		baselineRej = process.listeners("unhandledRejection").length;
		baselineExc = process.listeners("uncaughtException").length;
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		const rejNow = process.listeners("unhandledRejection").length;
		const excNow = process.listeners("uncaughtException").length;
		assert.equal(rejNow, baselineRej, "unhandledRejection handler leaked");
		assert.equal(excNow, baselineExc, "uncaughtException handler leaked");
	});

	it("unhandledRejection guard registered before createSession is invoked", async () => {
		const probe = { rejectionSeen: false, exceptionSeen: false, called: false };
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeGuardProbingCreateSession(probe),
		});
		assert.equal(probe.called, true, "createSession was never called");
		assert.equal(probe.rejectionSeen, true,
			"G1: unhandledRejection guard must be installed BEFORE createSession runs (host extensions fire onLoad during createSession)");
	});

	it("uncaughtException guard registered before createSession is invoked", async () => {
		const probe = { rejectionSeen: false, exceptionSeen: false, called: false };
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeGuardProbingCreateSession(probe),
		});
		assert.equal(probe.exceptionSeen, true,
			"G1: uncaughtException guard must be installed BEFORE createSession runs");
	});
});

// ── G2: handlers added during audit removed after ───────────────────────────

describe("G2 — process handlers added during audit are removed after", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("no net new unhandledRejection/uncaughtException listeners after a happy-path audit", async () => {
		const rejBefore = process.listeners("unhandledRejection").length;
		const excBefore = process.listeners("uncaughtException").length;

		const approving = (_args: any) => {
			const session = {
				subscribe(cb: (event: any) => void) {
					setTimeout(() => { cb({ type: "text", text: "<approved/>" }); cb({ type: "finish" }); }, 5);
					return () => {};
				},
				prompt(_text: string): Promise<void> { return new Promise((r) => setTimeout(r, 15)); },
				abort() {},
			};
			return Promise.resolve({ session });
		};

		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: approving,
		});

		assert.equal(process.listeners("unhandledRejection").length, rejBefore,
			"G2: unhandledRejection handler added during audit must be removed");
		assert.equal(process.listeners("uncaughtException").length, excBefore,
			"G2: uncaughtException handler added during audit must be removed");
	});
});

// ── G3: session references cleared post-audit ───────────────────────────────

describe("G3 — session subscription released post-audit (incl. createSession failure)", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("no handler leaked even when createSession throws (early-return path)", async () => {
		const failing = (_args: any) => Promise.reject(new Error("boom-on-create"));
		const rejBefore = process.listeners("unhandledRejection").length;
		const excBefore = process.listeners("uncaughtException").length;

		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: failing,
		});
		assert.equal(result.error && result.error.includes("boom-on-create"), true,
			"createSession error should surface");
		assert.equal(process.listeners("unhandledRejection").length, rejBefore,
			"G3: handler leaked on createSession-failure early-return path");
		assert.equal(process.listeners("uncaughtException").length, excBefore,
			"G3: uncaughtException handler leaked on createSession-failure path");
	});

	it("unsubscribe spy called after happy-path audit", async () => {
		let unsubscribeCalled = false;
		const approving = (_args: any) => {
			const session = {
				subscribe(_cb: (event: any) => void) {
					return () => { unsubscribeCalled = true; };
				},
				prompt(_text: string): Promise<void> { return new Promise((r) => setTimeout(r, 10)); },
				abort() {},
			};
			return Promise.resolve({ session });
		};
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: approving,
		});
		assert.equal(unsubscribeCalled, true, "G3: unsubscribe must be called after audit completes");
	});
});

// ── G4: writeActiveGoalFile failure caught + surfaced ───────────────────────

describe("G4 — writeActiveGoalFile failure is caught and surfaced", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("writeActiveGoalFileSafe swallows the throw and reports { ok:false }", () => {
		const ctx: any = { cwd };
		// Make the goals dir a regular file so the write path blows up.
		fs.rmSync(path.join(cwd, ".pi", "goals"), { recursive: true, force: true });
		fs.writeFileSync(path.join(cwd, ".pi", "goals"), "blocker", "utf8");
		const goal = makeGoal();
		const res = writeActiveGoalFileSafe(ctx, goal);
		assert.equal(res.ok, false, "G4: writeActiveGoalFileSafe must return ok:false on write failure, not throw");
		assert.ok(res.error, "G4: error message must be present");
	});

	it("writeActiveGoalFileSafe returns ok:true and the written goal on success", () => {
		const ctx: any = { cwd };
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		const res = writeActiveGoalFileSafe(ctx, makeGoal());
		assert.equal(res.ok, true);
		assert.ok(res.goal);
	});
});

// ── G5: trace + ledger rotation at cap ──────────────────────────────────────

describe("G5 — trace/ledger files rotate at size cap", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("auditor-trace rotates when exceeding cap (rotated .1 file appears)", () => {
		const tracePath = auditorTraceLogPath(cwd);
		// Force a rotation by writing past the 10MB cap. Each line is ~3KB.
		for (let i = 0; i < 5000; i++) {
			logAuditorTrace(cwd, { ts: new Date().toISOString(), phase: "event", i, pad: "x".repeat(3000) });
		}
		const dir = path.dirname(tracePath);
		const entries = fs.readdirSync(dir);
		const rotated = entries.some((e) => /auditor-trace\.jsonl\.\d+/.test(e));
		assert.ok(rotated, `G5: expected a rotated auditor-trace file under ${dir}, got: ${entries.join(", ")}`);
		const stat = fs.statSync(tracePath);
		assert.ok(stat.size < 12 * 1024 * 1024, `G5: active trace file too large after rotation: ${stat.size}`);
	});

	it("goal_events ledger rotates when exceeding cap", () => {
		const ledgerPath = path.join(cwd, GOAL_LEDGER_FILE);
		for (let i = 0; i < 5000; i++) {
			appendGoalEvent({ cwd }, { type: "goal_focused", goalId: "g", reason: "x".repeat(3000), at: new Date().toISOString() });
		}
		const dir = path.dirname(ledgerPath);
		const entries = fs.readdirSync(dir);
		const rotated = entries.some((e) => /goal_events\.jsonl\.\d+/.test(e));
		assert.ok(rotated, `G5: expected a rotated goal_events file under ${dir}, got: ${entries.join(", ")}`);
	});
});

// ── G6: oversized fields rejected ───────────────────────────────────────────

describe("G6 — oversized objective/summaries rejected", () => {
	it("propose_goal_draft rejects an oversized objective", () => {
		const huge = "a".repeat(60_000);
		const res = validateGoalDraftProposal({
			intent: { focus: "goal", originalTopic: "t" },
			hasUnfinishedGoal: false,
			objective: huge,
			sisyphus: false,
		});
		assert.equal(res.ok, false);
		assert.ok((res as { message: string }).message.toLowerCase().includes("large") || (res as { message: string }).message.toLowerCase().includes("long") || (res as { message: string }).message.toLowerCase().includes("size") || (res as { message: string }).message.toLowerCase().includes("exceed"),
			`G6: rejection message should explain size, got: ${(res as { message: string }).message}`);
	});

	it("propose_goal_draft accepts a normal objective", () => {
		const res = validateGoalDraftProposal({
			intent: { focus: "goal", originalTopic: "t" },
			hasUnfinishedGoal: false,
			objective: "Build a small CLI tool",
			sisyphus: false,
		});
		assert.equal(res.ok, true);
	});

	it("validateVerificationSummary rejects an oversized summary", () => {
		const huge = "z".repeat(60_000);
		const res = validateVerificationSummary({ verificationContract: "do it", verificationSummary: huge });
		assert.equal(res.ok, false);
	});

	it("validateFieldLength rejects an oversized completionSummary via the shared cap", () => {
		const res = validateFieldLength("q".repeat(60_000), 50_000, "completionSummary");
		assert.equal(res.ok, false);
	});
});

// ── G7: serialized-send chain resets after drain ────────────────────────────

describe("G7 — SerializedSender resets chain after drain", () => {
	it("isIdle() is true initially and after sends drain", async () => {
		const s = new SerializedSender();
		assert.equal(s.isIdle(), true);
		const tasks: Promise<unknown>[] = [];
		for (let i = 0; i < 50; i++) {
			tasks.push(s.serializedSend(() => new Promise((r) => setTimeout(r, 1))));
		}
		await Promise.all(tasks);
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(s.isIdle(), true, "G7: sender must be idle (chain reset) after all sends resolve");
	});

	it("pendingCount returns to 0 and stays idle across many waves", async () => {
		const s = new SerializedSender();
		for (let wave = 0; wave < 10; wave++) {
			const waveTasks: Promise<unknown>[] = [];
			for (let i = 0; i < 20; i++) {
				waveTasks.push(s.serializedSend(() => new Promise((r) => setTimeout(r, 1))));
			}
			await Promise.all(waveTasks);
			await new Promise((r) => setTimeout(r, 2));
		}
		assert.equal(s.pendingCount(), 0, "G7: pendingCount must return to 0 after drain");
		assert.equal(s.isIdle(), true, "G7: chain must reset to fresh after each drain");
	});
});
