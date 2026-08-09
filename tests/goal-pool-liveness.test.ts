/**
 * Pool liveness display — tests for sortGoalsForPicker + goalSelectorLabel + buildGoalListText
 * with liveness-aware parameters.
 * RED PHASE: These tests define expected behavior for tasks 4 and 5 of goal-display-liveness.
 * They MUST FAIL until the implementation is added.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	goalPoolFromGoals,
	goalSelectorLabel,
	buildGoalListText,
	sortGoalsForPicker,
} from "../extensions/goal-pool.ts";
import { mkGoal } from "./_test-helpers.ts";

// ── sortGoalsForPicker with liveLockHolderSet ────────────────────────────────

describe("sortGoalsForPicker — liveness-aware ranking (task 4)", () => {
	it("running goal IN set → sorts first (rank 0)", () => {
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const paused = mkGoal({ id: "paused", status: "paused", updatedAt: "2026-06-01T00:00:00Z" });
		const liveSet = new Set(["running"]);
		const sorted = sortGoalsForPicker([paused, running], liveSet);
		assert.equal(sorted[0]!.id, "running");
		assert.equal(sorted[1]!.id, "paused");
	});

	it("running goal NOT in set → demoted to rank 1 (same as non-running)", () => {
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const paused = mkGoal({ id: "paused", status: "paused", updatedAt: "2026-06-01T00:00:00Z" });
		const liveSet = new Set<string>([]); // empty → running goal NOT in set
		const sorted = sortGoalsForPicker([running, paused], liveSet);
		// Both rank 1 → sort by updatedAt desc → paused (newer) first
		assert.equal(sorted[0]!.id, "paused");
		assert.equal(sorted[1]!.id, "running");
	});

	it("no set (undefined) → legacy: all active+autoContinue rank 0", () => {
		const older = mkGoal({ id: "older", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const paused = mkGoal({ id: "paused", status: "paused", updatedAt: "2026-06-01T00:00:00Z" });
		// No set → legacy behavior: running goals always rank 0
		const sorted = sortGoalsForPicker([paused, older], undefined);
		assert.equal(sorted[0]!.id, "older"); // active+autoContinue → rank 0
		assert.equal(sorted[1]!.id, "paused");
	});

	it("stale goal sorts after running goal regardless of updatedAt", () => {
		// Goal "stale" has active+autoContinue but is NOT in the live set.
		// Goal "running" IS in the live set.
		// "stale" was updated more recently, but must sort after "running".
		const stale = mkGoal({ id: "stale", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" });
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const liveSet = new Set(["running"]); // only "running" is live
		const sorted = sortGoalsForPicker([stale, running], liveSet);
		assert.equal(sorted[0]!.id, "running");
		assert.equal(sorted[1]!.id, "stale");
	});

	it("multiple goals in set → all rank 0, sorted by updatedAt among themselves", () => {
		const a = mkGoal({ id: "a", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const b = mkGoal({ id: "b", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" });
		const paused = mkGoal({ id: "paused", status: "paused", updatedAt: "2026-03-01T00:00:00Z" });
		const liveSet = new Set(["a", "b"]);
		const sorted = sortGoalsForPicker([paused, a, b], liveSet);
		// Both a and b rank 0; b (newer) sorts before a. paused is rank 1 → last.
		assert.equal(sorted[0]!.id, "b");
		assert.equal(sorted[1]!.id, "a");
		assert.equal(sorted[2]!.id, "paused");
	});
});

// ── goalSelectorLabel with liveLockHolder ───────────────────────────────────

describe("goalSelectorLabel — liveness via liveLockHolder (task 5)", () => {
	it("active+autoContinue+liveLockHolder: true → label contains 'running'", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a", { liveLockHolder: true });
		assert.match(label, /· running ·/);
	});

	it("active+autoContinue+liveLockHolder: false → label contains 'stale'", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a", { liveLockHolder: false });
		assert.match(label, /· stale ·/);
	});

	it("active+autoContinue+liveLockHolder: undefined → label contains 'running' (legacy)", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a", { liveLockHolder: undefined });
		assert.match(label, /· running ·/);
	});

	it("active+autoContinue+liveLockHolder omitted → label contains 'running' (backward compat)", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a");
		assert.match(label, /· running ·/);
	});

	it("paused+liveLockHolder: false → label contains 'paused' (not stale)", () => {
		const g = mkGoal({ id: "a", status: "paused" });
		const label = goalSelectorLabel(g, "a", { liveLockHolder: false });
		assert.match(label, /· paused ·/);
		assert.ok(!label.includes("stale"), `paused should not show 'stale': ${label}`);
	});
});

// ── buildGoalListText with liveLockHolderSet ────────────────────────────────

describe("buildGoalListText — liveness via liveLockHolderSet (task 5)", () => {
	it("set containing goal id → goal shows 'running'", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: new Set(["a"]) });
		assert.match(text, /· running ·/);
	});

	it("set NOT containing goal id → goal shows 'stale'", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: new Set<string>([]) });
		assert.match(text, /· stale ·/);
	});

	it("null set → goal shows 'running' (legacy fallback)", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: null });
		assert.match(text, /· running ·/);
	});

	it("omitted set → goal shows 'running' (backward compat)", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null);
		assert.match(text, /· running ·/);
	});

	it("mixed: one running + one stale in same list", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "live", status: "active", autoContinue: true }),
			mkGoal({ id: "dead", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: new Set(["live"]) });
		assert.match(text, /· running ·/);
		assert.match(text, /· stale ·/);
	});

	it("stale goal sorts after running goal in output order", () => {
		// "dead" is more recent but is stale; "live" is older but running.
		const pool = goalPoolFromGoals([
			mkGoal({ id: "dead", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" }),
			mkGoal({ id: "live", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: new Set(["live"]) });
		const liveIdx = text.indexOf("live");
		const deadIdx = text.indexOf("dead");
		assert.ok(liveIdx >= 0 && deadIdx >= 0);
		assert.ok(liveIdx < deadIdx, `running (live) must appear before stale (dead):\n${text}`);
	});

	it("works with heldByOther + liveLockHolderSet simultaneously", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", autoContinue: true }),
		]);
		const text = buildGoalListText(pool, null, {
			heldByOther: new Map([["a", "ses_abcdef12345"]]),
			liveLockHolderSet: new Set(["a"]),
		});
		assert.match(text, /· running ·/);
		assert.match(text, /🔒 f12345/);
	});
});
