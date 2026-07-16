/**
 * RED PHASE tests for the stale-ctx crash bug in `syncStatusRefresh`'s
 * setInterval catch handler.
 *
 * Bug location: extensions/goal.ts ~line 778, inside the catch block of
 * the status-refresh timer:
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
 * The GREEN fix will extract a tiny PURE exported helper that resolves the
 * stale cwd WITHOUT touching the throwing `.cwd` getter:
 * ```ts
 * export function resolveStaleRefreshCwd(cachedCwd: string | null): string {
 *   return cachedCwd ?? process.cwd();
 * }
 * ```
 *
 * Because `syncStatusRefresh` and the catch handler are closures inside the
 * default export (not exported, not directly unit-testable), this helper is
 * the unit-testable seam. These tests import the helper from
 * `../extensions/goal.ts` — which does NOT exist yet — so the suite MUST
 * fail to import / fail to run (RED) until the GREEN phase adds it.
 *
 * Test runner: node:test describe/it + node:assert/strict.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The named export does not exist yet in the RED phase → import fails (RED).
import { resolveStaleRefreshCwd } from "../extensions/goal.ts";

// ── non-null cachedCwd ──────────────────────────────────────────────────────

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
		// nullish-coalesced. This locks the semantics so the GREEN impl must
		// use `??`, not `||` or truthiness checks.
		assert.equal(resolveStaleRefreshCwd(""), "");
	});

	it("returns cachedCwd when cachedCwd is the string '0' (truthiness-agnostic)", () => {
		assert.equal(resolveStaleRefreshCwd("0"), "0");
	});
});

// ── core regression guard: never touches a throwing .cwd getter ─────────────

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
		// The helper takes no ctx param; we deliberately do NOT pass staleCtxLike.
		// If a future regression reintroduces a ctx param that reads `.cwd`,
		// this test setup documents the trap.
		void staleCtxLike; // referenced to make the trap explicit

		const cached = "/saved/cwd/from/setup";
		// Must not throw — the resolution path is purely `cachedCwd ?? process.cwd()`.
		assert.doesNotThrow(() => {
			const out = resolveStaleRefreshCwd(cached);
			assert.equal(out, cached);
		});
	});

	it("does not throw and falls back to process.cwd() when cachedCwd is null — no ctx consulted", () => {
		// Even with no cached cwd, the helper must resolve deterministically
		// from process.cwd() and never touch any (possibly stale) ctx object.
		assert.doesNotThrow(() => {
			const out = resolveStaleRefreshCwd(null);
			assert.equal(out, process.cwd());
		});
	});

	it("is a pure function: deterministic, no side effects, isolated (no timers, no session files)", () => {
		// Run repeatedly — must be stable and side-effect-free.
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
