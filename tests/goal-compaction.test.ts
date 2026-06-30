import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildGoalCompactSummary,
	buildCompactionSummary,
} from "../extensions/goal-compaction.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-1",
		objective: "Build the thing",
		status: "active",
		autoContinue: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

const AT = "2026-01-01T00:00:00.000Z";

describe("buildGoalCompactSummary", () => {
	it("renders header and objective, omitting usage/time when zero", () => {
		const out = buildGoalCompactSummary(makeGoal({ id: "g1" }), []);
		assert.match(out, /Goal g1 — active/);
		assert.match(out, /Objective: Build the thing/);
		assert.doesNotMatch(out, /Usage:/);
		assert.doesNotMatch(out, /Time:/);
	});

	it("includes usage and time lines when nonzero", () => {
		const out = buildGoalCompactSummary(
			makeGoal({ usage: { tokensUsed: 1500, activeSeconds: 125 } }),
			[],
		);
		assert.match(out, /Usage: 1\.5K/);
		assert.match(out, /Time: 2m05s/);
	});

	it("includes pause reason and suggested action", () => {
		const out = buildGoalCompactSummary(
			makeGoal({ pauseReason: "need creds", pauseSuggestedAction: "add token" }),
			[],
		);
		assert.match(out, /Pause reason: need creds/);
		assert.match(out, /Suggested action: add token/);
	});

	it("truncates long objective to 200 chars", () => {
		const long = "x".repeat(300);
		const out = buildGoalCompactSummary(makeGoal({ objective: long }), []);
		assert.ok(out.length < long.length + 500);
		assert.match(out, /\.\.\./);
	});

	it("renders each recent event type", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_paused", goalId: "g-1", reason: "block", at: AT },
			{ type: "goal_resumed", goalId: "g-1", reason: "back", at: AT },
			{ type: "goal_tweaked", goalId: "g-1", changeSummary: "widened scope", at: AT },
			{ type: "completion_requested", goalId: "g-1", summary: "all done", at: AT },
			{ type: "audit_result", goalId: "g-1", verdict: "disapproved", report: "not enough", at: AT },
			{ type: "goal_completed", goalId: "g-1", at: AT },
			{ type: "task_list_set", goalId: "g-1", taskCount: 3, blockCompletion: true, at: AT },
			{ type: "task_complete", goalId: "g-1", taskId: "t1", evidence: "proof", at: AT },
			{ type: "task_skipped", goalId: "g-1", taskId: "t2", reason: "obsolete", at: AT },
			{ type: "goal_aborted", goalId: "g-1", reason: "cancelled", at: AT },
		];
		const out = buildGoalCompactSummary(makeGoal({ id: "g-1" }), events);
		// latestEventsForGoal limits to last 5; verify some appear
		assert.match(out, /Recent events:/);
		// the last 5 events by insertion are: goal_completed..goal_aborted
		assert.match(out, /- completed/);
		assert.match(out, /- task list set: 3 tasks \(blocking\)/);
		assert.match(out, /- task complete: t1 — proof/);
		assert.match(out, /- task skipped: t2 — obsolete/);
		assert.match(out, /- aborted: cancelled/);
	});

	it("renders completion_requested without summary cleanly", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "completion_requested", goalId: "g-1", at: AT },
		];
		const out = buildGoalCompactSummary(makeGoal({ id: "g-1" }), events);
		assert.match(out, /- completion requested$/m);
	});

	it("renders approved audit result without report suffix", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "audit_result", goalId: "g-1", verdict: "approved", report: "great", at: AT },
		];
		const out = buildGoalCompactSummary(makeGoal({ id: "g-1" }), events);
		assert.match(out, /- auditor approved/);
		assert.doesNotMatch(out, /- auditor approved: great/);
	});

	it("renders latest disapproved auditor rejection section", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "audit_result", goalId: "g-1", verdict: "disapproved", report: "missing tests", at: AT },
		];
		const out = buildGoalCompactSummary(makeGoal({ id: "g-1" }), events);
		assert.match(out, /Auditor rejection \(latest\): missing tests/);
	});

	it("ignores events for other goals", () => {
		const events: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "other", at: AT },
		];
		const out = buildGoalCompactSummary(makeGoal({ id: "g-1" }), events);
		assert.doesNotMatch(out, /Recent events/);
	});
});

describe("buildCompactionSummary", () => {
	it("renders NO GOALS block when empty", () => {
		const out = buildCompactionSummary({
			goalsById: new Map(),
			focusedGoalId: null,
			ledgerEvents: [],
		});
		assert.match(out, /\[NO GOALS\]/);
		assert.match(out, /\[INSTRUCTION\]/);
		assert.match(out, /Continue from the focused goal/);
	});

	it("renders FOCUSED GOAL section", () => {
		const goal = makeGoal({ id: "focus", objective: "focused obj" });
		const out = buildCompactionSummary({
			goalsById: new Map([["focus", goal]]),
			focusedGoalId: "focus",
			ledgerEvents: [],
		});
		assert.match(out, /\[FOCUSED GOAL\]/);
		assert.match(out, /Goal focus — active/);
	});

	it("renders OTHER OPEN GOALS excluding focused, with cap", () => {
		const map = new Map<string, GoalRecord>();
		map.set("f", makeGoal({ id: "f", objective: "focused" }));
		for (let i = 0; i < 3; i++) map.set(`o${i}`, makeGoal({ id: `o${i}`, objective: `open ${i}` }));
		const out = buildCompactionSummary({
			goalsById: map,
			focusedGoalId: "f",
			ledgerEvents: [],
			capOpenGoals: 2,
		});
		assert.match(out, /\[OTHER OPEN GOALS — 3 total\]/);
		assert.match(out, /- o0 — active — open 0/);
		assert.match(out, /... and 1 more/);
	});

	it("renders TERMINAL GOALS from reconstructed ledger", () => {
		const goal = makeGoal({ id: "f", objective: "focused" });
		const events: GoalLedgerEvent[] = [
			{ type: "goal_completed", goalId: "done1", at: "2026-01-02T00:00:00.000Z" },
			{ type: "goal_aborted", goalId: "ab1", reason: "x", at: "2026-01-03T00:00:00.000Z" },
		];
		const out = buildCompactionSummary({
			goalsById: new Map([["f", goal]]),
			focusedGoalId: "f",
			ledgerEvents: events,
		});
		assert.match(out, /\[TERMINAL GOALS — 2 completed or aborted\]/);
		assert.match(out, /- done1 — completed at/);
		assert.match(out, /- ab1 — aborted at/);
	});

	it("excludes completed goals from OTHER OPEN GOALS", () => {
		const map = new Map<string, GoalRecord>([
			["f", makeGoal({ id: "f" })],
			["done", makeGoal({ id: "done", status: "complete" })],
		]);
		const out = buildCompactionSummary({
			goalsById: map,
			focusedGoalId: "f",
			ledgerEvents: [],
		});
		// No other-open block since the only non-focused goal is complete
		assert.doesNotMatch(out, /OTHER OPEN GOALS/);
	});
});
