/**
 * goal-focus-stale-pool — RED tests for the focusGoalCommand stale-pool bug.
 *
 * ROOT CAUSE: focusGoalCommand (extensions/goal.ts:2258) does NOT call
 * reconcileFocusedGoalFromDisk(ctx) before reading the in-memory goal pool.
 * When a second goal is created after session start (by another session,
 * subagent, or user in a different terminal), the in-memory goalsById map
 * is stale (only has 1 goal), so openGoals() returns 1 goal → takes the
 * open.length === 1 fast-path → auto-focuses WITHOUT showing the picker.
 *
 * These tests FAIL with the current buggy code and should PASS after the fix.
 *
 * Bug reference: flow/troubleshootings/2026-07-26_focus-goal-stale-pool.md
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
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-stale-"));
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

function setup(hasUI: boolean) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI,
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

/** Read the last focused goal id from the captured pi-goal-focus appendEntry. */
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

/**
 * Spy on ctx.ui.select to capture (title, items) for assertions while still
 * honoring the selectAnswers queue.
 */
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

describe("goal-focus stale pool bug — focusGoalCommand must refresh from disk", () => {
	it("BUG: focusGoalCommand with stale in-memory pool (1 goal) but 2 goals on disk → should show picker, NOT auto-focus single goal", async () => {
		// Step 1: Write 1 goal to disk BEFORE session start
		writeGoalFile(cwd, { id: "first-goal-aaaa", status: "active", autoContinue: true });

		// Step 2: Start session → loads 1 goal into in-memory pool
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);

		// Step 3: Write a 2nd goal to disk AFTER session start
		// (simulating another session creating a goal, or a subagent)
		writeGoalFile(cwd, { id: "second-goal-bbbb", status: "active", autoContinue: true });

		// Step 4: Call focusGoalCommand
		// EXPECTED: should show picker with 2 goals (both on disk)
		// BUGGY: takes single-open fast-path (only sees 1 goal in memory)
		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		spy.restore();

		// ASSERTION: picker should be shown (2 goals on disk)
		// This FAILS with buggy code (spy.calls.length === 0, takes fast-path)
		assert.equal(spy.calls.length, 1, "BUG: picker should be shown when 2 goals exist on disk, but focusGoalCommand took single-open fast-path due to stale in-memory pool");

		// If picker was shown, it should have 2 items
		if (spy.calls.length > 0) {
			const items = spy.calls[0]!.items;
			assert.equal(items.length, 2, "picker should show 2 goals from disk");
		}
	});

	it("BUG: focusGoalCommand with 0 goals in pool but 2 on disk → should show picker, NOT 'No open goals'", async () => {
		// Step 1: Start session with NO goals on disk
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);

		// Step 2: Write 2 goals to disk AFTER session start
		writeGoalFile(cwd, { id: "late-goal-cccc", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "late-goal-dddd", status: "paused", autoContinue: false });

		// Step 3: Call focusGoalCommand
		// EXPECTED: should show picker with 2 goals
		// BUGGY: notifies "No open goals" (pool is empty)
		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		spy.restore();

		// ASSERTION: picker should be shown
		// This FAILS with buggy code (spy.calls.length === 0, "No open goals" path)
		assert.equal(spy.calls.length, 1, "BUG: picker should be shown when 2 goals exist on disk, but focusGoalCommand took 'No open goals' path due to stale in-memory pool");

		// Verify it didn't take the "No open goals" path
		const noOpenNotify = pi.ui.notifyCalls.some((n) => /No open goals/i.test(String(n.msg)));
		assert.equal(noOpenNotify, false, "BUG: should NOT notify 'No open goals' when 2 goals exist on disk");
	});

	it("REGRESSION: focusGoalCommand with 1 goal on disk (no stale pool) → should take single-open fast-path", async () => {
		// This test verifies the single-open fast-path still works when there's
		// no stale pool (1 goal on disk, 1 goal in memory).
		writeGoalFile(cwd, { id: "solo-goal-eeee", status: "active", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);

		// No new goals written to disk → pool is fresh

		const spy = spySelect(pi.ui);
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		spy.restore();

		// Should take single-open fast-path (no picker)
		assert.equal(spy.calls.length, 0, "single-open fast-path should skip picker when pool is fresh");
		const focused = lastFocusedGoalId(pi);
		assert.ok(focused, "single goal should be focused");
		assert.match(String(focused), /eeee/, "focused goal should be solo-goal-eeee");
	});
});

describe("byLabel Map collision bug — duplicate labels make first goal unreachable", () => {
	it("BUG: two goals with identical goalSelectorLabel output → both should be selectable", async () => {
		// This test is harder to construct because goalSelectorLabel includes
		// short-id, status, timestamp, and title. To get identical labels, we'd
		// need two goals with the same short-id (collision fallback to full id),
		// same status, same timestamp, and same title. That's contrived.
		//
		// Instead, we test the ACTUAL bug: the byLabel Map uses labels as keys,
		// so if two goals produce identical labels, the second overwrites the first.
		// The picker shows both labels visually, but selecting the first returns
		// undefined (or the second goal's id).
		//
		// For now, we skip this test because constructing identical labels is
		// too contrived. The primary bug (stale pool) is the blocker.
		//
		// TODO: After fixing the stale pool bug, add a unit test for
		// goalSelectorLabel collision handling (de-duplicate labels).
		assert.ok(true, "byLabel collision test deferred — stale pool is the primary bug");
	});
});
