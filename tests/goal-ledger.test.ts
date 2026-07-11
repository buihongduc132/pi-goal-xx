import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	appendGoalEvent,
	readGoalLedger,
	reconstructGoalLedger,
	latestAuditorResultForGoal,
	latestEventsForGoal,
	latestGoalLifecycleEvent,
	goalLedgerPath,
	type GoalLedgerContext,
	type GoalLedgerEvent,
} from "../extensions/goal-ledger.ts";

function tmpCtx(): GoalLedgerContext & { _dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ledger-"));
	return { cwd: dir, _dir: dir };
}

describe("goalLedgerPath", () => {
	it("returns .pi/goals/goal_events.jsonl under cwd", () => {
		const p = goalLedgerPath({ cwd: "/x" });
		assert.equal(p, path.join("/x", ".pi", "goals", "goal_events.jsonl"));
	});
});

describe("appendGoalEvent + readGoalLedger round-trip", () => {
	let ctx: ReturnType<typeof tmpCtx>;
	beforeEach(() => { ctx = tmpCtx(); });
	afterEach(() => { fs.rmSync(ctx._dir, { recursive: true, force: true }); });

	it("appends and reads a single event", () => {
		appendGoalEvent(ctx, { type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "2026-01-01T00:00:00Z" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_created");
		assert.equal(r.malformed, 0);
	});

	it("appends multiple events preserving order", () => {
		appendGoalEvent(ctx, { type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" });
		appendGoalEvent(ctx, { type: "goal_focused", goalId: "g1", reason: "created", at: "t2" });
		appendGoalEvent(ctx, { type: "goal_completed", goalId: "g1", at: "t3" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 3);
		assert.equal(r.events[0].type, "goal_created");
		assert.equal(r.events[2].type, "goal_completed");
	});

	it("creates parent dir if missing", () => {
		const nestedCtx = { cwd: path.join(ctx._dir, "deep", "nested") };
		appendGoalEvent(nestedCtx, { type: "goal_unfocused", reason: "x", at: "t" });
		assert.ok(fs.existsSync(goalLedgerPath(nestedCtx)));
	});

	it("handles malformed lines (counts them, skips valid parsing)", () => {
		const p = goalLedgerPath(ctx);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "not json\n{}\n" + JSON.stringify({ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t" }) + "\n");
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.malformed, 2);
	});

	it("returns empty when file missing", () => {
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 0);
	});

	it("writes audit_subscription_emitted (NEW event type)", () => {
		appendGoalEvent(ctx, { type: "audit_subscription_emitted", event: "pause", goalId: "g1", details: { reason: "blocked" }, at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "audit_subscription_emitted");
	});

	it("writes audit_subscription_emitted with taskId", () => {
		appendGoalEvent(ctx, { type: "audit_subscription_emitted", event: "task_skip", goalId: "g1", taskId: "t1", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
	});
});

describe("reconstructGoalLedger", () => {
	it("reconstructs lifecycle from event sequence", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_paused", goalId: "g1", reason: "r", at: "t2" },
			{ type: "goal_resumed", goalId: "g1", reason: "r", at: "t3" },
			{ type: "goal_completed", goalId: "g1", at: "t4" },
		];
		const recon = reconstructGoalLedger(events);
		assert.ok(recon.goals.has("g1") || recon.terminalGoals.has("g1"));
	});

	it("tracks focused goal id", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_focused", goalId: "g1", reason: "created", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.focusedGoalId, "g1");
	});

	it("clears focus on unfocused", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_focused", goalId: "g1", reason: "created", at: "t1" },
			{ type: "goal_unfocused", reason: "cleared", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.focusedGoalId, null);
	});

	it("empty events → empty state", () => {
		const recon = reconstructGoalLedger([]);
		assert.equal(recon.goals.size, 0);
		assert.equal(recon.focusedGoalId, null);
	});
});

describe("latestAuditorResultForGoal", () => {
	it("returns undefined when no audit events", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t" },
		];
		assert.equal(latestAuditorResultForGoal(events, "g1"), undefined);
	});

	it("returns latest audit_result for goal", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "audit_started", goalId: "g1", at: "t1" },
			{ type: "audit_result", goalId: "g1", verdict: "disapproved", report: "first", at: "t2" },
			{ type: "audit_result", goalId: "g1", verdict: "approved", report: "second", at: "t3" },
		];
		const r = latestAuditorResultForGoal(events, "g1");
		assert.ok(r);
		assert.equal(r!.verdict, "approved");
		assert.equal(r!.report, "second");
	});

	it("scopes to specific goalId", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "audit_result", goalId: "g1", verdict: "approved", report: "a", at: "t1" },
			{ type: "audit_result", goalId: "g2", verdict: "disapproved", report: "b", at: "t2" },
		];
		assert.equal(latestAuditorResultForGoal(events, "g1")?.verdict, "approved");
		assert.equal(latestAuditorResultForGoal(events, "g2")?.verdict, "disapproved");
	});
});

describe("latestEventsForGoal", () => {
	it("filters events by goalId", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_created", goalId: "g2", objective: "y", sisyphus: false, autoContinue: true, at: "t2" },
			{ type: "goal_focused", goalId: "g1", reason: "created", at: "t3" },
		];
		const forG1 = latestEventsForGoal(events, "g1");
		assert.equal(forG1.length, 2);
	});

	it("respects limit", () => {
		const events: GoalLedgerEvent[] = [];
		for (let i = 0; i < 20; i++) {
			events.push({ type: "goal_focused", goalId: "g1", reason: "selected", at: `t${i}` });
		}
		assert.equal(latestEventsForGoal(events, "g1", 5).length, 5);
		assert.equal(latestEventsForGoal(events, "g1").length, 10); // default
	});
});

describe("latestGoalLifecycleEvent", () => {
	it("returns latest lifecycle event for goal", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_paused", goalId: "g1", reason: "r", at: "t2" },
			{ type: "goal_focused", goalId: "g1", reason: "selected", at: "t3" },
		];
		const latest = latestGoalLifecycleEvent(events, "g1");
		// Should return a lifecycle event (created/paused/resumed/completed/aborted)
		assert.ok(latest);
		assert.equal(latest!.goalId, "g1");
	});
});

// cubic-dev P1: the goal ledger must NOT be rotated — readGoalLedger only reads
// the live file, so rotating goal_created events into .1/.2/.3 archives would
// silently drop later events for those goals during reconstruction.
describe("P1: goal ledger is not rotated (event-sourced reconstruction)", () => {
	it("appendGoalEvent does not create rotation archives (.1/.2/.3)", () => {
		const ctx = tmpCtx();
		try {
			appendGoalEvent(ctx, { type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" });
			appendGoalEvent(ctx, { type: "goal_focused", goalId: "g1", reason: "selected", at: "t2" });
			const live = goalLedgerPath(ctx);
			assert.ok(fs.existsSync(live), "live ledger file must exist");
			assert.ok(!fs.existsSync(`${live}.1`), "ledger must NOT be rotated to .1 (cubic P1)");
			assert.ok(!fs.existsSync(`${live}.2`), "ledger must NOT be rotated to .2");
			// Reconstruction must still see both events.
			const { events } = readGoalLedger(ctx);
			assert.equal(events.length, 2, "all events must be readable from the live ledger");
		} finally {
			fs.rmSync(ctx._dir, { recursive: true, force: true });
		}
	});
});
