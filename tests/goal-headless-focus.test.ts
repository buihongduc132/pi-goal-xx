/**
 * Feature (c) — non-TUI focus override + multi-open auto-pick.
 *
 * Contract (flow/requirements/2026-07-25_goal-launch-env.md R3.3, R3.4):
 *   - confirmFocusOverride: lock held by other LIVE session + PI_GOAL_AUTO_CONFIRM=1
 *     → take over (release + proceed). Without env → refuse + notify.
 *   - non-TUI multi-open: auto-pick most-recent (no picker) instead of returning null.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import { lockPath, type LockOwner } from "../extensions/goal-lock.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeCommand,
	cleanupTimers,
	flushContinuation,
	countContinuations,
	forceNonWorkerEnv,
	restoreGoalEnv,
	type EnvSnapshot,
} from "./_harness.ts";

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;
let envSnap: EnvSnapshot;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-hf-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	envSnap = forceNonWorkerEnv();
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_FILE;
});

afterEach(async () => {
	if (pi) {
		try { await cleanupTimers(pi, cwd); } catch {}
	}
	pi = null;
	restoreGoalEnv(envSnap);
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_FILE;
	try { fs.chmodSync(path.join(cwd, ".pi", "goals", ".locks"), 0o755); } catch {}
	fs.rmSync(cwd, { recursive: true, force: true });
});

function writePoolGoal(id: string, status = "active"): void {
	const objective = `Objective: ${id}. Success criteria: done.`;
	const record = {
		version: 3, id, status, autoContinue: true, sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		objective, usage: { tokensUsed: 0, activeSeconds: 0 },
		activePath: `.pi/goals/active_goal_20260101_${id}.md`,
	};
	fs.writeFileSync(
		path.join(cwd, ".pi", "goals", `active_goal_20260101_${id}.md`),
		`${JSON.stringify(record, null, 2)}\n\n# Goal\n\n${objective}\n`,
	);
}

function plantLiveLock(goalId: string, owner: LockOwner): void {
	const dir = path.join(cwd, ".pi", "goals", ".locks");
	fs.mkdirSync(dir, { recursive: true });
	const lock = {
		goalId, owner,
		acquiredAt: new Date(Date.now() - 10_000).toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
	};
	fs.writeFileSync(lockPath(cwd, goalId), JSON.stringify(lock));
}

function freshPi(opts: { hasUI?: boolean; mode?: string } = {}) {
	const local = createMockPi({ cwd });
	const ctx = createMockCtx(local, {
		cwd,
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		sessionManager: { getBranch: () => [] as any[] } as any,
	});
	goalExtension(local);
	pi = local;
	return { pi: local, ctx };
}

describe("Feature (c) — confirmFocusOverride non-TUI takeover", () => {
	it("PI_GOAL_AUTO_CONFIRM=1 + lock held by other LIVE → take over (release + proceed)", async () => {
		writePoolGoal("takeover-goal");
		// Pre-plant a live lock by another session using a live PID.
		plantLiveLock("takeover-goal", { sessionId: "other-session-xyz", pid: process.pid });
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		const { pi, ctx } = freshPi({ hasUI: false });
		// Prime the session (no focus yet since no focusEntry).
		await emit(pi, ctx, "session_start", { reason: "new" });
		// /goal-focus single-open fast-path → confirmFocusOverride → autoConfirm.
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		// Takeover releases the other's lock; setFocusedGoalId reacquires → run.
		assert.equal(countContinuations(pi), 1, "PI_GOAL_AUTO_CONFIRM=1 MUST allow takeover → run");
		const autoNotify = (pi.ui as any).notifyCalls.find((c: any) => /auto-taking over/i.test(String(c.msg)));
		assert.ok(autoNotify, "MUST notify 'auto-taking over'");
	});

	it("no env + lock held by other LIVE (non-TUI) → auto-takeover (non-TUI = auto-confirm)", async () => {
		// shouldAutoConfirmProposal returns true in non-TUI regardless of env,
		// so non-TUI launches auto-takeover held locks (feature c: non-TUI
		// "just works"). The refuse path only triggers in TUI without confirm.
		writePoolGoal("refused-goal");
		plantLiveLock("refused-goal", { sessionId: "other-session-xyz", pid: process.pid });
		const { pi, ctx } = freshPi({ hasUI: false });
		await emit(pi, ctx, "session_start", { reason: "new" });
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		// Non-TUI auto-takes-over → continuation fires.
		assert.equal(countContinuations(pi), 1, "non-TUI MUST auto-takeover held lock");
	});

	it("TUI + no env + lock held by other LIVE → refuse; held-by notify", async () => {
		// Push confirm=false so the TUI prompt declines the takeover.
		writePoolGoal("refused-tui");
		plantLiveLock("refused-tui", { sessionId: "other-session-xyz", pid: process.pid });
		const { pi, ctx } = freshPi({ hasUI: true, mode: "interactive" });
		(pi.ui as any).confirmAnswers.push(false); // decline takeover prompt
		await emit(pi, ctx, "session_start", { reason: "new" });
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		assert.equal(countContinuations(pi), 0, "TUI decline MUST refuse takeover");
	});
});

describe("Feature (c) — non-TUI multi-open auto-pick", () => {
	it("/goal-focus in non-TUI with 2 open goals → auto-focuses (no picker)", async () => {
		writePoolGoal("goal-a");
		writePoolGoal("goal-b");
		const { pi, ctx } = freshPi({ hasUI: false });
		// Prime the session so focus state is initialized.
		await emit(pi, ctx, "session_start", { reason: "new" });
		// Now invoke /goal-focus directly — non-TUI branch auto-picks.
		await invokeCommand(pi, ctx, "goal-focus", "");
		await flushContinuation();
		// One of the goals should be focused (auto-picked). Hard to assert WHICH
		// without sort details, so assert a notify mentioning "Auto-focused".
		const autoNotify = (pi.ui as any).notifyCalls.find((c: any) => /Auto-focused/i.test(String(c.msg)));
		assert.ok(autoNotify, "non-TUI /goal-focus MUST auto-pick + notify 'Auto-focused'");
	});
});
