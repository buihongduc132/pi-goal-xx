/**
 * RED tests for two bugs:
 * 1. TUI selection not shown when 2+ goals exist (only shows warning text)
 * 2. After focusing a paused goal via /goal-resume, unable to actually resume it
 *
 * Bug 1: User sees "Warning: No goal is focused" but not the TUI picker
 * Bug 2: After /goal-resume and selecting a paused goal, it stays paused
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

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-tui-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	fs.rmSync(cwd, { recursive: true, force: true });
});

function setup(hasUI: boolean, mode?: string) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI,
		mode,
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

function lastFocusedGoalId(p: ReturnType<typeof createMockPi>): string | null {
	const entries = (p as any).appendedEntries as Array<{ customType: string; data?: any }>;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.customType === "pi-goal-focus" && e.data && typeof e.data.focusedGoalId === "string") {
			return e.data.focusedGoalId;
		}
	}
	return null;
}

function spySelect(ui: any) {
	const calls: Array<{ title?: any; items: any[] }> = [];
	const orig = ui.select.bind(ui);
	ui.select = async (...args: any[]) => {
		const title = args[0];
		const items = args[1] ?? args[0];
		calls.push({ title, items });
		return orig(args[1] ?? args[0], args[2]);
	};
	return {
		calls,
		restore: () => { ui.select = orig; },
	};
}

describe("Bug 1: TUI selection not shown", () => {
	it("BUG: TUI mode with 2+ goals should show picker, not just warning", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true /* hasUI */, "interactive" /* mode */);
		await loadGoals(pi, ctx);

		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		spy.restore();

		// Verify: TUI picker should be shown
		assert.ok(spy.calls.length >= 1, `TUI picker should be shown when 2+ goals exist in TUI mode, got ${spy.calls.length} calls`);
		assert.ok(spy.calls[0]!.title.includes("2 open"), "Picker title should show count");
		assert.equal(spy.calls[0]!.items.length, 2, "Picker should show 2 items");

		// Verify: NOT just a warning notification
		const warningNotify = pi.ui.notifyCalls.find((n) => /No goal is focused/i.test(String(n.msg)));
		assert.ok(!warningNotify, "Should NOT show 'No goal is focused' warning when picker is available");
	});

	it("BUG: TUI mode detection should work correctly", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });

		// Test with hasUI=true and mode=interactive
		const { pi, ctx } = setup(true, "interactive");
		await loadGoals(pi, ctx);

		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		spy.restore();

		// Should show picker in TUI mode
		assert.ok(spy.calls.length >= 1, "TUI picker should be shown in interactive mode");
	});
});

describe("Bug 2: Resume after focus", () => {
	it("BUG: /goal-resume should resume paused goal after focusing", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true, "interactive");
		await loadGoals(pi, ctx);

		// Simulate user selecting goal-bbbb-2222
		(pi.ui as any).selectAnswers.length = 0;
		// Pre-push the second label (goal-bbbb)
		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();
		spy.restore();

		// Verify: goal-bbbb-2222 should be resumed (status changed to active)
		const goalFile = path.join(cwd, ".pi", "goals", "active_goal_20260101_goal-bbbb-2222.md");
		const content = fs.readFileSync(goalFile, "utf-8");
		const jsonEnd = content.indexOf("\n\n");
		const jsonPart = content.slice(0, jsonEnd);
		const goal = JSON.parse(jsonPart);

		assert.equal(goal.status, "active", "Selected paused goal should be resumed to active");
		assert.equal(goal.autoContinue, true, "Resumed goal should have autoContinue=true");
	});

	it("BUG: /goal-resume should focus active goal without resuming", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "active", autoContinue: true });
		const { pi, ctx } = setup(true, "interactive");
		await loadGoals(pi, ctx);

		// Simulate user selecting goal-bbbb-2222 (active)
		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-resume", "");
		await flushContinuation();
		spy.restore();

		// Verify: goal-bbbb-2222 should still be active (not changed)
		const goalFile = path.join(cwd, ".pi", "goals", "active_goal_20260101_goal-bbbb-2222.md");
		const content = fs.readFileSync(goalFile, "utf-8");
		const jsonEnd = content.indexOf("\n\n");
		const jsonPart = content.slice(0, jsonEnd);
		const goal = JSON.parse(jsonPart);

		assert.equal(goal.status, "active", "Active goal should remain active");
	});
});
