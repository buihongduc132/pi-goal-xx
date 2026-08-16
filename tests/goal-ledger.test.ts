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

// ── isValidLedgerEvent + sanitizeEvent coverage (all event types) ──────────

describe("readGoalLedger validates all event types", () => {
	let ctx: ReturnType<typeof tmpCtx>;
	beforeEach(() => { ctx = tmpCtx(); });
	afterEach(() => { fs.rmSync(ctx._dir, { recursive: true, force: true }); });

	it("round-trips goal_unfocused", () => {
		appendGoalEvent(ctx, { type: "goal_unfocused", reason: "done", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_unfocused");
	});

	it("round-trips goal_paused with optional fields", () => {
		appendGoalEvent(ctx, { type: "goal_paused", goalId: "g1", reason: "blocked", suggestedAction: "wait", status: "paused", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_paused");
	});

	it("round-trips goal_resumed", () => {
		appendGoalEvent(ctx, { type: "goal_resumed", goalId: "g1", reason: "unblocked", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_resumed");
	});

	it("round-trips goal_tweaked", () => {
		appendGoalEvent(ctx, { type: "goal_tweaked", goalId: "g1", changeSummary: "updated objective", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_tweaked");
	});

	it("round-trips completion_requested", () => {
		appendGoalEvent(ctx, { type: "completion_requested", goalId: "g1", summary: "done", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "completion_requested");
	});

	it("round-trips audit_started with optional fields", () => {
		appendGoalEvent(ctx, { type: "audit_started", goalId: "g1", provider: "openai", model: "gpt-4", thinkingLevel: "high", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "audit_started");
	});

	it("round-trips audit_result", () => {
		appendGoalEvent(ctx, { type: "audit_result", goalId: "g1", verdict: "approved", report: "looks good", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "audit_result");
	});

	it("round-trips audit_skipped with optional fields", () => {
		appendGoalEvent(ctx, { type: "audit_skipped", goalId: "g1", reason: "disabled", provider: "p", model: "m", thinkingLevel: "low", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "audit_skipped");
	});

	it("round-trips goal_aborted", () => {
		appendGoalEvent(ctx, { type: "goal_aborted", goalId: "g1", reason: "cancelled", archivePath: "/arch", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "goal_aborted");
	});

	it("round-trips task_list_set", () => {
		appendGoalEvent(ctx, { type: "task_list_set", goalId: "g1", taskCount: 5, blockCompletion: true, at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "task_list_set");
	});

	it("round-trips task_complete", () => {
		appendGoalEvent(ctx, { type: "task_complete", goalId: "g1", taskId: "t1", evidence: "done", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "task_complete");
	});

	it("round-trips task_skipped", () => {
		appendGoalEvent(ctx, { type: "task_skipped", goalId: "g1", taskId: "t1", reason: "n/a", at: "t" });
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 1);
		assert.equal(r.events[0].type, "task_skipped");
	});

	it("rejects unknown event types (malformed)", () => {
		const p = goalLedgerPath(ctx);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify({ type: "unknown_event", at: "t" }) + "\n");
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 1);
	});

	it("rejects events with missing at field", () => {
		const p = goalLedgerPath(ctx);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify({ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true }) + "\n");
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 1);
	});

	it("rejects non-object JSON values", () => {
		const p = goalLedgerPath(ctx);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "null\n42\n\"string\"\n[]\n");
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 4);
	});

	it("rejects events with missing type field", () => {
		const p = goalLedgerPath(ctx);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify({ at: "t", goalId: "g1" }) + "\n");
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 1);
	});
});

// ── reconstructGoalLedger — full event-type coverage ───────────────────────

describe("reconstructGoalLedger — comprehensive", () => {
	it("handles goal_tweaked (sets tweakedAt)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_tweaked", goalId: "g1", changeSummary: "updated", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		const state = recon.goals.get("g1");
		assert.ok(state);
		assert.equal(state!.tweakedAt, "t2");
	});

	it("handles completion_requested (no state change)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "completion_requested", goalId: "g1", summary: "done", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		const state = recon.goals.get("g1");
		assert.ok(state);
		assert.equal(state!.latestStatus, "active");
	});

	it("handles audit_started (no state change)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "audit_started", goalId: "g1", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.goals.get("g1")!.latestStatus, "active");
	});

	it("handles audit_skipped (no state change)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "audit_skipped", goalId: "g1", reason: "disabled", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.goals.get("g1")!.latestStatus, "active");
	});

	it("handles audit_result (sets latestAuditorResult)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "audit_result", goalId: "g1", verdict: "approved", report: "good", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		const state = recon.goals.get("g1");
		assert.ok(state!.latestAuditorResult);
		assert.equal(state!.latestAuditorResult!.verdict, "approved");
	});

	it("handles audit_result for terminal goal", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "g1", at: "t1" },
			{ type: "audit_result", goalId: "g1", verdict: "disapproved", report: "bad", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		const term = recon.terminalGoals.get("g1");
		assert.ok(term);
		assert.equal(term!.latestAuditorResult!.verdict, "disapproved");
	});

	it("handles goal_completed without prior goal_created (creates terminal state)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "g1", at: "t1" },
		];
		const recon = reconstructGoalLedger(events);
		assert.ok(recon.terminalGoals.has("g1"));
		assert.equal(recon.terminalGoals.get("g1")!.latestStatus, "complete");
	});

	it("handles goal_aborted without prior goal_created (creates terminal state)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_aborted", goalId: "g1", reason: "cancelled", at: "t1" },
		];
		const recon = reconstructGoalLedger(events);
		assert.ok(recon.terminalGoals.has("g1"));
		assert.equal(recon.terminalGoals.get("g1")!.latestStatus, "aborted");
	});

	it("handles goal_aborted with prior goal_created", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_aborted", goalId: "g1", reason: "cancelled", at: "t2" },
		];
		const recon = reconstructGoalLedger(events);
		assert.ok(recon.terminalGoals.has("g1"));
		assert.equal(recon.goals.has("g1"), false);
	});

	it("goal_focused clears terminalGoals focus flags", () => {
		// Focus g1 FIRST so it becomes a terminal goal with latestFocus=true —
		// otherwise goal_completed creates it with latestFocus=false already and
		// the final assertion cannot detect whether the clearing loop ran.
		const focusG1: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "g1", at: "t1" },
			{ type: "goal_focused", goalId: "g1", reason: "selected", at: "t1.5" },
		];
		assert.equal(reconstructGoalLedger(focusG1).terminalGoals.get("g1")!.latestFocus, true);

		const events: GoalLedgerEvent[] = [
			...focusG1,
			{ type: "goal_created", goalId: "g2", objective: "y", sisyphus: false, autoContinue: true, at: "t2" },
			{ type: "goal_focused", goalId: "g2", reason: "selected", at: "t3" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.focusedGoalId, "g2");
		// terminal goal g1 was focused at t1.5; the t3 focus for g2 must clear it
		assert.equal(recon.terminalGoals.get("g1")!.latestFocus, false);
	});

	it("goal_unfocused clears focus on goals and terminalGoals", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "g1", at: "t1" },
			{ type: "goal_created", goalId: "g2", objective: "y", sisyphus: false, autoContinue: true, at: "t2" },
			{ type: "goal_focused", goalId: "g2", reason: "sel", at: "t3" },
			{ type: "goal_unfocused", reason: "cleared", at: "t4" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.focusedGoalId, null);
		assert.equal(recon.goals.get("g2")!.latestFocus, false);
		assert.equal(recon.terminalGoals.get("g1")!.latestFocus, false);
	});

	it("clears focusedGoalId when focused goal moved to terminal", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" },
			{ type: "goal_focused", goalId: "g1", reason: "sel", at: "t2" },
			{ type: "goal_completed", goalId: "g1", at: "t3" },
		];
		const recon = reconstructGoalLedger(events);
		assert.equal(recon.focusedGoalId, null);
	});
});

// ── latestGoalLifecycleEvent — no match returns undefined ──────────────────

describe("latestGoalLifecycleEvent — no match", () => {
	it("returns undefined when no events match goalId", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t" },
		];
		assert.equal(latestGoalLifecycleEvent(events, "nonexistent"), undefined);
	});
});

// ── latestEventsForGoal — events without goalId are skipped ────────────────

describe("latestEventsForGoal — mixed events", () => {
	it("skips events without goalId (goal_unfocused)", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_unfocused", reason: "x", at: "t1" },
			{ type: "goal_created", goalId: "g1", objective: "y", sisyphus: false, autoContinue: true, at: "t2" },
		];
		const result = latestEventsForGoal(events, "g1");
		assert.equal(result.length, 1);
	});
});

// ── appendGoalEvent — fallback path (temp write fails) ─────────────────────

describe("appendGoalEvent — fallback on temp write failure", () => {
	it("falls back to direct append when temp write fails (read-only dir)", () => {
		const ctx = tmpCtx();
		try {
			// Create the ledger file first so direct append has a target
			appendGoalEvent(ctx, { type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "t1" });
			// Make the dir read-only so temp file creation fails
			const dir = path.dirname(goalLedgerPath(ctx));
			if (process.getuid && process.getuid() === 0) return; // skip if root
			fs.chmodSync(dir, 0o555);
			try {
				// This should not throw — fallback to direct append (which also fails silently)
				appendGoalEvent(ctx, { type: "goal_focused", goalId: "g1", reason: "r", at: "t2" });
			} finally {
				fs.chmodSync(dir, 0o755);
			}
			// The first event should still be readable
			const r = readGoalLedger(ctx);
			assert.ok(r.events.length >= 1);
		} finally {
			fs.rmSync(ctx._dir, { recursive: true, force: true });
		}
	});
});
