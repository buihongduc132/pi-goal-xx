/**
 * RED regression guards for PR #17 (commit ff36e54) — two bugs:
 *
 *  Bug 1 (RACE): concurrent pi.sendMessage / pi.sendUserMessage calls (the
 *    three triggerTurn sites: continuation, tweak drafting, goal drafting)
 *    raced past the runtime's isStreaming=true guard because nothing
 *    serialized them. The second send hit session.prompt() while the first
 *    was still streaming → "Agent is already processing".
 *    Fix: serializedSend mutex wrapping every send site.
 *
 *  Bug 2 (COMPLETE_GOAL CRASH): complete_goal.execute `await`ed
 *    pi.sendMessage for the audit-start notification while still mid
 *    tool-body. The awaited promise blocked tool execution and crashed/quit
 *    the host session.
 *    Fix: drop the `await` (fire-and-forget).
 *
 * TDD strategy:
 *  - RACE: a SOURCE-STRUCTURE guard. It reads extensions/goal.ts and asserts
 *    the serializedSend mutex exists AND that EACH of the 3 triggerTurn send
 *    sites is wrapped in `serializedSend(...)`. This is deterministic: if
 *    anyone removes serializedSend (revert), the assertion count drops and the
 *    test fails. It does not depend on a behavioral harness whose async
 *    scheduling may itself serialize the two sends.
 *  - COMPLETE_GOAL_AWAIT: a BEHAVIORAL guard. It invokes complete_goal.execute
 *    against a deferred sendMessage promise and proves execute settles WITHOUT
 *    awaiting the sendMessage (fire-and-forget). This is the real crash guard.
 *
 * RED proof (both must FAIL when the fix is reverted to ff36e54^):
 *   git show ff36e54^:extensions/goal.ts > extensions/goal.ts
 *   node --experimental-strip-types --test tests/regression-race-and-complete-goal-crash.test.ts
 *   → 2 fail. Restore ff36e54 → 2 pass.
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

const GOAL_TS = path.join(import.meta.dirname, "..", "extensions", "goal.ts");

function readGoalSource(): string {
	return fs.readFileSync(GOAL_TS, "utf8");
}

/**
 * Assert that the nearest `serializedSend` occurrence before `anchorStr` lies
 * within the same logical block (no intervening top-level statement).
 * Uses a generous lookback so a block-body lambda with multi-line pi.sendMessage
 * is still recognized as the wrapper.
 */
function assertWrappedInSerializedSend(src: string, anchorStr: string, label: string): void {
	const anchorIdx = src.indexOf(anchorStr);
	assert.ok(anchorIdx > -1, `${label}: anchor text must exist in goal.ts: ${anchorStr}`);
	const lookback = src.slice(Math.max(0, anchorIdx - 600), anchorIdx);
	assert.match(
		lookback,
		/serializedSend/,
		`${label}: the send at ${anchorStr} must be wrapped in serializedSend (race guard)`,
	);
}

// ---------------------------------------------------------------------------
// Bug 1 — RACE: serializedSend mutex source-structure guard
// ---------------------------------------------------------------------------
describe("RACE — serializedSend mutex guards the 3 triggerTurn send sites", () => {
	it("serializedSend mutex is defined in extensions/goal.ts", () => {
		const src = readGoalSource();
		// The mutex chain variable + the serializer function must both exist.
		assert.match(src, /let messageSendChain\b/, "messageSendChain mutex variable must exist");
		assert.match(src, /function serializedSend<[\s\S]*?>\([\s\S]*?\)\s*:/, "serializedSend function must be defined");
	});

	it("continuation sendMessage is wrapped in serializedSend", () => {
		const src = readGoalSource();
		// Site: sendQueuedContinuation — pi.sendMessage with triggerTurn:true, deliverAs:"followUp".
		assertWrappedInSerializedSend(
			src,
			'{ triggerTurn: true, deliverAs: "followUp" }',
			"continuation sendMessage",
		);
	});

	it("tweak-drafting sendMessage is wrapped in serializedSend", () => {
		const src = readGoalSource();
		// Site: startGoalTweakDrafting — pi.sendMessage with triggerTurn:true, deliverAs: ctx.isIdle() ? "followUp" : "steer".
		assertWrappedInSerializedSend(
			src,
			'{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" }',
			"tweak-drafting sendMessage",
		);
	});

	it("goal-drafting sendUserMessage is wrapped in serializedSend", () => {
		const src = readGoalSource();
		// Site: startGoalDrafting — pi.sendUserMessage(goalDraftingPrompt(...)).
		assertWrappedInSerializedSend(
			src,
			"pi.sendUserMessage(goalDraftingPrompt(",
			"goal-drafting sendUserMessage",
		);
	});

	it("exactly 3 triggerTurn send sites are wrapped (no send site lost its guard)", () => {
		const src = readGoalSource();
		// Count serializedSend wrapper occurrences. The function definition is 1
		// occurrence; the 3 call sites bring the total to 4. This guards against
		// anyone dropping a wrapper from one of the 3 sites.
		const matches = src.match(/serializedSend/g) ?? [];
		assert.ok(
			matches.length >= 4,
			`expected serializedSend mutex + 3 call sites (>=4 matches), found ${matches.length}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Bug G7 — MEMORY: serializedSend linked-promise chain must reset when drained
// ---------------------------------------------------------------------------
// The messageSendChain is a linked promise chain: each link references its
// predecessor, so the chain grows unbounded (one node per send) for the
// lifetime of the session, pinning memory. The fix: when the last pending
// send resolves and the queue is empty, reset messageSendChain to a fresh
// Promise.resolve() so the old chain becomes unreferenced and eligible for GC.
describe("G7 — serializedSend chain resets to Promise.resolve() when drained", () => {
	it("source has a pending-send counter that tracks outstanding sends", () => {
		const src = readGoalSource();
		assert.match(src, /pendingSends/, "G7: a pendingSends counter must exist to detect drain");
	});

	it("source resets messageSendChain to Promise.resolve() on drain", () => {
		const src = readGoalSource();
		// The reset must live inside the serializedSend resolution path, and be
		// guarded by a drained check (pendingSends === 0), not unconditional.
		assert.match(
			src,
			/if\s*\(\s*pendingSends\s*===?\s*0\s*\)\s*\{[^}]*?messageSendChain\s*=\s*Promise\.resolve\(\)/,
			"G7: serializedSend must reset messageSendChain = Promise.resolve() when pendingSends hits 0",
		);
	});

	it("source decrements pendingSends on BOTH resolve and reject paths", () => {
		const src = readGoalSource();
		// Either two explicit `pendingSends--` sites, or a shared drain handler
		// passed to BOTH slots of `.then(drain, drain)` so a rejected send does
		// not prevent the chain from ever resetting again.
		const decrements = src.match(/pendingSends--/g) ?? [];
		const sharedDrain = /\.then\(\s*drain\s*,\s*drain\s*\)/.test(src);
		assert.ok(
			decrements.length >= 2 || sharedDrain,
			`G7: pendingSends must decrement on both resolve and reject (>=2 decrements OR a shared drain handler on both .then slots), found ${decrements.length} decrement(s)${sharedDrain ? " (shared drain OK)" : ""}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Bug 2 — COMPLETE_GOAL CRASH: audit-start sendMessage must NOT be awaited
// ---------------------------------------------------------------------------
describe("COMPLETE_GOAL_AWAIT — audit-start sendMessage is fire-and-forget", () => {
	it("complete_goal.execute resolves WITHOUT awaiting the audit-start sendMessage", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-red-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		const envSnap = forceNonWorkerEnv();
		const pi: any = createMockPi({ cwd });
		const pendingResolvers: Array<() => void> = [];
		let raceTimer: ReturnType<typeof setTimeout> | undefined;

		try {
			// Load the extension with the record-only default send mock first (so
			// goal creation / continuation sends during setup are harmless).
			goalExtension(pi);

			// Configure an auditor that resolves to an immediate "model not found"
			// error so runGoalCompletionAuditor returns early instead of trying to
			// spin a real sub-agent session. The auditor is still ENABLED
			// (settings.disabled !== true) so we reach the audit-start sendMessage.
			fs.writeFileSync(
				path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
				JSON.stringify({ model: "nope/nomodel" }),
			);
			const ctx = createMockCtx(pi, { cwd, idle: false });
			ctx.modelRegistry = { find: () => undefined, getAvailable: () => [] };

			// Create + focus an active goal via the direct /goals-set command.
			await invokeCommand(pi, ctx, "goals-set", "Objective: ship it. Success criteria: shipped.");

			// NOW swap sendMessage to a deferred promise that we control. It must
			// NOT resolve until we explicitly release it. If complete_goal.execute
			// awaits it (the bug), execute will hang on this promise.
			let sendCount = 0;
			(pi as any).sendMessage = () => {
				sendCount += 1;
				return new Promise<void>((resolve) => pendingResolvers.push(resolve));
			};

			// Invoke complete_goal and race it against a timeout. With the fix
			// (fire-and-forget), execute proceeds past the sendMessage, the auditor
			// returns its early error, and execute settles — all while the
			// sendMessage promise is still pending. Without the fix (await),
			// execute blocks on the deferred promise and the timeout wins.
			const execPromise = invokeTool(pi, ctx, "complete_goal", {
				verificationSummary: "all criteria verified",
			});
			const winner = await Promise.race([
				execPromise.then(
					() => "settled" as const,
					() => "settled" as const,
				),
				new Promise<"timeout">((r) => { raceTimer = setTimeout(() => r("timeout"), 500); }),
			]);

			assert.equal(
				winner,
				"settled",
				"complete_goal.execute blocked on the audit-start sendMessage — it must be fire-and-forget, not awaited",
			);
			assert.ok(
				sendCount >= 1,
				"the audit-start sendMessage must still be invoked (fire-and-forget, not removed)",
			);
		} finally {
			// Guarantee cleanup even on assertion failure or timeout so no timer,
			// deferred promise, env var, or temp dir leaks into sibling tests.
			if (raceTimer) clearTimeout(raceTimer);
			for (const fn of pendingResolvers) { try { fn(); } catch {} }
			restoreGoalEnv(envSnap);
			await cleanupTimers(pi, cwd);
			try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});
});
