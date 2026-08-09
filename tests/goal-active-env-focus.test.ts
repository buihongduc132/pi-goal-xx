/**
 * Integration RED tests: starting/focusing a goal sets
 * env[PI_GOAL_XX_ACTIVE] to resolved value of {repo}-{branch}-{goalId};
 * completing/aborting the goal clears it.
 *
 * Uses the real goal.ts extension + harness. process.env is snapshotted/
 * restored per test to avoid cross-test bleed.
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
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-active-env-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	// Wipe the active-env var so each test starts clean.
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

describe("goal-active-env — focus sets env, complete/abort clears it", () => {
	it("focusing a goal via /goal-focus sets PI_GOAL_XX_ACTIVE", async () => {
		writeGoalFile(cwd, { id: "abc-123", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		const v = process.env.PI_GOAL_XX_ACTIVE;
		assert.ok(v, "PI_GOAL_XX_ACTIVE must be set after focus");
		// Must end with the goal id (template default: {repo}-{branch}-{goalId}).
		assert.ok(v!.endsWith("abc-123"), `expected to end with goal id; got: ${v}`);
	});

	it("clearing focus via /goal-clear removes PI_GOAL_XX_ACTIVE", async () => {
		writeGoalFile(cwd, { id: "abc-456", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		assert.ok(process.env.PI_GOAL_XX_ACTIVE, "precondition: env set");

		// /goal-clear archives + clears focus → env var must be removed
		await invokeCommand(pi, ctx, "goal-clear", "");
		await flushContinuation();

		assert.equal(process.env.PI_GOAL_XX_ACTIVE, undefined, "env var must be cleared");
	});

	it("custom template from settings is honored", async () => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalActiveEnvTemplate: "GOAL-{goalId}" }),
		);
		writeGoalFile(cwd, { id: "xyz-789", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		assert.equal(process.env.PI_GOAL_XX_ACTIVE, "GOAL-xyz-789");
	});

	it("custom env name from settings is honored", async () => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ goalActiveEnvName: "MY_GOAL" }),
		);
		writeGoalFile(cwd, { id: "named-1", autoContinue: false, objective: "do stuff" });
		const { pi, ctx } = setup();
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		assert.ok(process.env.MY_GOAL, "MY_GOAL must be set");
		assert.ok(process.env.MY_GOAL.endsWith("named-1"), `expected to end with named-1, got: ${process.env.MY_GOAL}`);
		assert.equal(process.env.PI_GOAL_XX_ACTIVE, undefined, "default name must NOT be set when overridden");
	});
});
