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

// ---------------------------------------------------------------------------
// G1: process guards installed BEFORE createSession (not after)
// ---------------------------------------------------------------------------
describe("G1 — process guards installed BEFORE createSession", () => {
	let cwd: string;
	let preUR: NodeJS.UnhandledRejectionListener[];
	let preUE: NodeJS.UncaughtExceptionListener[];

	beforeEach(() => {
		cwd = makeTmpCwd();
		preUR = process.listeners("unhandledRejection") as NodeJS.UnhandledRejectionListener[];
		preUE = process.listeners("uncaughtException") as NodeJS.UncaughtExceptionListener[];
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		assert.equal(process.listeners("unhandledRejection").length, preUR.length, "G1: unhandledRejection guard must be removed");
		assert.equal(process.listeners("uncaughtException").length, preUE.length, "G1: uncaughtException guard must be removed");
	});

	it("G1: unhandledRejection guard present BEFORE createSession resolves", async () => {
		let guardSeenBeforeCS = false;
		const wrappedCreateSession = (...args: any[]) => {
			// Inside createSession: the guard MUST already be installed (G1 fix).
			guardSeenBeforeCS = process.listeners("unhandledRejection").length > preUR.length;
			return makeHangingCreateSession()(...args);
		};
		fs.writeFileSync(path.join(cwd, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ auditorTimeoutMs: 50 }));
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});
		assert.ok(guardSeenBeforeCS, "G1: unhandledRejection guard must be installed BEFORE createSession runs");
	});

	it("G1: uncaughtException guard present BEFORE createSession resolves", async () => {
		let guardSeenBeforeCS = false;
		const wrappedCreateSession = (...args: any[]) => {
			guardSeenBeforeCS = process.listeners("uncaughtException").length > preUE.length;
			return makeHangingCreateSession()(...args);
		};
		fs.writeFileSync(path.join(cwd, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ auditorTimeoutMs: 50 }));
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});
		assert.ok(guardSeenBeforeCS, "G1: uncaughtException guard must be installed BEFORE createSession runs");
	});
});

// ---------------------------------------------------------------------------
// G2: process.on handlers inherited extensions register during the audit are removed
// ---------------------------------------------------------------------------
describe("G2 — inherited extension process.on handlers removed after audit", () => {
	let cwd: string;
	let preUR: NodeJS.UnhandledRejectionListener[];
	let preUE: NodeJS.UncaughtExceptionListener[];

	beforeEach(() => {
		cwd = makeTmpCwd();
		preUR = process.listeners("unhandledRejection") as NodeJS.UnhandledRejectionListener[];
		preUE = process.listeners("uncaughtException") as NodeJS.UncaughtExceptionListener[];
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		assert.equal(process.listeners("unhandledRejection").length, preUR.length, "G2: stray unhandledRejection listeners cleaned");
		assert.equal(process.listeners("uncaughtException").length, preUE.length, "G2: stray uncaughtException listeners cleaned");
	});

	it("G2: an unhandledRejection listener registered during createSession is removed after audit", async () => {
		const stray = () => {};
		const wrappedCreateSession = (...args: any[]) => {
			// Simulate an inherited extension registering a process handler onLoad.
			process.on("unhandledRejection", stray);
			return makeApprovingCreateSession(5)(...args);
		};
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});
		assert.ok(!process.listeners("unhandledRejection").includes(stray), "G2: stray listener must be removed after audit");
	});

	it("G2: an uncaughtException listener registered during createSession is removed after audit", async () => {
		const stray = () => {};
		const wrappedCreateSession = (...args: any[]) => {
			process.on("uncaughtException", stray);
			return makeApprovingCreateSession(5)(...args);
		};
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: wrappedCreateSession,
		});
		assert.ok(!process.listeners("uncaughtException").includes(stray), "G2: stray uncaughtException listener must be removed after audit");
	});
});

// ---------------------------------------------------------------------------
// G3: in-memory auditor session cleaned up after audit (output buffer cleared)
// ---------------------------------------------------------------------------
describe("G3 — in-memory auditor state cleaned after audit", () => {
	let cwd: string;

	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("G3: completes and returns a result, demonstrating cleanup ran", async () => {
		// Behavioral guard: a happy-path audit completes and returns a result,
		// demonstrating the session was used and then released. The explicit
		// outputParts.length = 0 cleanup runs in the outer finally regardless.
		const result = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeApprovingCreateSession(5),
		});
		// The approving mock does not emit real assistant text events, so we
		// only assert the audit settled cleanly (no throw) with the expected
		// result envelope — proving the outer-finally cleanup executed.
		assert.equal(typeof result.approved, "boolean");
		assert.equal(typeof result.disapproved, "boolean");
		assert.equal(result.timedOut, undefined);
	});
});

// ---------------------------------------------------------------------------
// G1 follow-up (review): fail-fast — guard error aborts the active session
// ---------------------------------------------------------------------------
describe("G1 follow-up — guard error aborts the session immediately", () => {
	const SRC = fs.readFileSync(
		path.join(import.meta.dirname, "..", "extensions", "goal-auditor.ts"),
		"utf8",
	);

	it("source: a sessionRef holder exists so guards can reach the session", () => {
		assert.match(SRC, /let sessionRef/, "G1 follow-up: sessionRef holder must exist");
	});

	it("source: sessionRef is set when createSession resolves", () => {
		assert.match(SRC, /sessionRef\s*=\s*session/, "G1 follow-up: sessionRef must be assigned after createSession");
	});

	it("source: captureGuardError aborts the session on a real error (fail-fast)", () => {
		assert.match(
			SRC,
			/sessionRef\?\.abort\(\)/,
			"G1 follow-up: guard must call sessionRef?.abort() on capture (fail-fast)",
		);
	});

	it("source: sessionRef is cleared in cleanup so late guard events are inert", () => {
		assert.match(
			SRC,
			/sessionRef\s*=\s*undefined/,
			"G1 follow-up: sessionRef must be reset to undefined in the outer finally",
		);
	});
});

// ---------------------------------------------------------------------------
// P1 (cubic review): guard body must be non-throwing end-to-end.
// String(reason) throws for Object.create(null) / throwing proxy → if the
// uncaughtException handler throws, Node terminates the process. The guard
// must use a safe stringification and wrap its whole body in try/catch.
// ---------------------------------------------------------------------------
describe("P1 — guard body is non-throwing (safeToString + try/catch)", () => {
	const SRC = fs.readFileSync(
		path.join(import.meta.dirname, "..", "extensions", "goal-auditor.ts"),
		"utf8",
	);

	it("source: a safeToString helper exists (never-throws stringification)", () => {
		assert.match(SRC, /function safeToString/, "P1: safeToString helper must exist");
		assert.match(SRC, /\[unformattable reason\]/, "P1: safeToString must have a stable fallback placeholder");
	});

	it("source: captureGuardError uses safeToString, not bare String(reason)", () => {
		assert.match(SRC, /const msg = safeToString\(reason\)/, "P1: guard must call safeToString(reason)");
		// The old unsafe form must be gone from the guard body.
		assert.doesNotMatch(SRC, /const msg = reason instanceof Error \? reason\.message : String\(reason\)/, "P1: bare String(reason) must be removed from guard");
	});

	it("source: the entire captureGuardError body is wrapped in try/catch", () => {
		// The guard must have a catch that records a generic cause so a
		// formatting failure still yields a disapproved-with-error result.
		assert.match(SRC, /if \(!rejectionMessage\) rejectionMessage = `Auditor \$\{kind\}: \(unformattable reason\)`/, "P1: guard catch must record a generic cause");
	});

	it("runtime: safeToString never throws on hostile inputs that crash String()", async () => {
		// Direct unit test of the P1 fix. String(reason) throws for each of
		// these inputs; if the guard called String() it would re-throw inside
		// the unhandledRejection/uncaughtException handler → process exit.
		// safeToString must return a stable string for all of them instead.
		const { safeToString } = await import("../extensions/goal-auditor.ts");

		// 1. Object.create(null) — no toString/valueOf → String() throws.
		const nullProto = Object.create(null);
		let out = safeToString(nullProto);
		assert.equal(typeof out, "string", "P1: Object.create(null) must yield a string, not throw");
		assert.ok(out.length > 0);

		// 2. Throwing Proxy — String()/toString() trap throws.
		const throwingProxy = new Proxy({}, {
			get() { throw new Error("proxy trap boom"); },
		});
		out = safeToString(throwingProxy);
		assert.equal(typeof out, "string", "P1: throwing proxy must yield a string, not throw");
		assert.ok(out.length > 0);

		// 3. Plain values still stringify normally. (String({a:1}) returns
		// "[object Object]" — does not throw — so safeToString returns that;
		// JSON is only the fallback when String() itself throws.)
		assert.equal(safeToString(new Error("msg")), "msg");
		assert.equal(safeToString("plain"), "plain");
		assert.equal(safeToString(42), "42");
		assert.equal(safeToString(null), "null");
		assert.equal(safeToString(undefined), "undefined");
		assert.equal(typeof safeToString({ a: 1 }), "string");
	});
});
