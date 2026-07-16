/**
 * Tests for the stale-ctx crash bug in `syncStatusRefresh`'s setInterval
 * catch handler.
 *
 * Bug location: extensions/goal.ts, inside the catch block of the
 * status-refresh timer. The original code read:
 * ```ts
 * const _staleCwd = statusRefreshCtx?.cwd ?? cachedCwd ?? process.cwd();
 * ```
 * Root cause: `statusRefreshCtx?.cwd` uses optional chaining, which only
 * guards null/undefined. When the captured ctx is STALE it is non-null, so
 * its `.cwd` getter is invoked. That getter calls `runner.assertActive()`
 * (node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:389-390)
 * which THROWS the stale error again — escaping the timer catch handler →
 * uncaughtException → pi host crash.
 *
 * Fix: a pure exported helper resolves the cwd WITHOUT touching the throwing
 * `.cwd` getter, and the catch handler calls it instead:
 * ```ts
 * export function resolveStaleRefreshCwd(cachedCwd: string | null): string {
 *   return cachedCwd ?? process.cwd();
 * }
 * ```
 *
 * Two test layers:
 *  1. Unit tests for the pure helper (nullish-coalescing semantics, no ctx
 *     access). These lock the helper's contract.
 *  2. A timer-level integration test that loads the real extension, starts the
 *     status-refresh interval, then makes the captured ctx's `.cwd` getter
 *     throw (simulating a stale runner ctx) and asserts NO uncaughtException
 *     escapes the timer callback. This is the direct regression guard for the
 *     catch-handler wiring — it fails if anyone re-introduces
 *     `statusRefreshCtx?.cwd` inside the catch.
 *
 * Test runner: node:test describe/it + node:assert/strict.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveStaleRefreshCwd } from "../extensions/goal.ts";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	emit,
	invokeCommand,
	cleanupTimers,
	forceNonWorkerEnv,
	restoreGoalEnv,
} from "./_harness.ts";

// ── unit: non-null cachedCwd ────────────────────────────────────────────────

describe("resolveStaleRefreshCwd — cached cwd resolution", () => {
	it("returns cachedCwd when provided (non-null)", () => {
		const cached = "/some/cached/cwd";
		assert.equal(resolveStaleRefreshCwd(cached), cached);
	});

	it("returns process.cwd() when cachedCwd is null", () => {
		assert.equal(resolveStaleRefreshCwd(null), process.cwd());
	});

	it("returns cachedCwd when cachedCwd is the empty string '' (?? only falls through on null/undefined)", () => {
		// `cachedCwd ?? process.cwd()` keeps '' as-is — empty string is NOT
		// nullish-coalesced. This locks the semantics so the impl must
		// use `??`, not `||` or truthiness checks.
		assert.equal(resolveStaleRefreshCwd(""), "");
	});

	it("returns cachedCwd when cachedCwd is the string '0' (truthiness-agnostic)", () => {
		assert.equal(resolveStaleRefreshCwd("0"), "0");
	});
});

// ── unit: never touches a throwing .cwd getter ──────────────────────────────

describe("resolveStaleRefreshCwd — stale-ctx crash regression guard", () => {
	it("NEVER accesses a throwing .cwd getter (helper ignores any ctx entirely)", () => {
		// A stale-ctx-like object whose `.cwd` getter THROWS the stale error
		// (mimicking runner.assertActive()). The helper signature takes ONLY
		// `cachedCwd: string | null` — it must NOT accept or read any ctx, so
		// passing a throwing object is impossible by design. This test asserts
		// the pure signature: the resolution succeeds WITHOUT any ctx argument.
		const staleCtxLike = {
			get cwd(): string {
				throw new Error("runner: context is stale (assertActive failed)");
			},
		};
		void staleCtxLike; // documents the trap; helper cannot read it by signature

		const cached = "/saved/cwd/from/setup";
		assert.doesNotThrow(() => {
			const out = resolveStaleRefreshCwd(cached);
			assert.equal(out, cached);
		});
	});

	it("does not throw and falls back to process.cwd() when cachedCwd is null — no ctx consulted", () => {
		assert.doesNotThrow(() => {
			const out = resolveStaleRefreshCwd(null);
			assert.equal(out, process.cwd());
		});
	});

	it("is a pure function: deterministic, no side effects, isolated (no timers, no session files)", () => {
		const cached = "/deterministic/cwd";
		const a = resolveStaleRefreshCwd(cached);
		const b = resolveStaleRefreshCwd(cached);
		const c = resolveStaleRefreshCwd(null);
		const d = resolveStaleRefreshCwd(null);
		assert.equal(a, b, "non-null input must be deterministic");
		assert.equal(c, d, "null input must be deterministic");
		assert.equal(a, cached);
		assert.equal(c, process.cwd());
	});
});

// ── integration: the actual setInterval catch handler must not crash ────────
//
// This is the direct regression guard for the catch-handler WIRING. It loads
// the real goal.ts extension, starts the status-refresh interval with a valid
// ctx, then flips the captured ctx's `.cwd` getter to throw (simulating a stale
// runner ctx after session replacement). The interval's try block reads
// `statusRefreshCtx.cwd` (for isLockHeldBySelf), which now throws → the catch
// handler runs. If the catch handler reads `statusRefreshCtx?.cwd` again (the
// old bug), it re-throws INSIDE the catch → the throw escapes the setInterval
// callback → 'uncaughtException'. With the fix, the catch uses
// resolveStaleRefreshCwd(cachedCwd) and no throw escapes.

describe("status-refresh timer — stale-ctx catch handler integration", () => {
	function makeCwd(): string {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-stale-ctx-"));
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		return cwd;
	}

	it("does NOT raise uncaughtException when the captured ctx goes stale mid-tick", async () => {
		const envSnap = forceNonWorkerEnv();
		const cwd = makeCwd();
		let pi: ReturnType<typeof createMockPi> | null = null;
		try {
			pi = createMockPi({ cwd, hasUI: true });
			goalExtension(pi);
			const ctx = createMockCtx(pi, { cwd, hasUI: true, idle: false });
			ctx.modelRegistry = { find: () => undefined, getAvailable: () => [] } as any;

			// Focus + activate a goal so updateUI() takes the statusRefresh path
			// (it early-returns when no goal is focused).
			await invokeCommand(pi, ctx, "goals-set", "Objective: ship it. Success criteria: shipped.");
			// Fire turn_start → updateUI(ctx) → syncStatusRefresh(ctx) starts the
			// setInterval with statusRefreshCtx = ctx and cachedCwd = cwd.
			await emit(pi, ctx, "turn_start", {});

			// Sanity: the UI status was set at least once (refresh path active).
			assert.ok((pi.ui as any).statusSet.length > 0, "status refresh path did not run");

			// Simulate the ctx going stale: its `.cwd` getter now throws, exactly
			// like runner.assertActive() does after session replacement.
			Object.defineProperty(ctx, "cwd", {
				configurable: true,
				get() {
					throw new Error("stale ctx: assertActive failed");
				},
			});

			// Catch any throw that escapes the setInterval callback. With the bug
			// present, the catch handler's `statusRefreshCtx?.cwd` re-throws and
			// surfaces here as 'uncaughtException'. With the fix, nothing fires.
			let escaped: Error | null = null;
			const onUncaught = (err: Error) => {
				escaped = err;
			};
			process.once("uncaughtException", onUncaught);

			// STATUS_REFRESH_MS is 1000ms. Wait past one tick so the interval
			// callback fires with the now-throwing ctx.
			await new Promise((resolve) => setTimeout(resolve, 1150));

			process.removeListener("uncaughtException", onUncaught);

			assert.equal(
				escaped,
				null,
				`timer catch handler must not crash the host when ctx goes stale; got uncaughtException: ${escaped?.message ?? ""}`,
			);
		} finally {
			if (pi) await cleanupTimers(pi, cwd);
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch {}
			restoreGoalEnv(envSnap);
		}
	});
});
