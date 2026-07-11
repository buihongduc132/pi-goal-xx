/**
 * G4 — writeActiveGoalFile callers must be wrapped in try/catch.
 *
 * If a disk write fails during a state-changing tool (e.g. complete_goal),
 * the tool must surface the error to the agent instead of throwing. Otherwise
 * the in-memory state appears to succeed while the disk is stale, and the
 * agent has no signal that persistence failed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	invokeTool,
	invokeCommand,
	cleanupTimers,
	forceNonWorkerEnv,
	restoreGoalEnv,
} from "./_harness.ts";

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-write-err-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	return cwd;
}

describe("G4: complete_goal surfaces disk-write failures to the agent", () => {
	it("returns a user-facing error message when writeActiveGoalFile fails", async () => {
		const envSnap = forceNonWorkerEnv();
		const cwd = makeCwd();
		// Fresh pi per test to avoid cross-test state.
		const pi: any = createMockPi({ cwd });
		goalExtension(pi);
		try {
			const ctx = createMockCtx(pi, { cwd, idle: false });
			ctx.modelRegistry = { find: () => undefined, getAvailable: () => [] };
			// Disable the auditor so complete_goal reaches the disk-write path
			// (writeResult4) instead of spinning a real sub-agent session.
			fs.writeFileSync(
				path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
				JSON.stringify({ disabled: true }),
			);
			// Create + focus a goal via the direct /goals-set command. This writes
			// the active goal file to disk AND loads it into memory.
			await invokeCommand(pi, ctx, "goals-set", "Objective: ship it. Success criteria: shipped.");
			// Sanity: a goal is focused before we break persistence.
			const pre = await invokeTool(pi, ctx, "get_goal", {});
			const preText = String((pre as any)?.content?.[0]?.text ?? "");
			assert.ok(!/No goal/i.test(preText), `setup failed — no goal focused: ${preText}`);
			// Make the goals dir read-only so the completion write will fail.
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o555);

			let threw = false;
			let result: unknown;
			try {
				result = await invokeTool(pi, ctx, "complete_goal", {
					verificationSummary: "verified",
					confirmBypassAuditor: true,
				});
			} catch {
				threw = true;
			}
			assert.ok(!threw, "complete_goal must NOT throw when writeActiveGoalFile fails");
			assert.ok(result && typeof result === "object", "result must be an object");
			const content = (result as any)?.content;
			assert.ok(Array.isArray(content) && content.length > 0, "result must contain content");
			const text = String(content[0]?.text ?? "");
			assert.match(
				text,
				/(could not be saved|disk-write|write failed|save|persisted|disk|persistence)/i,
				`expected a disk-write error message, got: ${text}`,
			);
		} finally {
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o755);
			try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
			restoreGoalEnv(envSnap);
			await cleanupTimers(pi, cwd);
		}
	});

	it("rolls back in-memory state.goal to active on write failure so retry is possible (gemini/coderabbit)", async () => {
		// Regression for the high-severity review finding: on a write failure
		// the in-memory goal was left status:"complete" while the disk still
		// held the active record. A retry was then blocked because
		// validateGoalCompletion saw the stale "complete" status. The fix
		// rolls state.goal back to auditTarget (the pre-completion record).
		const envSnap = forceNonWorkerEnv();
		const cwd = makeCwd();
		const pi: any = createMockPi({ cwd });
		goalExtension(pi);
		try {
			const ctx = createMockCtx(pi, { cwd, idle: false });
			ctx.modelRegistry = { find: () => undefined, getAvailable: () => [] };
			fs.writeFileSync(
				path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
				JSON.stringify({ disabled: true }),
			);
			await invokeCommand(pi, ctx, "goals-set", "Objective: ship it. Success criteria: shipped.");
			// Break persistence so complete_goal's write fails.
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o555);
			await invokeTool(pi, ctx, "complete_goal", {
				verificationSummary: "verified",
				confirmBypassAuditor: true,
			});
			// Restore writability so the get_goal read path works.
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o755);
			// The in-memory goal must NOT be stuck at status:"complete" — it
			// must be rolled back so the agent can retry complete_goal.
			const goalResult = await invokeTool(pi, ctx, "get_goal", {});
			const goalText = String((goalResult as any)?.content?.[0]?.text ?? "");
			assert.ok(
				!/status:\s*complete/i.test(goalText) || /could not be saved/i.test(goalText),
				`in-memory goal must not be left "complete" after a write failure: ${goalText}`,
			);
		} finally {
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o755);
			try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
			restoreGoalEnv(envSnap);
			await cleanupTimers(pi, cwd);
		}
	});
});

describe("G4: turn_end archival failure does not crash the hook", () => {
	it("notifies and returns cleanly when archiveGoalFile fails in turn_end", async () => {
		const envSnap = forceNonWorkerEnv();
		const cwd = makeCwd();
		const pi: any = createMockPi({ cwd });
		goalExtension(pi);
		try {
			const ctx = createMockCtx(pi, { cwd, idle: false });
			ctx.modelRegistry = { find: () => undefined, getAvailable: () => [] };
			fs.writeFileSync(path.join(cwd, ".pi", "pi-goal-xx-settings.json"), JSON.stringify({ disabled: true }));
			await invokeCommand(pi, ctx, "goals-set", "Objective: ship it. Success criteria: shipped.");
			// Complete the goal; this writes the active file successfully and
			// defers archival to turn_end.
			await invokeTool(pi, ctx, "complete_goal", {
				verificationSummary: "verified",
				confirmBypassAuditor: true,
			});
			// Make the goals dir read-only so the turn_end archiveGoalFile fails.
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o555);
			// Emit a synthetic turn_end. Without the try/catch, this throws and
			// the test fails; with the fix, it should return cleanly and notify.
			let threw = false;
			try {
				await pi.handlers.get("turn_end")?.[0]({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, ctx);
			} catch {
				threw = true;
			}
			assert.ok(!threw, "turn_end archival failure must not crash the handler");
			const errorNotifies = pi.ui.notifyCalls.filter((n: any) => n.kind === "error" && /archival failed/i.test(String(n.msg)));
			assert.ok(errorNotifies.length > 0, "turn_end should notify about archival failure");
		} finally {
			fs.chmodSync(path.join(cwd, ".pi", "goals"), 0o755);
			try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
			restoreGoalEnv(envSnap);
			await cleanupTimers(pi, cwd);
		}
	});
});

// ---------------------------------------------------------------------------
// P1 (cubic review): propose_goal_tweak confirmation path must enforce the
// G6 50KB objective cap. Without it, an overlong revised objective reaches
// disk and later inflates the auditor prompt unbounded → OOM/hang.
// ---------------------------------------------------------------------------
describe("P1: propose_goal_tweak enforces G6 objective cap on confirmation", () => {
	const SRC = fs.readFileSync(
		path.join(import.meta.dirname, "..", "extensions", "goal.ts"),
		"utf8",
	);

	it("source: the tweak confirmation path validates cleanedObjective length", () => {
		// The G6 cap must be applied to cleanedObjective BEFORE the write.
		assert.match(
			SRC,
			/cleanedObjective\.length > MAX_OBJECTIVE_LENGTH/,
			"P1: propose_goal_tweak must check cleanedObjective.length against MAX_OBJECTIVE_LENGTH",
		);
		assert.match(
			SRC,
			/propose_goal_tweak REJECTED: revised objective/,
			"P1: overlong objective must be rejected with a clear message",
		);
	});

	it("source: the tweak path rejects overlong newObjective BEFORE the dialog (coderabbit)", () => {
		// Early cap — before buildTweakConfirmationText / showProposalDialog.
		assert.match(
			SRC,
			/newObjective\.length > MAX_OBJECTIVE_LENGTH/,
			"P1: propose_goal_tweak must check newObjective.length early, before the dialog",
		);
	});

	it("source: handleDirectGoalSet enforces the G6 cap (coderabbit)", () => {
		// /goals-set and /sisyphus-set must not bypass the 50KB cap.
		assert.match(
			SRC,
			/raw\.length > MAX_OBJECTIVE_LENGTH/,
			"P1: handleDirectGoalSet must check raw.length against MAX_OBJECTIVE_LENGTH",
		);
	});

	it("source: all 4 complete_goal write-failure paths roll back state.goal (gemini/coderabbit)", () => {
		// Each writeResult error block must restore state.goal = auditTarget
		// so the in-memory state is not left "complete" when the disk write failed.
		const rollbackCount = (SRC.match(/state\.goal = auditTarget;/g) || []).length;
		assert.ok(
			rollbackCount >= 4,
			`expected >=4 state.goal = auditTarget rollbacks in complete_goal, found ${rollbackCount}`,
		);
	});
});
