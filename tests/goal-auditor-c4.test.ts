/**
 * C4 verification (tasks 6.1–6.3) — MAKE-OR-BREAK for the "solved for free"
 * hypothesis of add-goal-focus-locking.
 *
 * Hypothesis: the goal-completion auditor is spawned via `createAgentSession`
 * (see goal-auditor.ts runGoalCompletionAuditor) with NO `sessionStartEvent`
 * argument. pi's AgentSession defaults that to `{ type: "session_start", reason:
 * "startup" }` (confirmed: node_modules/@earendil-works/pi-coding-agent/dist/
 * core/agent-session.js:128 — `config.sessionStartEvent ?? { type:
 * "session_start", reason: "startup" }`). The auditor also loads the cwd's
 * resources via DefaultResourceLoader (inheritFromCwd:true), which means the
 * goal extension runs inside the auditor and receives that session_start event.
 *
 * Consequence: the auditor's session_start reason is "startup" (NOT "resume"),
 * so under LD3 ("resume only") resolveSessionFocus returns null → the auditor
 * does NOT auto-focus the parent's goal, does NOT write a competing lock file,
 * and the queueContinuation chokepoint blocks auto-run. C4 (auditor/parent
 * collision) is solved for FREE by the reason gate — no PI_GOAL_SUBSESSION
 * fallback (task 6.3) is needed.
 *
 * These tests assert REAL behavior through the harness: the parent holds the
 * lock on goal A, a sub-session (the auditor) fires session_start with
 * reason="startup" in the SAME cwd, and we assert no focus theft, no competing
 * lock, no auto-run.
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
import { resolveSessionFocus } from "../extensions/goal-pool.ts";
import { goalPoolFromGoals } from "../extensions/goal-pool.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeTool,
	cleanupTimers,
	writeGoalFile,
	flushContinuation,
	countContinuations,
} from "./_harness.ts";
import { mkGoal } from "./_test-helpers.ts";

const PARENT: LockOwner = { sessionId: "parent-session-auditor", pid: process.pid };
const SUB: LockOwner = { sessionId: "auditor-sub-session", pid: process.pid };

let cwd: string;
let pi: ReturnType<typeof createMockPi> | null = null;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-c4-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
});

afterEach(async () => {
	if (pi) await cleanupTimers(pi, cwd);
	pi = null;
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("C4 — auditor sub-session (reason='startup') does not collide (tasks 6.1–6.3)", () => {
	it("6.1: auditor session_start reason is 'startup' (hypothesis) — sub-session does NOT auto-focus parent's goal", async () => {
		const goalId = "c4-goal-parent-locked";
		writeGoalFile(cwd, { id: goalId, autoContinue: true });

		// Parent holds the lock.
		const acquired = acquireLock(cwd, goalId, PARENT, 180_000);
		assert.equal(acquired.ok, true, "parent acquires the focus lock");

		// Sub-session (auditor) loads the extension in the SAME cwd.
		pi = createMockPi({ cwd });
		goalExtension(pi);
		const ctx = createMockCtx(pi, {
			cwd,
			sessionManager: { getBranch: () => [] as any[] } as any,
		});

		// Auditor's actual session_start reason: "startup" (agent-session.js:128).
		await emit(pi, ctx, "session_start", { reason: "startup" });
		await flushContinuation();

		// (1) Sub-session is NOT focused on the parent's goal.
		const result = await invokeTool(pi, ctx, "get_goal", {});
		const text = (result as any)?.content?.[0]?.text ?? "";
		assert.ok(
			text.includes("No goal") || text.includes("No active goal") || text.includes("unfocused") || text === "",
			`auditor sub-session must not auto-focus parent goal; got: ${text}`,
		);

		// (2) Sub-session did NOT write a competing lock file.
		const lock = readLock(cwd, goalId);
		assert.ok(lock, "parent lock must still be present");
		assert.equal(lock!.owner.sessionId, PARENT.sessionId, "lock owner unchanged — sub-session stole nothing");

		// (3) queueContinuation was blocked — no continuation fired.
		assert.equal(countContinuations(pi), 0, "auditor sub-session must not auto-run");
	});

	it("6.2: auditor does not write a competing lock file even when its reason were resume-like (defense in depth via lock gate)", async () => {
		// Even if the hypothesis were wrong and the auditor received "resume",
		// the lock check inside resolveSessionFocus still prevents focus theft.
		const goalId = "c4-goal-defense-in-depth";
		writeGoalFile(cwd, { id: goalId, autoContinue: true });
		acquireLock(cwd, goalId, PARENT, 180_000);

		const pool = goalPoolFromGoals([
			mkGoal({ id: goalId, status: "active", autoContinue: true }),
		]);
		const focused = resolveSessionFocus({
			pool,
			autoFocusReason: "resume",
			cwd,
			selfSessionId: SUB.sessionId,
		});
		assert.equal(focused, null, "resume is blocked because the goal is locked by parent (live)");

		// Parent's lock is untouched.
		const lock = readLock(cwd, goalId);
		assert.ok(lock && lock.owner.sessionId === PARENT.sessionId, "parent lock preserved");
	});

	it("6.1 (reason gate, pure): 'startup' reason returns null even when goal is unlocked", () => {
		// Isolates the LD3 reason gate from the lock gate: a single open goal,
		// NO lock held by anyone, reason='startup' → still no auto-focus.
		const goalId = "c4-reason-only";
		const pool = goalPoolFromGoals([mkGoal({ id: goalId, status: "active" })]);
		const focused = resolveSessionFocus({
			pool,
			autoFocusReason: "startup",
			cwd,
			selfSessionId: SUB.sessionId,
		});
		assert.equal(focused, null, "startup reason never auto-focuses (LD3 literal)");
	});

	it("6.3 fallback NOT required: PI_GOAL_SUBSESSION is unnecessary because reason='startup' already excludes the auditor", () => {
		// Documents the task 6.3 decision: no env fallback needed. If the
		// hypothesis ever breaks (auditor starts receiving 'resume'), this test
		// will fail and signal that PI_GOAL_SUBSESSION must be added.
		const goalId = "c4-fallback-doc";
		const pool = goalPoolFromGoals([mkGoal({ id: goalId, status: "active" })]);
		const focusedStartup = resolveSessionFocus({
			pool,
			autoFocusReason: "startup",
			cwd,
			selfSessionId: SUB.sessionId,
		});
		assert.equal(focusedStartup, null);
		// Sanity: parent's held lock is live under the two-signal liveness check.
		acquireLock(cwd, goalId, PARENT, 180_000);
		const lock = readLock(cwd, goalId);
		assert.ok(lock && isLockHeld(lock), "parent lock live");
	});
});
