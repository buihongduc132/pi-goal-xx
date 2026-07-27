/**
 * goal-no-autofocus-multi — RED tests for the auto-focus bug with 2+ goals.
 *
 * BUG: When 2+ open goals exist, focusGoalCommand and chooseOpenGoal in
 * non-TUI mode auto-pick the most-recent goal WITHOUT letting the user
 * select. The user has NO way to choose which goal to focus.
 *
 * User requirement (verbatim): "2 goals, and it is AUTO focus; I am in TUI,
 * and even in NON-TUI, it MUST NOT auto focus like that, if so then how the
 * HELL can we selecting the GOAL?"
 *
 * REQUIRED BEHAVIOR:
 * 1. focusGoalCommand non-TUI with 2+ goals: MUST NOT auto-focus. Show list.
 * 2. chooseOpenGoal non-TUI with 2+ goals: MUST NOT auto-focus. Return null.
 * 3. session_start resume with 2+ goals: MUST NOT auto-focus.
 * 4. /goal-focus <short-id>: Accept argument to focus specific goal (non-TUI selection path).
 *
 * These tests FAIL on current code (auto-focus still happens).
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
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-noauto-"));
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

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: focusGoalCommand MUST NOT auto-focus with 2+ goals
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — focusGoalCommand must NOT auto-focus with 2+ goals", () => {
	it("BUG: non-TUI focusGoalCommand with 2+ goals auto-focuses instead of showing list", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// MUST NOT auto-focus
		const autoNotify = pi.ui.notifyCalls.find((n) => /Auto-focused/i.test(String(n.msg)));
		assert.ok(!autoNotify, `non-TUI must NOT auto-focus with 2+ goals. Got: ${autoNotify?.msg}`);

		// MUST NOT have focused any goal
		assert.equal(lastFocusedGoalId(pi), null, "must not focus any goal without user selection");
	});

	it("BUG: non-TUI focusGoalCommand with 2+ goals must show goal list for user to select", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// MUST show list containing both goals
		const notifyText = pi.ui.notifyCalls.map((n) => String(n.msg)).join("\n");
		assert.ok(notifyText.includes("1111") || notifyText.includes("aaaa"), `list must include goal-aaaa: ${notifyText}`);
		assert.ok(notifyText.includes("2222") || notifyText.includes("bbbb"), `list must include goal-bbbb: ${notifyText}`);
	});

	it("BUG: TUI focusGoalCommand with 2+ goals must show picker (not auto-focus)", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true /* TUI */);
		await loadGoals(pi, ctx);

		// Spy on select to verify picker is shown
		const selectCalls: Array<{ title?: any; items: any[] }> = [];
		const origSelect = pi.ui.select.bind(pi.ui);
		pi.ui.select = async (...args: any[]) => {
			selectCalls.push({ title: args[0], items: args[1] ?? args[0] });
			return null; // simulate cancel
		};

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		pi.ui.select = origSelect;

		// Picker MUST be shown (not auto-focus path)
		assert.ok(selectCalls.length >= 1, `picker must be shown in TUI with 2+ goals`);
		assert.equal(selectCalls[0]!.items.length, 2, "picker must show 2 goals");

		// MUST NOT auto-focus notification
		const autoNotify = pi.ui.notifyCalls.find((n) => /Auto-focused/i.test(String(n.msg)));
		assert.ok(!autoNotify, "TUI must NOT auto-focus with 2+ goals");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: session_start resume MUST NOT auto-focus with 2+ goals
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — session_start resume must NOT auto-focus with 2+ goals", () => {
	it("BUG: non-TUI session_start resume with 2+ goals auto-focuses", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);

		// Emit session_start with reason "resume" (simulates reopening pi)
		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		// MUST NOT auto-focus
		const autoNotify = pi.ui.notifyCalls.find((n) => /Auto-focused/i.test(String(n.msg)));
		assert.ok(!autoNotify, `session_start resume must NOT auto-focus with 2+ goals. Got: ${autoNotify?.msg}`);

		// MUST NOT have focused any goal without user selection
		assert.equal(lastFocusedGoalId(pi), null, "session_start must not focus any goal without user selection");
	});

	it("BUG: TUI session_start resume with 2+ goals must not auto-focus", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true /* TUI */);

		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		// MUST NOT auto-focus at session_start
		const autoNotify = pi.ui.notifyCalls.find((n) => /Auto-focused/i.test(String(n.msg)));
		assert.ok(!autoNotify, "TUI session_start must NOT auto-focus with 2+ goals");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: /goal-focus <short-id> must accept argument (non-TUI selection)
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — /goal-focus <id> must accept argument for non-TUI selection", () => {
	it("BUG: /goal-focus <short-id> in non-TUI must focus the specified goal", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		// Focus goal-bbbb by short-id suffix
		await invokeCommand(pi, ctx, "goal-focus", "2222");
		await flushContinuation();

		const focused = lastFocusedGoalId(pi);
		assert.ok(focused, "must focus the goal specified by argument");
		assert.match(String(focused), /bbbb/, `must focus goal-bbbb, got ${focused}`);
	});

	it("BUG: /goal-focus <full-id> in non-TUI must focus the specified goal", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "goal-bbbb-2222");
		await flushContinuation();

		const focused = lastFocusedGoalId(pi);
		assert.ok(focused, "must focus the goal specified by full id");
		assert.match(String(focused), /bbbb/, `must focus goal-bbbb, got ${focused}`);
	});

	it("BUG: /goal-focus <invalid-id> in non-TUI must NOT focus and must notify", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "active", autoContinue: true });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "nonexistent");
		await flushContinuation();

		assert.equal(lastFocusedGoalId(pi), null, "must not focus on invalid id");
		const warn = pi.ui.notifyCalls.some((n) => /not found|no match|invalid/i.test(String(n.msg)));
		assert.ok(warn, "must notify that id was not found");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: Single-goal and empty-pool behavior preserved (regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("regression guard — single-goal and empty-pool still work", () => {
	it("single goal: non-TUI focusGoalCommand fast-paths (no picker, no list)", async () => {
		writeGoalFile(cwd, { id: "solo-goal-eeee", status: "active", autoContinue: true });
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// Single goal: fast-path focus is OK (no ambiguity)
		const focused = lastFocusedGoalId(pi);
		assert.ok(focused, "single goal must be focused via fast-path");
		assert.match(String(focused), /eeee/);
	});

	it("empty pool: non-TUI focusGoalCommand notifies 'No open goals'", async () => {
		const { pi, ctx } = setup(false /* non-TUI */);
		await loadGoals(pi, ctx);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		const guided = pi.ui.notifyCalls.some((n) => /No open goals/i.test(String(n.msg)));
		assert.ok(guided, "notifies 'No open goals' when pool is empty");
		assert.equal(lastFocusedGoalId(pi), null, "no focus when pool is empty");
	});
});
