import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	nowIso,
	safeIdPart,
	newGoalId,
	normalizeRelPath,
	asRecord,
	emptyUsage,
	createGoal,
	normalizeUsage,
	normalizeTaskItem,
	normalizeTaskList,
	normalizeGoalRecord,
	cloneGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	type GoalCreationConfig,
} from "../extensions/goal-record.ts";

describe("nowIso", () => {
	it("returns ISO string for fixed timestamp", () => {
		const fixed = 1719792000000; // 2024-07-01T00:00:00Z
		const s = nowIso(fixed);
		assert.equal(s, new Date(fixed).toISOString());
	});

	it("ends with Z", () => {
		assert.match(nowIso(1719792000000), /Z$/);
	});
});

describe("safeIdPart", () => {
	it("replaces non-alphanumeric (except _ and -) with underscore", () => {
		assert.equal(safeIdPart("Hello World"), "Hello_World");
		assert.equal(safeIdPart("Foo.Bar Baz"), "Foo_Bar_Baz"); // . becomes _
	});

	it("preserves underscores and dashes", () => {
		assert.equal(safeIdPart("a-b_c"), "a-b_c");
	});

	it("truncates to 80 chars", () => {
		const long = "a".repeat(100);
		const out = safeIdPart(long);
		assert.equal(out.length, 80);
	});

	it("returns 'goal' for empty result", () => {
		assert.equal(safeIdPart(""), "goal");
		// All-invalid chars become underscores, so not empty — but pure emptiness yields 'goal'
	});
});

describe("newGoalId", () => {
	it("returns unique non-empty string", () => {
		const a = newGoalId();
		const b = newGoalId();
		assert.ok(a.length > 0);
		assert.notEqual(a, b);
	});
});

describe("normalizeRelPath", () => {
	it("splits on / and \\ and rejoins with /", () => {
		assert.equal(normalizeRelPath("foo\\bar"), "foo/bar");
		assert.equal(normalizeRelPath("foo/bar\\baz"), "foo/bar/baz");
	});

	it("collapses mixed separators", () => {
		assert.equal(normalizeRelPath("foo//bar"), "foo/bar");
	});

	it("passes through clean path", () => {
		assert.equal(normalizeRelPath("foo/bar"), "foo/bar");
	});
});

describe("asRecord", () => {
	it("returns null for non-objects", () => {
		assert.equal(asRecord(null), null);
		assert.equal(asRecord(undefined), null);
		assert.equal(asRecord("x"), null);
		assert.equal(asRecord(42), null);
		assert.equal(asRecord([]), null);
	});

	it("returns the record for objects", () => {
		const r = asRecord({ a: 1 });
		assert.deepEqual(r, { a: 1 });
	});
});

describe("emptyUsage / normalizeUsage", () => {
	it("emptyUsage has zero fields", () => {
		const u = emptyUsage();
		assert.equal(u.tokensUsed, 0);
		assert.equal(u.activeSeconds, 0);
	});

	it("normalizeUsage returns zero for invalid", () => {
		const u = normalizeUsage(null);
		assert.equal(u.tokensUsed, 0);
		assert.equal(u.activeSeconds, 0);
	});

	it("normalizeUsage coerces finite numbers", () => {
		const u = normalizeUsage({ tokensUsed: 100, activeSeconds: 200 });
		assert.equal(u.tokensUsed, 100);
		assert.equal(u.activeSeconds, 200);
	});

	it("normalizeUsage clamps negatives to 0", () => {
		const u = normalizeUsage({ tokensUsed: -5 });
		assert.equal(u.tokensUsed, 0);
	});

	it("normalizeUsage floors non-integers", () => {
		const u = normalizeUsage({ tokensUsed: 10.9 });
		assert.equal(u.tokensUsed, 10);
	});

	it("normalizeUsage rejects NaN/Infinity", () => {
		const u = normalizeUsage({ tokensUsed: NaN, activeSeconds: Infinity });
		assert.equal(u.tokensUsed, 0);
		assert.equal(u.activeSeconds, 0);
	});
});

describe("createGoal", () => {
	it("creates active goal with id + timestamps", () => {
		const cfg: GoalCreationConfig = { objective: "test obj", autoContinue: true, sisyphus: false };
		const g = createGoal(cfg, 1719792000000);
		assert.ok(g.id);
		assert.equal(g.status, "active");
		assert.equal(g.objective, "test obj");
		assert.equal(g.autoContinue, true);
		assert.equal(g.sisyphus, false);
		assert.equal(g.createdAt, nowIso(1719792000000));
	});

	it("sisyphus flag persists", () => {
		const g = createGoal({ objective: "x", autoContinue: false, sisyphus: true }, 1);
		assert.equal(g.sisyphus, true);
	});
});

describe("cloneGoal", () => {
	it("deep clones usage", () => {
		const g = createGoal({ objective: "x", autoContinue: false, sisyphus: false }, 1);
		g.usage = { tokensUsed: 5, activeSeconds: 6 };
		const c = cloneGoal(g);
		c.usage!.tokensUsed = 999;
		assert.equal(g.usage!.tokensUsed, 5); // unchanged
	});
});

describe("normalizeTaskItem / normalizeTaskList", () => {
	it("normalizeTaskItem returns undefined for invalid", () => {
		assert.equal(normalizeTaskItem({}), undefined);
		assert.equal(normalizeTaskItem({ title: "no id" }), undefined);
	});

	it("normalizeTaskItem requires id + title", () => {
		const t = normalizeTaskItem({ id: "t1", title: "Task 1" });
		assert.ok(t);
		assert.equal(t!.id, "t1");
		assert.equal(t!.title, "Task 1");
		assert.equal(t!.status, "pending");
	});

	it("normalizeTaskItem accepts valid status", () => {
		assert.equal(normalizeTaskItem({ id: "t", title: "x", status: "complete" })!.status, "complete");
		assert.equal(normalizeTaskItem({ id: "t", title: "x", status: "skipped" })!.status, "skipped");
	});

	it("normalizeTaskItem rejects invalid status → default pending", () => {
		assert.equal(normalizeTaskItem({ id: "t", title: "x", status: "bogus" })!.status, "pending");
	});

	it("normalizeTaskList returns undefined for non-array", () => {
		assert.equal(normalizeTaskList(null), undefined);
		assert.equal(normalizeTaskList({}), undefined);
		assert.equal(normalizeTaskList("x"), undefined);
	});

	it("normalizeTaskList builds list from valid array", () => {
		const tl = normalizeTaskList({ tasks: [{ id: "t1", title: "A" }] });
		assert.ok(tl);
		assert.equal(tl!.tasks.length, 1);
		assert.equal(tl!.blockCompletion, false);
	});

	it("normalizeTaskList filters invalid items", () => {
		const tl = normalizeTaskList({ tasks: [{ id: "t1", title: "A" }, { title: "no id" }, {}] });
		assert.equal(tl!.tasks.length, 1);
	});
});

describe("normalizeGoalRecord", () => {
	it("returns null for invalid", () => {
		assert.equal(normalizeGoalRecord(null), null);
		assert.equal(normalizeGoalRecord({}), null);
		assert.equal(normalizeGoalRecord({ status: "active" }), null); // missing fields
	});

	it("round-trips a created goal", () => {
		const g = createGoal({ objective: "x", autoContinue: true, sisyphus: false }, 1);
		const n = normalizeGoalRecord(JSON.parse(JSON.stringify(g)));
		assert.ok(n);
		assert.equal(n!.id, g.id);
		assert.equal(n!.objective, "x");
	});
});

describe("goalFocusDetails / normalizeGoalFocusEntry", () => {
	it("goalFocusDetails builds entry with safeIdPart'd id", () => {
		const e = goalFocusDetails("g1", "created");
		assert.equal(e.focusedGoalId, "g1");
		assert.equal(e.reason, "created");
		assert.equal(e.version, 1);
	});

	it("goalFocusDetails null id → null", () => {
		const e = goalFocusDetails(null, "cleared");
		assert.equal(e.focusedGoalId, null);
	});

	it("normalizeGoalFocusEntry returns null for invalid", () => {
		assert.equal(normalizeGoalFocusEntry(null), null);
		assert.equal(normalizeGoalFocusEntry({}), null); // missing version
		assert.equal(normalizeGoalFocusEntry({ version: 2 }), null);
	});

	it("normalizeGoalFocusEntry accepts valid version 1", () => {
		const e = normalizeGoalFocusEntry({ version: 1, focusedGoalId: "g1", reason: "selected", at: "2026-01-01T00:00:00Z" });
		assert.ok(e);
		assert.equal(e!.focusedGoalId, "g1");
		assert.equal(e!.reason, "selected");
	});

	it("normalizeGoalFocusEntry defaults invalid reason to selected", () => {
		const e = normalizeGoalFocusEntry({ version: 1, focusedGoalId: "g", reason: "bogus" });
		assert.equal(e!.reason, "selected");
	});
});
