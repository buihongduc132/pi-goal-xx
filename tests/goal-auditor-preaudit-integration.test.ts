/**
 * RED phase — pre-audit hooks ↔ goal-auditor integration (LD2, LD5, LD6, LD7, LD8) + OT12.
 *
 * These tests FAIL because the integration does not exist yet:
 *   - `runGoalCompletionAuditor` does not run a pre-audit gate before createSession.
 *   - `GoalAuditorResult` has no `gateFailure` field (OT12).
 *   - `parseGoalSettings` rejects the `preAuditHooks` key, so the settings file
 *     written below is silently dropped → no gate ever fires.
 *
 * Contract the GREEN phase must satisfy:
 *   - runGoalCompletionAuditor reads settings.preAuditHooks from loadGoalSettings(cwd).
 *   - When preAuditHooks.enabled === true AND any hook FAILS → returns
 *     { approved:false, disapproved:true, gateFailure:"<reason>" } WITHOUT
 *     calling createSession (no auditor session launched). `error` MUST stay
 *     undefined so the verdict is "disapproved", not "error" (OT12).
 *   - When preAuditHooks.enabled === false (or absent) → auditor runs normally.
 *   - When all hooks PASS → auditor runs normally AND the sanitized hook output
 *     appears inside the prompt sent to the auditor (LD6), wrapped per OT14.
 *
 * Spec: locked-decisions.yaml (LD5/LD6/LD8), open-threads.yaml (OT12).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGoalCompletionAuditor } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

// ───────────────────────── harness (mirrors goal-auditor.test.ts) ─────────────────────────

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-pre",
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

function makeMockModel(provider: string, id: string): any {
	return { provider, id, name: id };
}

/** Mock ExtensionContext with a controllable modelRegistry. */
function makeCtx(cwd: string, over: Partial<{ model: any; models: any[] }> = {}): any {
	const models = over.models ?? [makeMockModel("def", "m1")];
	return {
		cwd,
		model: over.model ?? models[0],
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
		},
		hasUI: false,
	};
}

/**
 * createSession spy. Records whether it was called (callCount) and, on the mock
 * session, captures the prompt text passed to session.prompt(). Emits a single
 * message_end with the given verdict so runGoalCompletionAuditor completes.
 */
function spyCreateSession(opts: { finalOutput?: string; onPrompt?: (t: string) => void } = {}): {
	fn: any;
	callCount: () => number;
	prompted: string[];
} {
	let calls = 0;
	const prompted: string[] = [];
	const fn = async (_sessionArgs: any) => {
		calls++;
		let subscriber: ((event: any) => void) | null = null;
		const session = {
			subscribe(cb: (event: any) => void) {
				subscriber = cb;
				return () => { subscriber = null; };
			},
			async prompt(text: string) {
				prompted.push(text);
				opts.onPrompt?.(text);
				if (opts.finalOutput !== undefined) {
					subscriber?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: opts.finalOutput }] },
					});
				}
			},
			abort() { /* no-op */ },
		};
		return { session };
	};
	return { fn, callCount: () => calls, prompted };
}

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-preint-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	return dir;
}

function writeHookScript(dir: string, name: string, body: string): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
	fs.chmodSync(p, 0o755);
	return p;
}

/** Write a pi-goal-xx settings file into <cwd>/.pi/ with a preAuditHooks block. */
function writeSettings(cwd: string, preAuditHooks: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
		JSON.stringify({ preAuditHooks }),
	);
}

// ───────────────────────── gate failure → early disapprove (LD2, LD5, OT12) ─────────────────────────

describe("runGoalCompletionAuditor — pre-audit gate (LD5, OT12)", () => {
	it("enabled + hook FAILS → returns gate failure WITHOUT launching auditor session", async () => {
		const cwd = tmpCwd();
		try {
			const failScript = writeHookScript(cwd, "fail.sh", "echo nope; exit 1");
			writeSettings(cwd, {
				enabled: true,
				globalScript: failScript,
				maxOutputChars: 5000,
				timeoutMs: 30000,
				injectOutput: true,
			});
			const spy = spyCreateSession({ finalOutput: "<approved/>" });
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			// Gate short-circuits: no auditor session launched.
			assert.equal(spy.callCount(), 0, "createSession must NOT be called when the gate fails");
			// Result shape (OT12): gateFailure set, error NOT set, disapproved.
			assert.equal(result.approved, false);
			assert.equal(result.disapproved, true);
			assert.ok(
				typeof result.gateFailure === "string" && result.gateFailure.length > 0,
				"gateFailure must be a non-empty string",
			);
			assert.equal(result.error, undefined, "error must stay undefined (verdict=disapproved, not error)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("enabled:false (default) → no gate, auditor runs normally", async () => {
		const cwd = tmpCwd();
		try {
			// Even a failing script must be IGNORED when enabled is false.
			const failScript = writeHookScript(cwd, "fail.sh", "exit 1");
			writeSettings(cwd, {
				enabled: false,
				globalScript: failScript,
			});
			const spy = spyCreateSession({ finalOutput: "<approved/>" });
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			assert.equal(spy.callCount(), 1, "auditor session must launch when gate disabled");
			assert.equal(result.approved, true);
			assert.equal(result.gateFailure, undefined, "no gateFailure when gate inactive");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("no preAuditHooks config at all → auditor runs normally", async () => {
		const cwd = tmpCwd();
		try {
			// No settings file → no preAuditHooks → auditor runs.
			const spy = spyCreateSession({ finalOutput: "<approved/>" });
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			assert.equal(spy.callCount(), 1);
			assert.equal(result.approved, true);
			assert.equal(result.gateFailure, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ───────────────────────── all pass → inject hook output into prompt (LD6, OT14) ─────────────────────────

describe("runGoalCompletionAuditor — LD6 hook output injection", () => {
	it("all hooks PASS → auditor runs and prompt contains injected hook output", async () => {
		const cwd = tmpCwd();
		try {
			const passScript = writeHookScript(cwd, "pass.sh", "echo UNIQUE-HOOK-MARKER-12345");
			writeSettings(cwd, {
				enabled: true,
				globalScript: passScript,
				maxOutputChars: 5000,
				timeoutMs: 30000,
				injectOutput: true,
			});
			let capturedPrompt = "";
			const spy = spyCreateSession({
				finalOutput: "<approved/>",
				onPrompt: (t) => { capturedPrompt = t; },
			});
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			assert.equal(spy.callCount(), 1, "auditor session launched when all hooks pass");
			assert.equal(result.approved, true);
			assert.ok(
				capturedPrompt.includes("UNIQUE-HOOK-MARKER-12345"),
				"hook output must be injected into the auditor prompt (LD6)",
			);
			assert.match(
				capturedPrompt,
				/<hook-output>[\s\S]*UNIQUE-HOOK-MARKER-12345[\s\S]*<\/hook-output>/,
				"hook output must be wrapped in <hook-output> markers (OT14)",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("injectOutput:false → hook passes but output is NOT injected", async () => {
		const cwd = tmpCwd();
		try {
			const passScript = writeHookScript(cwd, "pass.sh", "echo SHOULD-NOT-APPEAR-98765");
			writeSettings(cwd, {
				enabled: true,
				globalScript: passScript,
				injectOutput: false,
				maxOutputChars: 5000,
				timeoutMs: 30000,
			});
			let capturedPrompt = "";
			const spy = spyCreateSession({
				finalOutput: "<approved/>",
				onPrompt: (t) => { capturedPrompt = t; },
			});
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			assert.equal(result.approved, true);
			assert.ok(
				!capturedPrompt.includes("SHOULD-NOT-APPEAR-98765"),
				"injectOutput:false must keep hook output out of the prompt",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ───────────────────────── OT12 — gateFailure is distinct from error ─────────────────────────

describe("GoalAuditorResult.gateFailure — OT12 semantic separation", () => {
	it("hook failure sets gateFailure, NOT error (verdict stays 'disapproved')", async () => {
		const cwd = tmpCwd();
		try {
			const failScript = writeHookScript(cwd, "fail.sh", "exit 7");
			writeSettings(cwd, { enabled: true, globalScript: failScript });
			const spy = spyCreateSession({ finalOutput: "<approved/>" });
			const result = await runGoalCompletionAuditor({
				ctx: makeCtx(cwd),
				goal: makeGoal(),
				detailedSummary: "d",
				createSession: spy.fn,
			});
			// The collision OT12 warns about: setting BOTH disapproved:true AND error
			// makes the verdict "error". gateFailure must be the SEPARATE field so the
			// user sees "pre-audit check failed" (disapproved), not "Auditor error".
			assert.equal(result.disapproved, true);
			assert.equal(result.error, undefined);
			assert.ok(typeof result.gateFailure === "string" && result.gateFailure.length > 0);
			// Reason should reference the hook (not the auditor infrastructure).
			assert.ok(
				/hook|pre-audit|gate/i.test(result.gateFailure),
				`gateFailure should mention the hook gate (got: ${result.gateFailure})`,
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
