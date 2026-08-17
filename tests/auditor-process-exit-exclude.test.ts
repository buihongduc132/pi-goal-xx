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
 *  Zone 6 (issue #35 verification contract): spawn the auditor child with a
 *        faithful pi-print-clean-exit mimic in the main session's extensions,
 *        approve, fire the child's headless agent_end through pi-coding-agent's
 *        REAL extension loader, and assert the host process is still alive 3s
 *        later (no process.exit call). A control test proves the harness
 *        reproduces the bug when the A+ filter is bypassed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
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
 * createSession that simulates an inherited process.exit-calling extension's
 * agent_end handler (the pi-print-clean-exit B+ consumer contract) running
 * DURING the audit window (inside prompt()). It reads the sentinel; if set,
 * it self-skips instead of arming process.exit. Used by Zone 5 to prove the
 * B+ PRODUCER enables a sentinel-honoring consumer to self-skip — the
 * contract that makes B+ load-bearing once the consumer (pi-plugins
 * commit 81f2cebf) is deployed. A+ alone excludes the real killer, so this
 * simulates the A+-missed / defense-in-depth path directly.
 */
function makeSentinelConsumerCreateSession(
	consumer: (selfSkipped: boolean) => void,
	delayMs = 10,
): any {
	return (_args: any) => {
		const session = {
			subscribe(_cb: (event: any) => void) { return () => {}; },
			prompt(_text: string): Promise<void> {
				return new Promise<void>((resolve) => {
					const sentinelSet =
						(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL] === true;
					consumer(sentinelSet); // selfSkipped === sentinelSet
					setTimeout(resolve, delayMs);
				});
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

	it("extensionCallsProcessExit: does NOT false-positive on a COMMENT-only process.exit mention (global-error-handler pattern)", () => {
		// Regression for verifier-loop MUST-FIX: a benign extension whose only
		// 'process.exit' occurrence is a doc comment (e.g. global-error-handler.ts
		// line 11: 'NEVER calls process.exit() — pi manages its own lifecycle')
		// must NOT be excluded. The naive substring scan would wrongly drop it;
		// the comment-stripping scanner must return false.
		const commentOnlyPath = `${cwd}/comment-only-ext.ts`;
		fs.writeFileSync(commentOnlyPath, [
			"/**",
			" * - NEVER calls process.exit() — pi manages its own lifecycle.",
			" */",
			"// line comment: process.exit(0) is forbidden here",
			"export default function () { console.log('benign'); }",
			"",
		].join("\n"));
		assert.equal(extensionCallsProcessExit(commentOnlyPath), false, "comment-only process.exit mention must NOT be flagged");
	});

	it("extensionCallsProcessExit: returns false for non-file paths (test fixtures, stubs) without excluding them", () => {
		// Real extensions always have on-disk file paths. A bare name like
		// "cc-safety-net" is a test-fixture / in-memory stub, never a killer
		// extension on disk — must NOT be excluded by this rule. Other rules
		// (isGoalSelfExtension, allow-list) still apply.
		assert.equal(extensionCallsProcessExit(undefined), false);
		assert.equal(extensionCallsProcessExit("cc-safety-net"), false);
		assert.equal(extensionCallsProcessExit("/nonexistent/path/index.ts"), false);
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
		// The auditor catches prompt rejections internally and returns an error
		// result rather than throwing, so we don't assert.rejects — we just
		// verify the OUTER finally cleared the sentinel on this path too.
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeRejectingCreateSession(10),
		});
		assert.equal(
			(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL],
			undefined,
			"sentinel must be deleted in the outer finally even on prompt rejection",
		);
	});

	// Zone 5 — B+ producer ↔ consumer contract: a sentinel-honoring inherited
	// extension observed DURING the audit window self-skips (no process.exit
	// armed). This proves the B+ producer's sentinel is visible to consumers
	// during the window, so B+ is load-bearing once a consumer honors it.
	// Directly answers verifier Angle E ("if A+ misses, does B+ hold?"): the
	// sentinel is correctly set, so any sentinel-honoring consumer self-skips.
	it("Zone 5 — sentinel-honoring inherited extension self-skips during the audit window", async () => {
		let selfSkipped: boolean | null = null;
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "detailed",
			createSession: makeSentinelConsumerCreateSession(
				(v) => { selfSkipped = v; },
			),
		});
		assert.equal(
			selfSkipped,
			true,
			"an inherited extension honoring the sentinel MUST observe it set during the audit window and self-skip (no process.exit armed)",
		);
		assert.equal(
			(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL],
			undefined,
			"sentinel must be cleared after the audit",
		);
	});
});

// ---------------------------------------------------------------------------
// Zone 6 — Issue #35 verification-contract regression:
//   "Regression test: spawn auditor child, approve, assert host process still
//    alive after 3s"
// Zones 1-5 pin the A+ scanner and B+ sentinel units. Zone 6 replays the FULL
// production kill chain end-to-end: main session has the killer installed →
// auditor child is spawned in-process with inherited main-session resources →
// audit approves → the child's agent loop ends → agent_end fires in headless
// ctx → the killer (if inherited) arms its 1.5s process.exit(0) timer. The
// child's extension set is loaded and fired through pi-coding-agent's REAL
// extension loader (discoverAndLoadExtensions — the same public entry pi
// itself uses), so a regression anywhere in the A+ filter chain arms a REAL
// timer against the stubbed process.exit and fails this test.
// ---------------------------------------------------------------------------

/**
 * Faithful mimic of pi-print-clean-exit (pi-plugins): registers an agent_end
 * handler that — in a headless session (ctx.hasUI === false, the in-process
 * auditor child's mode) — arms an unref'd 1.5s process.exit(0) timer. Uses
 * the REAL 1500ms from the bug report so the regression assertions below
 * mirror production timing exactly (kill lands ~1.5s after approve; the host
 * must still be alive at 3s).
 */
function writeCleanExitMimicExtension(cwd: string): string {
	const dir = path.join(cwd, "pi-print-clean-exit-mimic");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "index.ts");
	fs.writeFileSync(
		file,
		[
			"export default function (api: any) {",
			"\tapi.on('agent_end', (_event: any, ctx: any) => {",
			"\t\tif (ctx?.hasUI === false) {",
			"\t\t\tsetTimeout(() => { process.exit(0); }, 1500).unref();",
			"\t\t}",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	return file;
}

/**
 * Host-alive probe: record process.exit calls instead of exiting. The real
 * process.exit never returns; the fixture has no code after the call site,
 * so a non-throwing recorder is faithful for this harness.
 */
function stubProcessExit(): { calls: Array<number | string | undefined | null>; restore: () => void } {
	const calls: Array<number | string | undefined | null> = [];
	const real = process.exit;
	(process as any).exit = (code?: any) => {
		calls.push(code ?? 0);
		return undefined as never;
	};
	return { calls, restore: () => { (process as any).exit = real; } };
}

/**
 * Load the given extension paths through pi-coding-agent's REAL loader
 * (discoverAndLoadExtensions — the same public entry pi uses) and fire a
 * headless agent_end on every loaded extension, exactly as the auditor
 * child's agent loop does when the audit completes. Discovery is contained:
 * cwd/.pi/extensions and agentDir/extensions are empty in the tmp fixture,
 * so exactly `paths` load. Asserts the loader reported no errors so a silent
 * load failure can never make a test vacuously green.
 */
async function loadAndFireHeadlessAgentEnd(paths: string[], cwd: string): Promise<void> {
	const agentDir = path.join(cwd, ".pi");
	const result = await discoverAndLoadExtensions(paths, cwd, agentDir);
	assert.deepEqual(result.errors, [], "extension loader must not report errors");
	for (const ext of result.extensions) {
		const handlers = ext.handlers.get("agent_end") ?? [];
		for (const h of handlers) {
			await h({ type: "agent_end", messages: [] }, { hasUI: false, cwd });
		}
	}
}

describe("Zone 6 — issue #35 contract: host alive 3s after auditor child approves", () => {
	let cwd: string;
	beforeEach(() => { cwd = makeTmpCwd(); });
	afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

	it("CONTROL: the clean-exit mimic, when NOT filtered out, arms the 1.5s process.exit(0) timer (bug repro)", async () => {
		// Guards the harness: if the mimic, the real loader, or the headless
		// agent_end fire ever drift from the production contract, THIS test
		// fails — which means the regression test below would be vacuous.
		const killerPath = writeCleanExitMimicExtension(cwd);
		const exitStub = stubProcessExit();
		try {
			await loadAndFireHeadlessAgentEnd([killerPath], cwd);
			// The kill timer fires at 1.5s; wait past it.
			await new Promise((r) => setTimeout(r, 1800));
			assert.deepEqual(
				exitStub.calls,
				[0],
				"control MUST record process.exit(0) — proves the harness reproduces the 2026-07-14 bug",
			);
		} finally {
			exitStub.restore();
		}
	});

	it("REGRESSION: auditor child never inherits the clean-exit killer — host process alive 3s after approve", async () => {
		const killerPath = writeCleanExitMimicExtension(cwd);
		const benignPath = writeBenignExtension(cwd);

		// Same main-session loader shape as Zone 1: the main session has BOTH
		// the killer and a benign extension installed; both are allow-listed so
		// the A+ content-scan is the ONLY rule that can drop the killer.
		const fakeLoader = {
			getExtensions: () => ({
				extensions: [
					{ name: "pi-print-clean-exit-mimic", path: killerPath, resolvedPath: killerPath },
					{ name: "fake-ext-benign", path: benignPath, resolvedPath: benignPath },
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
		const exitStub = stubProcessExit();
		try {
			// Spawn the in-process auditor child (approve path) and capture the
			// extension set its resource loader hands to createSession.
			await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "detailed",
				mainResources: {
					inheritFromCwd: false,
					resourceLoader: fakeLoader as any,
					tools: [],
					extensions: [killerPath, benignPath],
					skills: [],
				} as any,
				createSession: makeCapturingApprovingCreateSession((exts) => captured.push(...exts)),
			});

			const filteredPaths = captured
				.map((e) => e.path ?? e.resolvedPath)
				.filter((p): p is string => typeof p === "string");
			assert.ok(
				filteredPaths.some((p) => p.includes("fake-ext-benign")),
				"benign extension MUST be inherited by the auditor child",
			);
			assert.ok(
				!filteredPaths.some((p) => p.includes("pi-print-clean-exit-mimic")),
				"clean-exit mimic MUST be excluded from the auditor child by the A+ content-scan",
			);

			// The audit approves → the child's agent loop ends → agent_end fires
			// in headless ctx. Load the child's REAL extension set and fire it.
			await loadAndFireHeadlessAgentEnd(filteredPaths, cwd);

			// Issue #35 contract, verbatim: host process still alive after 3s
			// (the killer's 1.5s process.exit(0) timer would have fired by now).
			await new Promise((r) => setTimeout(r, 3000));
			assert.deepEqual(
				exitStub.calls,
				[],
				"process.exit MUST NOT be called — host still alive 3s after the auditor child approved",
			);
		} finally {
			exitStub.restore();
		}
	});
});
