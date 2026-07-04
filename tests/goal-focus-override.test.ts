/**
 * add-goal-focus-locking — Unit F: /goal-focus override flow (tasks 5.1–5.7, LD2).
 *
 * Real harness-based behavioral tests for confirmFocusOverride + focusGoalCommand.
 * The override prompt fires BEFORE setFocusedGoalId; setFocusedGoalId's
 * acquireLock is silent (no prompt). Headless (!ctx.hasUI) refuses; stale locks
 * are silently reaped; live locks held by another session prompt the user.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	acquireLock,
	readLock,
	isLockHeld,
	type LockOwner,
} from "../extensions/goal-lock.ts";
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

const OTHER: LockOwner = { sessionId: "other-override-session", pid: process.pid };

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ovr-"));
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

/** Populate goalsById from disk via session_start (non-resume reason → no auto-focus). */
async function loadGoals(pi: ReturnType<typeof createMockPi>, ctx: any) {
	await emit(pi, ctx, "session_start", { reason: "new" });
	await flushContinuation();
}

/** Plant a live lock held by OTHER. */
function plantOtherLiveLock(goalId: string) {
	acquireLock(cwd, goalId, OTHER, 180_000);
}

/** Plant a stale lock (expired lease, OTHER owner). */
function plantStaleLock(goalId: string) {
	const dir = path.join(cwd, ".pi", "goals", ".locks");
	fs.mkdirSync(dir, { recursive: true });
	const lock = {
		goalId,
		owner: OTHER,
		acquiredAt: new Date(Date.now() - 60_000).toISOString(),
		expiresAt: new Date(Date.now() - 1_000).toISOString(),
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
	};
	fs.writeFileSync(path.join(dir, `${goalId}.lock`), JSON.stringify(lock));
}

describe("Unit F — /goal-focus override flow (tasks 5.1–5.7)", () => {
	it("5.1+5.6: headless (!ctx.hasUI) + held-by-other → override REFUSED (cannot prompt)", async () => {
		writeGoalFile(cwd, { id: "locked-goal", autoContinue: true });
		const { pi, ctx } = setup(false /* headless */);
		await loadGoals(pi, ctx);
		plantOtherLiveLock("locked-goal");

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// Focus unchanged: refused, no takeover.
		const refused = pi.ui.notifyCalls.some((n) => /Cannot prompt|headless|held by/i.test(String(n.msg)));
		assert.ok(refused, "headless refused with a warning");
		// Lock still belongs to OTHER.
		const lock = readLock(cwd, "locked-goal");
		assert.ok(lock && lock.owner.sessionId === OTHER.sessionId, "lock not stolen in headless");
	});

	it("5.2+5.3: override CONFIRMED → reaps held + acquires fresh (self owns the lock after)", async () => {
		writeGoalFile(cwd, { id: "held-goal", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);
		plantOtherLiveLock("held-goal");
		// Confirm the takeover dialog.
		(pi.ui as any).confirmAnswers.length = 0;
		(pi.ui as any).confirmAnswers.push(true);
		// Fast-path (1 open goal) goes through confirmFocusOverride directly.
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// Lock now owned by SELF (acquired fresh after reaping OTHER's).
		const lock = readLock(cwd, "held-goal");
		assert.ok(lock, "lock present after takeover");
		assert.ok(lock!.owner.sessionId !== OTHER.sessionId, "lock no longer owned by other");
		assert.ok(isLockHeld(lock!), "fresh lock is live");
	});

	it("5.4: override DECLINED → no change (lock untouched)", async () => {
		writeGoalFile(cwd, { id: "declined-goal", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);
		plantOtherLiveLock("declined-goal");
		(pi.ui as any).confirmAnswers.length = 0;
		(pi.ui as any).confirmAnswers.push(false); // decline

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		const lock = readLock(cwd, "declined-goal");
		assert.ok(lock && lock.owner.sessionId === OTHER.sessionId, "decline leaves other's lock intact");
	});

	it("5.5: override on STALE lock → silent reap + acquire (no prompt)", async () => {
		writeGoalFile(cwd, { id: "stale-goal", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);
		plantStaleLock("stale-goal");
		(pi.ui as any).confirmAnswers.length = 0;
		(pi.ui as any).confirmAnswers.push(false); // should NOT be consulted

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// No confirm dialog was needed (stale → silent).
		const confirmNotConsulted = (pi.ui as any).confirmAnswers.length === 1; // still queued
		assert.ok(confirmNotConsulted, "stale lock does not prompt");
		// Lock now owned by SELF (fresh acquire after silent reap).
		const lock = readLock(cwd, "stale-goal");
		assert.ok(lock && lock.owner.sessionId !== OTHER.sessionId, "stale lock reaped + self acquired");
	});

	it("5.7: fast-path (single open goal) on held-by-other → prompts before setFocusedGoalId", async () => {
		writeGoalFile(cwd, { id: "fast-goal", autoContinue: true });
		const { pi, ctx } = setup(true);
		await loadGoals(pi, ctx);
		plantOtherLiveLock("fast-goal");
		// Capture the order: confirm must fire BEFORE any focus entry append.
		const order: string[] = [];
		const origConfirm = (pi.ui as any).confirm.bind(pi.ui);
		(pi.ui as any).confirm = async (prompt: string) => {
			order.push("confirm");
			return origConfirm(prompt);
		};
		const origAppend = (pi as any).appendEntry.bind(pi);
		(pi as any).appendEntry = (customType: string) => {
			if (customType === "pi-goal-focus") order.push("focusEntry");
			origAppend(customType);
		};
		(pi.ui as any).confirmAnswers.length = 0;
		(pi.ui as any).confirmAnswers.push(true);

		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();

		// confirm fired, and it fired before the focus-entry append.
		assert.ok(order.includes("confirm"), "fast-path prompted on held goal");
		const confirmIdx = order.indexOf("confirm");
		const focusIdx = order.indexOf("focusEntry");
		assert.ok(focusIdx > confirmIdx, `prompt must fire BEFORE setFocusedGoalId (order: ${order.join(",")})`);
		// And the lock was taken over.
		const lock = readLock(cwd, "fast-goal");
		assert.ok(lock && lock.owner.sessionId !== OTHER.sessionId, "self acquired after confirm");
	});
});
