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
});
