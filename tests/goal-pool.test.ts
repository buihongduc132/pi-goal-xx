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
	resolveShortIdsForPool,
	sortGoalsForPicker,
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
	it("marks focused goal with leading '*'", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true, sisyphus: false });
		const label = goalSelectorLabel(g, "a");
		assert.match(label, /^\* /);
		assert.ok(label.includes(" a "), `expected short id 'a' in label: ${label}`);
	});

	it("marks non-focused goal with leading double space", () => {
		const g = mkGoal({ id: "a" });
		assert.match(goalSelectorLabel(g, "b"), /^  /);
	});

	it("uses compact 'running' status (no sisyphus word duplication) for active+autoContinue", () => {
		const g = mkGoal({ id: "a", sisyphus: true, status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a");
		assert.match(label, /· running ·/);
		assert.ok(label.includes("✊"), "sisyphus glyph must appear");
		assert.ok(!label.includes("sisyphus running"), "must not duplicate sisyphus in status");
	});

	it("omits sisyphus glyph when not sisyphus", () => {
		const g = mkGoal({ id: "a", sisyphus: false, status: "active", autoContinue: true });
		assert.ok(!goalSelectorLabel(g, "a").includes("✊"));
	});

	it("does NOT include activePath in the row (moved to list sub-line)", () => {
		const g = mkGoal({ id: "a", activePath: "/some/path" });
		assert.doesNotMatch(goalSelectorLabel(g, "a"), /\/some\/path/);
	});

	it("uses paused·agent status for agent-paused goal", () => {
		const g = mkGoal({ id: "a", status: "paused", stopReason: "agent" });
		assert.match(goalSelectorLabel(g, "a"), /· paused·agent ·/);
	});

	it("appends lock pill when heldByOtherSession is set", () => {
		const g = mkGoal({ id: "a", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, "a", { heldByOtherSession: "ses_abcdef12345" });
		assert.match(label, /🔒 f12345$/);
	});

	it("uses provided shortId override", () => {
		const g = mkGoal({ id: "mr62bc2x-qi4x4i", status: "active", autoContinue: true });
		assert.ok(goalSelectorLabel(g, "a", { shortId: "qi4x4i" }).includes(" qi4x4i "));
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

// ── goal-focus-picker-ux: short-id resolution + ordering + selection safety ──
// Pins the requirements in
// openspec/changes/goal-focus-picker-ux/specs/goal-focus-picker/spec.md.

describe("resolveShortIdsForPool", () => {
	it("single goal → short id", () => {
		const goals = [mkGoal({ id: "mr62bc2x-qi4x4i" })];
		const map = resolveShortIdsForPool(goals);
		assert.equal(map.get("mr62bc2x-qi4x4i"), "qi4x4i");
	});

	it("two goals sharing the suffix → BOTH fall back to full id", () => {
		const goals = [
			mkGoal({ id: "mr62bc2x-qi4x4i" }),
			mkGoal({ id: "aa11bb22-qi4x4i" }),
		];
		const map = resolveShortIdsForPool(goals);
		assert.equal(map.get("mr62bc2x-qi4x4i"), "mr62bc2x-qi4x4i");
		assert.equal(map.get("aa11bb22-qi4x4i"), "aa11bb22-qi4x4i");
	});

	it("two goals with distinct suffixes → each gets its short id", () => {
		const goals = [
			mkGoal({ id: "mr62bc2x-qi4x4i" }),
			mkGoal({ id: "zz99yy11-qi4x4j" }),
		];
		const map = resolveShortIdsForPool(goals);
		assert.equal(map.get("mr62bc2x-qi4x4i"), "qi4x4i");
		assert.equal(map.get("zz99yy11-qi4x4j"), "qi4x4j");
	});

	it("empty pool → empty map", () => {
		assert.equal(resolveShortIdsForPool([]).size, 0);
	});

	it("three-way suffix collision → all three fall back to full id", () => {
		const goals = [
			mkGoal({ id: "p1-abc" }),
			mkGoal({ id: "p2-abc" }),
			mkGoal({ id: "p3-abc" }),
		];
		const map = resolveShortIdsForPool(goals);
		assert.equal(map.get("p1-abc"), "p1-abc");
		assert.equal(map.get("p2-abc"), "p2-abc");
		assert.equal(map.get("p3-abc"), "p3-abc");
	});
});

describe("goalSelectorLabel — short-id + lock pill + activePath contract", () => {
	it("renders the short id (not the full id) when no collision", () => {
		const g = mkGoal({ id: "mr62bc2x-qi4x4i", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, null);
		assert.ok(label.includes("qi4x4i"), `expected short id in label: ${label}`);
		assert.ok(!label.includes("mr62bc2x"), `must not contain full id: ${label}`);
	});

	it("renders the full id when caller passes it via shortId opt (collision fallback)", () => {
		const g = mkGoal({ id: "mr62bc2x-qi4x4i", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, null, { shortId: "mr62bc2x-qi4x4i" });
		assert.ok(label.includes("mr62bc2x-qi4x4i"), `expected full id in label: ${label}`);
	});

	it("NEVER includes a '.pi/goals/' substring (activePath dropped from row)", () => {
		const g = mkGoal({
			id: "mr62bc2x-qi4x4i",
			status: "active",
			autoContinue: true,
			activePath: ".pi/goals/active_goal_2026070414501834_mr62bc2x-qi4x4i.md",
		});
		const label = goalSelectorLabel(g, null);
		assert.ok(!label.includes(".pi/goals/"), `picker row must not contain path: ${label}`);
	});

	it("appends '🔒 <short>' lock pill when heldByOtherSession is set", () => {
		const g = mkGoal({ id: "a-qi4x4i", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, null, { heldByOtherSession: "ses_abcdef12345" });
		assert.match(label, /🔒 f12345$/);
	});

	it("does not append a lock pill when heldByOtherSession is null", () => {
		const g = mkGoal({ id: "a-qi4x4i", status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, null, { heldByOtherSession: null });
		assert.ok(!label.includes("🔒"), `unexpected lock pill: ${label}`);
	});

	it("non-sisyphus running goal has NO 'sisyphus' word and NO ✊ glyph", () => {
		const g = mkGoal({ id: "a-qi4x4i", sisyphus: false, status: "active", autoContinue: true });
		const label = goalSelectorLabel(g, null);
		assert.ok(!label.includes("✊"));
		assert.ok(!label.includes("sisyphus"));
		assert.match(label, /· running ·/);
	});

	it("non-sisyphus agent-paused goal shows 'paused·agent' and no ✊ glyph", () => {
		const g = mkGoal({ id: "a-qi4x4i", sisyphus: false, status: "paused", stopReason: "agent" });
		const label = goalSelectorLabel(g, null);
		assert.match(label, /· paused·agent ·/);
		assert.ok(!label.includes("✊"));
	});
});

describe("sortGoalsForPicker", () => {
	it("running goal sorts before paused regardless of updatedAt", () => {
		const older = "2026-01-01T00:00:00Z";
		const newer = "2026-06-01T00:00:00Z";
		const paused = mkGoal({ id: "paused", status: "paused", updatedAt: newer });
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: older });
		const sorted = sortGoalsForPicker([paused, running]);
		assert.equal(sorted[0]!.id, "running");
		assert.equal(sorted[1]!.id, "paused");
	});

	it("among non-running, more recent updatedAt sorts first", () => {
		const older = mkGoal({ id: "older", status: "paused", updatedAt: "2026-01-01T00:00:00Z" });
		const newer = mkGoal({ id: "newer", status: "paused", updatedAt: "2026-06-01T00:00:00Z" });
		const sorted = sortGoalsForPicker([older, newer]);
		assert.equal(sorted[0]!.id, "newer");
		assert.equal(sorted[1]!.id, "older");
	});

	it("does NOT mutate the input array", () => {
		const a = mkGoal({ id: "a", status: "paused", updatedAt: "2026-01-01T00:00:00Z" });
		const b = mkGoal({ id: "b", status: "active", autoContinue: true, updatedAt: "2026-01-02T00:00:00Z" });
		const input = [a, b];
		sortGoalsForPicker(input);
		assert.equal(input[0]!.id, "a");
		assert.equal(input[1]!.id, "b");
	});

	it("stable: two calls produce identical ordering", () => {
		const goals = [
			mkGoal({ id: "z", status: "paused", updatedAt: "2026-01-01T00:00:00Z" }),
			mkGoal({ id: "a", status: "paused", updatedAt: "2026-01-01T00:00:00Z" }),
			mkGoal({ id: "m", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" }),
		];
		const first = sortGoalsForPicker(goals).map((g) => g.id);
		const second = sortGoalsForPicker(goals).map((g) => g.id);
		assert.deepEqual(first, second);
		// running (m) sorts first; z and a tie on updatedAt → id ascending → a before z
		assert.deepEqual(first, ["m", "a", "z"]);
	});
});

describe("buildGoalListText — picker UX requirements", () => {
	it("includes the 'Columns:' legend preamble", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a", status: "active" })]);
		const text = buildGoalListText(pool, null);
		assert.match(text, /Columns:/);
	});

	it("keeps activePath on its own indented sub-line", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "a-qi4x4i", status: "active", autoContinue: true, activePath: ".pi/goals/active_goal_x_a-qi4x4i.md" }),
		]);
		const text = buildGoalListText(pool, null);
		assert.ok(text.includes(".pi/goals/active_goal_x_a-qi4x4i.md"), `path sub-line missing: ${text}`);
	});

	it("applies sorting: running goal appears above paused", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "paused", status: "paused", updatedAt: "2026-06-01T00:00:00Z" }),
			mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" }),
		]);
		const text = buildGoalListText(pool, null);
		const runningIdx = text.indexOf("running");
		const pausedIdx = text.indexOf("paused");
		assert.ok(runningIdx >= 0 && pausedIdx >= 0);
		assert.ok(runningIdx < pausedIdx, `running must appear before paused:\n${text}`);
	});

	it("surfaces lock pill from heldByOther map", () => {
		const pool = goalPoolFromGoals([mkGoal({ id: "a-qi4x4i", status: "active", autoContinue: true })]);
		const heldByOther = new Map([["a-qi4x4i", "ses_abcdef12345"]]);
		const text = buildGoalListText(pool, null, { heldByOther });
		assert.match(text, /🔒 f12345/);
	});
});

// ── CRITICAL: short-id collision does not corrupt selection mapping ───────
// This pins the D1/D2 safety guarantee from design.md: even when two goals
// share the short suffix, the label→id map resolves each rendered label to
// the correct full goal id. focusGoalCommand builds exactly this map; we
// reproduce its logic here to assert the invariant end-to-end.
describe("collision-safe selection mapping (D1/D2 invariant)", () => {
	it("two colliding-suffix goals produce distinct labels resolving to distinct ids", () => {
		const goals = [
			mkGoal({ id: "aa-qi4x4i", status: "active", autoContinue: true, objective: "goal alpha" }),
			mkGoal({ id: "bb-qi4x4i", status: "paused", objective: "goal beta" }),
		];
		const shortIds = resolveShortIdsForPool(goals);
		// Both collide → both fall back to full id.
		assert.equal(shortIds.get("aa-qi4x4i"), "aa-qi4x4i");
		assert.equal(shortIds.get("bb-qi4x4i"), "bb-qi4x4i");

		// Reproduce focusGoalCommand's label construction.
		const labels = goals.map((g) => goalSelectorLabel(g, null, { shortId: shortIds.get(g.id) }));
		const byLabel = new Map(labels.map((label, i) => [label, goals[i]!.id]));

		// Two distinct labels (full ids differ → labels differ).
		assert.equal(byLabel.size, 2, `expected 2 distinct labels, got ${labels.length}: ${JSON.stringify(labels)}`);

		// Each label resolves to the correct goal id.
		assert.equal(byLabel.get(labels[0]!), "aa-qi4x4i");
		assert.equal(byLabel.get(labels[1]!), "bb-qi4x4i");
		// Sanity: labels are not swapped.
		assert.notEqual(byLabel.get(labels[0]!), byLabel.get(labels[1]!));
	});

	it("distinct-suffix goals resolve correctly via short ids", () => {
		const goals = [
			mkGoal({ id: "aa-qi4x4i", status: "active", autoContinue: true, objective: "alpha" }),
			mkGoal({ id: "bb-qi4x4j", status: "paused", objective: "beta" }),
		];
		const shortIds = resolveShortIdsForPool(goals);
		const labels = goals.map((g) => goalSelectorLabel(g, null, { shortId: shortIds.get(g.id) }));
		const byLabel = new Map(labels.map((label, i) => [label, goals[i]!.id]));
		assert.equal(byLabel.size, 2);
		assert.equal(byLabel.get(labels[0]!), "aa-qi4x4i");
		assert.equal(byLabel.get(labels[1]!), "bb-qi4x4j");
		// short ids appear in labels, full ids do not (no collision).
		assert.ok(labels[0]!.includes("qi4x4i"));
		assert.ok(labels[1]!.includes("qi4x4j"));
		assert.ok(!labels[0]!.includes("aa-"));
	});
});
