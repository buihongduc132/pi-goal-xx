import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	goalPoolFromGoals,
	openGoalsFromPool,
	focusedGoalFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
	goalSelectorLabel,
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	mergeFocusedGoalWithDisk,
} from "../extensions/goal-pool.ts";
import { createGoal, cloneGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { mkGoal } from "./_test-helpers.ts";

describe("goalPoolFromGoals", () => {
	it("includes non-complete goals", () => {
		const g1 = mkGoal({ id: "a", status: "active" });
		const g2 = mkGoal({ id: "b", status: "paused" });
		const pool = goalPoolFromGoals([g1, g2]);
		assert.equal(pool.size, 2);
		assert.ok(pool.has("a"));
		assert.ok(pool.has("b"));
	});

	it("excludes complete goals", () => {
		const g1 = mkGoal({ id: "a", status: "active" });
		const g2 = mkGoal({ id: "b", status: "complete" });
		const pool = goalPoolFromGoals([g1, g2]);
		assert.equal(pool.size, 1);
		assert.ok(!pool.has("b"));
	});

	it("clones goals (pool entries are independent of inputs)", () => {
		const g = mkGoal({ id: "a", usage: { tokensUsed: 10, activeSeconds: 5 } });
		const pool = goalPoolFromGoals([g]);
		const entry = pool.get("a")!;
		entry.usage.tokensUsed = 999;
		// original untouched
		assert.equal(g.usage.tokensUsed, 10);
	});

	it("handles empty iterable", () => {
		assert.equal(goalPoolFromGoals([]).size, 0);
	});
});

describe("openGoalsFromPool", () => {
	it("returns non-complete goals sorted by createdAt then id", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "z", createdAt: "2026-01-03T00:00:00Z" }),
			mkGoal({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
			mkGoal({ id: "m", createdAt: "2026-01-02T00:00:00Z" }),
			mkGoal({ id: "done", status: "complete", createdAt: "2026-01-04T00:00:00Z" }),
		]);
		const open = openGoalsFromPool(pool);
		assert.deepEqual(open.map((g) => g.id), ["a", "m", "z"]);
	});

	it("secondary sort by id when createdAt equal", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "c", createdAt: "2026-01-01T00:00:00Z" }),
			mkGoal({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
			mkGoal({ id: "b", createdAt: "2026-01-01T00:00:00Z" }),
		]);
		assert.deepEqual(openGoalsFromPool(pool).map((g) => g.id), ["a", "b", "c"]);
	});

	it("returns empty for empty pool", () => {
		assert.deepEqual(openGoalsFromPool(new Map()), []);
	});
});

describe("focusedGoalFromPool", () => {
	it("returns null when focusedGoalId is null", () => {
		assert.equal(focusedGoalFromPool(new Map(), null), null);
	});

	it("returns null when focusedGoalId is empty", () => {
		assert.equal(focusedGoalFromPool(new Map(), ""), null);
	});

	it("returns the goal when present", () => {
		const g = mkGoal({ id: "x", status: "active" });
		const pool = goalPoolFromGoals([g]);
		assert.equal(focusedGoalFromPool(pool, "x")?.id, "x");
	});

	it("returns null when id not in pool", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "x" })]);
		assert.equal(focusedGoalFromPool(pool, "missing"), null);
	});
});

describe("otherOpenGoalCount", () => {
	it("counts open goals excluding the focused one", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active" }),
			mkGoal({ id: "b", status: "paused" }),
			mkGoal({ id: "c", status: "complete" }),
		]);
		assert.equal(otherOpenGoalCount(pool, "a"), 1);
		assert.equal(otherOpenGoalCount(pool, null), 2);
	});

	it("returns 0 when only focused goal is open", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a" })]);
		assert.equal(otherOpenGoalCount(pool, "a"), 0);
	});
});

describe("resolveSessionFocus", () => {
	it("returns focusedGoalId when focus entry points at a non-complete goal", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "active" })]);
		assert.equal(
			resolveSessionFocus({ pool, autoFocusReason: null, focusEntry: { version: 1, focusedGoalId: "a", reason: "selected" } }),
			"a",
		);
	});

	it("returns null when focused goal is complete (but focusEntry present)", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "complete" })]);
		assert.equal(
			resolveSessionFocus({ pool, autoFocusReason: null, focusEntry: { version: 1, focusedGoalId: "a", reason: "completed" } }),
			null,
		);
	});

	it("falls back to legacyGoal when no focus entry and legacy goal open and already in pool", () => {
		const legacy = mkGoal({ id: "legacy", status: "active" });
		const pool = goalPoolFromGoals([legacy]);
		assert.equal(resolveSessionFocus({ pool, autoFocusReason: null, legacyGoal: legacy }), "legacy");
	});

	it("adds legacy goal to pool when open but not present, returns its id", () => {
		const pool = new Map<string, GoalRecord>();
		const legacy = mkGoal({ id: "legacy", status: "active" });
		const result = resolveSessionFocus({ pool, autoFocusReason: null, legacyGoal: legacy });
		assert.equal(result, "legacy");
		assert.ok(pool.has("legacy"));
	});

	it("returns null when no focus entry, legacy complete", () => {
		const pool = new Map<string, GoalRecord>();
		const legacy = mkGoal({ id: "legacy", status: "complete" });
		assert.equal(resolveSessionFocus({ pool, autoFocusReason: null, legacyGoal: legacy }), null);
		assert.ok(!pool.has("legacy"));
	});

	it("auto-selects single open goal when no focus/legacy", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "solo", status: "active" })]);
		assert.equal(resolveSessionFocus({ pool, autoFocusReason: "resume" }), "solo");
	});

	it("returns null when multiple open goals and no focus/legacy (ambiguous)", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active" }),
			mkGoal({ id: "b", status: "active" }),
		]);
		assert.equal(resolveSessionFocus({ pool, autoFocusReason: "resume" }), null);
	});

	it("returns null when zero open goals and no focus/legacy", () => {
		assert.equal(resolveSessionFocus({ pool: new Map(), autoFocusReason: "resume" }), null);
	});

	it("focusEntry present but null focusedGoalId returns null (no legacy fallback)", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "active" })]);
		assert.equal(
			resolveSessionFocus({ pool, autoFocusReason: null, focusEntry: { version: 1, focusedGoalId: null, reason: "cleared" } }),
			null,
		);
	});
});

describe("goalSelectorLabel", () => {
	it("marks focused goal with *", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true, sisyphus: false });
		const label = goalSelectorLabel(g, "a");
		assert.match(label, /^\* a \|/);
	});

	it("marks non-focused goal with space", () => {
		const g = mkGoal({ id: "a" });
		assert.match(goalSelectorLabel(g, "b"), /^  a \|/);
	});

	it("uses sisyphus mode label", () => {
		const g = mkGoal({ id: "a", sisyphus: true, status: "active", autoContinue: true });
		assert.match(goalSelectorLabel(g, "a"), /\| sisyphus \|/);
	});

	it("uses goal mode label when not sisyphus", () => {
		const g = mkGoal({ id: "a", sisyphus: false });
		assert.match(goalSelectorLabel(g, "a"), /\| goal \|/);
	});

	it("includes activePath when present", () => {
		const g = mkGoal({ id: "a", activePath: "/some/path" });
		assert.match(goalSelectorLabel(g, "a"), / \/some\/path$/);
	});
});

describe("buildGoalListText", () => {
	it("returns guidance when no open goals", () => {
		assert.match(buildGoalListText(new Map(), null), /No open goals/);
	});

	it("includes count header", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active" }),
			mkGoal({ id: "b", status: "paused" }),
		]);
		const text = buildGoalListText(pool, "a");
		assert.match(text, /Open goals: 2/);
	});

	it("marks focused with * and others with space", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active" }),
			mkGoal({ id: "b", status: "active" }),
		]);
		const text = buildGoalListText(pool, "a");
		assert.ok(text.includes("* a"));
		assert.ok(text.includes(" b"));
	});

	it("includes usage line when tokens or seconds > 0", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a", status: "active", usage: { tokensUsed: 1500, activeSeconds: 60 } }),
		]);
		const text = buildGoalListText(pool, "a");
		assert.match(text, /1\.5K/);
		assert.match(text, /1m00s/);
	});

	it("includes activePath line when present", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "active", activePath: "/p" })]);
		const text = buildGoalListText(pool, "a");
		assert.ok(text.includes("/p"));
	});
});

describe("buildUnfocusedOpenGoalsSummary", () => {
	it("singular for 1 goal", () => {
		assert.match(buildUnfocusedOpenGoalsSummary(1), /1 open goal exist/);
	});

	it("plural for 0 and >1 goals", () => {
		assert.match(buildUnfocusedOpenGoalsSummary(0), /0 open goals exist/);
		assert.match(buildUnfocusedOpenGoalsSummary(3), /3 open goals exist/);
	});

	it("mentions /goal-focus", () => {
		assert.match(buildUnfocusedOpenGoalsSummary(2), /\/goal-focus/);
	});
});

describe("mergeFocusedGoalWithDisk", () => {
	it("takes max of usage values", () => {
		const memory = mkGoal({ id: "a", usage: { tokensUsed: 100, activeSeconds: 50 } });
		const disk = mkGoal({ id: "a", usage: { tokensUsed: 80, activeSeconds: 200 } });
		const merged = mergeFocusedGoalWithDisk({ memoryGoal: memory, diskGoal: disk });
		assert.equal(merged.usage.tokensUsed, 100);
		assert.equal(merged.usage.activeSeconds, 200);
	});

	it("spreads disk goal fields (objective/status from disk)", () => {
		const memory = mkGoal({ id: "a", objective: "old", status: "active" });
		const disk = mkGoal({ id: "a", objective: "new", status: "paused" });
		const merged = mergeFocusedGoalWithDisk({ memoryGoal: memory, diskGoal: disk });
		assert.equal(merged.objective, "new");
		assert.equal(merged.status, "paused");
	});

	it("memory higher than disk for both → uses memory values", () => {
		const memory = mkGoal({ id: "a", usage: { tokensUsed: 999, activeSeconds: 999 } });
		const disk = mkGoal({ id: "a", usage: { tokensUsed: 1, activeSeconds: 1 } });
		const merged = mergeFocusedGoalWithDisk({ memoryGoal: memory, diskGoal: disk });
		assert.equal(merged.usage.tokensUsed, 999);
		assert.equal(merged.usage.activeSeconds, 999);
	});
});
