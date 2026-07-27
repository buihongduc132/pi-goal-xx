/**
 * RED tests for session_start notification gap.
 *
 * Bug: The session_start handler only notifies about multiple goals when
 * event.reason === "resume". For "new" sessions, no notification is shown,
 * leaving the user confused about why no goal is focused.
 *
 * Also: resolveSessionFocus correctly returns null with 2+ goals, but the
 * session_start notification logic is incomplete.
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
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-sess-"));
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

describe("RED — session_start must notify + NOT auto-focus with 2+ goals (all reasons)", () => {
	it("BUG: TUI session_start reason='new' with 2+ goals must notify user", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true, "tui");

		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();

		// MUST NOT auto-focus
		assert.equal(lastFocusedGoalId(pi), null, "must NOT auto-focus with 2+ goals");

		// MUST notify user about multiple goals
		const notify = pi.ui.notifyCalls.find((n) => /2 open goals/i.test(String(n.msg)));
		assert.ok(notify, `Should notify about 2 open goals on reason='new'`);
	});

	it("BUG: Non-TUI session_start reason='new' with 2+ goals must notify user", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(false);

		await emit(pi, ctx, "session_start", { reason: "new" });
		await flushContinuation();

		// MUST NOT auto-focus
		assert.equal(lastFocusedGoalId(pi), null, "must NOT auto-focus with 2+ goals");

		// MUST notify user about multiple goals
		const notify = pi.ui.notifyCalls.find((n) => /2 open goals/i.test(String(n.msg)));
		assert.ok(notify, `Should notify about 2 open goals on reason='new' (non-TUI)`);
	});

	it("BUG: session_start reason='resume' with 2+ goals must notify (already works)", async () => {
		writeGoalFile(cwd, { id: "goal-aaaa-1111", status: "paused", autoContinue: false });
		writeGoalFile(cwd, { id: "goal-bbbb-2222", status: "paused", autoContinue: false });
		const { pi, ctx } = setup(true, "tui");

		await emit(pi, ctx, "session_start", { reason: "resume" });
		await flushContinuation();

		assert.equal(lastFocusedGoalId(pi), null, "must NOT auto-focus with 2+ goals");
		const notify = pi.ui.notifyCalls.find((n) => /2 open goals/i.test(String(n.msg)));
		assert.ok(notify, "Should notify about 2 open goals on reason='resume'");
	});
});
