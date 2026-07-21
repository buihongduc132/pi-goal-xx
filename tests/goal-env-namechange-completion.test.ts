/**
 * RED regression tests for CodeRabbit major comments on PR #39:
 * - 3619924992: turn_end completion clears env var (was leaving it set)
 * - 3619924996: changing goalActiveEnvName while focused clears old var
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	invokeCommand,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;
let savedActive: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-env-fix-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	savedActive = process.env.PI_GOAL_XX_ACTIVE;
	delete process.env.PI_GOAL_XX_ACTIVE;
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	if (savedActive === undefined) delete process.env.PI_GOAL_XX_ACTIVE;
	else process.env.PI_GOAL_XX_ACTIVE = savedActive;
	restoreGoalEnv(envSnap);
	fs.rmSync(cwd, { recursive: true, force: true });
});

function setup() {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: true,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

async function loadGoals(p: ReturnType<typeof createMockPi>, ctx: any) {
	await emit(p, ctx, "session_start", { reason: "new" });
	await flushContinuation();
}

describe("PR #39 review fixes", () => {
	it("3619924992: completing the focused goal clears PI_GOAL_XX_ACTIVE", async () => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ disabled: true }),
		);
		writeGoalFile(cwd, { id: "complete-test", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		assert.ok(process.env.PI_GOAL_XX_ACTIVE, "precondition: env set after focus");
		assert.ok(process.env.PI_GOAL_XX_ACTIVE!.endsWith("complete-test"));

		// complete_goal: status moves to complete; turn_end archival clears focus.
		await invokeTool(pi, ctx, "complete_goal", {
			verificationSummary: "all green",
			completionSummary: "done",
			confirmBypassAuditor: true,
		});
		// Emit turn_end to trigger the archival path that clears focus.
		await emit(pi, ctx, "turn_end", {});
		await flushContinuation();

		assert.equal(process.env.PI_GOAL_XX_ACTIVE, undefined,
			"env var must be cleared after goal completion");
	});

	it("3619924996: changing goalActiveEnvName while focused clears the OLD var", async () => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalActiveEnvName: "OLD_NAME" }),
		);
		writeGoalFile(cwd, { id: "name-change", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		assert.ok(process.env.OLD_NAME, "precondition: OLD_NAME set");

		// Now change the configured name to a new one and re-focus to trigger sync.
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalActiveEnvName: "NEW_NAME" }),
		);
		// Re-trigger focus to apply the new config.
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		assert.ok(process.env.NEW_NAME, "NEW_NAME must be set");
		assert.equal(process.env.OLD_NAME, undefined,
			"OLD_NAME must be cleared when name changed while focused");
	});
});
