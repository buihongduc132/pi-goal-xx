/**
 * Bug: pi-process-exits-after-completion — pi-print-clean-exit (inherited via
 * the in-process auditor's `inheritFromCwd` + `makeAuditorResourceLoader`)
 * arms a `.unref()`'d `setTimeout(process.exit, 1500)` on the auditor child's
 * `agent_end` (headless ctx.mode). Because the auditor runs IN-PROCESS
 * (`SessionManager.inMemory`), the armed timer kills the HOST pi process
 * ~1.5s after every goal completion. G1/G2/G3 unhandledRejection guards
 * cannot intercept a deliberate `process.exit`.
 *
 * Fix (belt AND suspenders, A+ ⊕ B+):
 *   A+ (pi-goal-xx): `makeAuditorResourceLoader.getExtensions()` excludes any
 *      inherited extension whose SOURCE contains the literal `process.exit`
 *      (content-scan, not a name list → self-maintaining). Fail-closed: an
 *      unreadable or oversized extension is also excluded.
 *   B+ (pi-goal-xx producer + pi-plugins consumer): pi-goal-xx sets
 *      `globalThis.__PI_GOAL_AUDITOR_IN_PROCESS__ = true` BEFORE `createSession`
 *      and clears it in the OUTER finally. pi-print-clean-exit self-skips when
 *      the sentinel is set.
 *
 * This file tests the A+ scanner + the B+ sentinel set/clear (producer side).
 * The B+ consumer self-guard is tested in pi-plugins.
 *
 * TDD: this file is RED before the fix, GREEN after.
 *
 * Zones:
 *  Zone 1 (A+ content-scan): a killer extension (source contains process.exit)
 *        is excluded from the auditor's inherited resource set.
 *  Zone 2 (B+ sentinel set): sentinel is `true` DURING createSession.
 *  Zone 3 (B+ sentinel clear on success): sentinel is deleted after the audit.
 *  Zone 4 (B+ sentinel clear on throw): sentinel is deleted even if prompt rejects.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor, AUDITOR_IN_PROCESS_SENTINEL, extensionCallsProcessExit } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-process-exit",
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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-process-exit-"));
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
 * createSession that APPROVES quickly and lets the test inspect (via the
 * `capture` callback) the `resourceLoader` it was called with, so we can drive
 * the A+ filter directly.
 */
function makeCapturingApprovingCreateSession(
	capture: (extensions: any[]) => void,
	delayMs = 10,
): any {
	return (args: any) => {
		// Drive the resourceLoader's getExtensions() exactly like createSession would.
		try {
			const result = args?.resourceLoader?.getExtensions?.();
			if (result?.extensions) capture(result.extensions);
		} catch {
			/* swallow — capture is best-effort */
		}
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

/**
 * createSession that records whether the sentinel was set when createSession
 * was invoked, and resolves promptly (approving).
 */
function makeSentinelProbingCreateSession(
	probe: (sentinelDuringCreate: boolean) => void,
	delayMs = 10,
): any {
	return (_args: any) => {
		probe((globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL] === true);
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

/**
 * createSession whose prompt REJECTS — used by Zone 4 to verify the sentinel
 * is cleared in the OUTER finally even on the throw path.
 */
function makeRejectingCreateSession(delayMs = 10): any {
	return (_args: any) => {
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				return new Promise<void>((_, reject) =>
					setTimeout(() => reject(new Error("prompt-boom")), delayMs),
				);
			},
			abort() {},
		};
		return Promise.resolve({ session });
	};
}

// A fake "killer" extension source on disk: contains process.exit.
function writeKillerExtension(cwd: string): string {
	const dir = path.join(cwd, "fake-ext-killer");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "index.ts");
	fs.writeFileSync(
		file,
		// Mimic pi-print-clean-exit's structure: calls process.exit(0).
		`export default function () { setTimeout(() => process.exit(0), 1500); }\n`,
	);
	return file;
}

// A benign extension: no process.exit.
function writeBenignExtension(cwd: string): string {
	const dir = path.join(cwd, "fake-ext-benign");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "index.ts");
	fs.writeFileSync(file, `export default function () { return; }\n`);
	return file;
}

// ---------------------------------------------------------------------------
// Zone 1 — A+ content-scan excludes process.exit-calling extensions
// ---------------------------------------------------------------------------
describe("A+ content-scan — process.exit-calling extension excluded from auditor", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("extensionCallsProcessExit: returns true for a source containing process.exit, false for benign", () => {
		const killer = writeKillerExtension(cwd);
		const benign = writeBenignExtension(cwd);
		assert.equal(extensionCallsProcessExit(killer), true, "killer source must be flagged");
		assert.equal(extensionCallsProcessExit(benign), false, "benign source must pass");
	});

	it("auditor inherits benign ext but EXCLUDES killer ext (A+ filter fires in makeAuditorResourceLoader)", async () => {
		const killerPath = writeKillerExtension(cwd);
		const benignPath = writeBenignExtension(cwd);
		const killerName = "fake-ext-killer";
		const benignName = "fake-ext-benign";

		// mainResourceLoader returns BOTH extensions; the auditor's allow-list
		// (resolved.extensions) contains both by path/name. A+ must then drop the
		// killer because its source contains process.exit.
		const fakeLoader = {
			getExtensions: () => ({
				extensions: [
					{ name: killerName, path: killerPath, resolvedPath: killerPath },
					{ name: benignName, path: benignPath, resolvedPath: benignPath },
				],
				errors: [],
				runtime: { registerHook() {}, on() {} },
			}),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => ["auditor prompt"],
			reload: async () => {},
		};

		const captured: any[] = [];
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			// Allow both extensions by path so A+ is the only filter that drops the killer.
			mainResources: {
				inheritFromCwd: false,
				resourceLoader: fakeLoader as any,
				tools: [],
				extensions: [killerPath, benignPath],
				skills: [],
			} as any,
			createSession: makeCapturingApprovingCreateSession((exts) => captured.push(...exts)),
		});

		const names = captured.map((e) => e.name ?? e.path);
		assert.ok(
			names.some((n) => String(n).includes(benignName)),
			"benign extension MUST be inherited",
		);
		assert.ok(
			!names.some((n) => String(n).includes(killerName)),
			"killer extension (process.exit) MUST be excluded by A+ content-scan",
		);
	});
});

// ---------------------------------------------------------------------------
// Zones 2-4 — B+ sentinel set/clear around createSession/prompt
// ---------------------------------------------------------------------------
describe("B+ sentinel — set before createSession, cleared on every path", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
		try { delete (globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL]; } catch {}
	});
	afterEach(() => {
		try { delete (globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL]; } catch {}
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("sentinel is `true` DURING createSession and deleted after a successful audit", async () => {
		let sentinelDuringCreate: boolean | null = null;
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeSentinelProbingCreateSession((v) => { sentinelDuringCreate = v; }),
		});
		assert.equal(sentinelDuringCreate, true, "sentinel must be set when createSession runs");
		assert.equal(
			(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL],
			undefined,
			"sentinel must be deleted after a successful audit",
		);
	});

	it("sentinel is deleted even when session.prompt REJECTS (outer finally clears it)", async () => {
		await assert.rejects(
			() => runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "detailed",
				createSession: makeRejectingCreateSession(10),
			}),
			/prompt-boom/,
		);
		assert.equal(
			(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL],
			undefined,
			"sentinel must be deleted in the outer finally even on prompt rejection",
		);
	});
});
