import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	isAuditorSubscribed,
	emitAuditorSubscription,
} from "../extensions/goal-auditor-subscriptions.ts";
import { readGoalLedger, GOAL_LEDGER_FILE } from "../extensions/goal-ledger.ts";

function tmpCtx() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-subs-"));
	return { cwd };
}

const FIXED_NOW = "2026-07-01T00:00:00Z";
const fixedIso = () => FIXED_NOW;

describe("isAuditorSubscribed", () => {
	it("false when settings undefined", () => {
		assert.equal(isAuditorSubscribed(undefined, "pause"), false);
	});

	it("false when auditorSubscriptions undefined", () => {
		assert.equal(isAuditorSubscribed({}, "pause"), false);
	});

	it("false when no matching event", () => {
		assert.equal(
			isAuditorSubscribed(
				{ auditorSubscriptions: [{ event: "pause", mode: "async" }] },
				"abort",
			),
			false,
		);
	});

	it("true when matching event + async mode", () => {
		assert.equal(
			isAuditorSubscribed(
				{ auditorSubscriptions: [{ event: "pause", mode: "async" }] },
				"pause",
			),
			true,
		);
	});

	it("false when matching event but mode != async", () => {
		// Parser drops these, but verify defensive check
		assert.equal(
			isAuditorSubscribed(
				{ auditorSubscriptions: [{ event: "pause", mode: "sync" } as unknown as { event: string; mode: "async" }] },
				"pause",
			),
			false,
		);
	});

	it("matches arbitrary event strings", () => {
		assert.equal(
			isAuditorSubscribed(
				{ auditorSubscriptions: [{ event: "custom_event_xyz", mode: "async" }] },
				"custom_event_xyz",
			),
			true,
		);
	});

	it("matches first of multiple subscriptions", () => {
		assert.equal(
			isAuditorSubscribed(
				{
					auditorSubscriptions: [
						{ event: "a", mode: "async" },
						{ event: "b", mode: "async" },
					],
				},
				"b",
			),
			true,
		);
	});
});

describe("emitAuditorSubscription — non-blocking + filtering", () => {
	it("does nothing when not subscribed", async () => {
		const ctx = tmpCtx();
		const notifyCalls: string[] = [];
		emitAuditorSubscription(
			ctx,
			undefined,
			"pause",
			{ goalId: "g1" },
			fixedIso,
			(m) => notifyCalls.push(m),
		);
		// Wait for microtasks
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(notifyCalls.length, 0);
		assert.equal(fs.existsSync(path.join(ctx.cwd, GOAL_LEDGER_FILE)), false);
	});

	it("emits ledger event + notify when subscribed (async, non-blocking)", async () => {
		const ctx = tmpCtx();
		const notifyCalls: string[] = [];
		const settings = { auditorSubscriptions: [{ event: "pause", mode: "async" as const }] };
		// Call returns synchronously before emit happens
		emitAuditorSubscription(
			ctx,
			settings,
			"pause",
			{ goalId: "g1", details: { reason: "blocked" } },
			fixedIso,
			(m) => notifyCalls.push(m),
		);
		// Immediately after sync return, ledger should NOT yet be written (microtask pending)
		// (We don't strictly assert this — timing dependent — but the call must not throw.)
		await new Promise((r) => setTimeout(r, 10));
		// Ledger should now contain the event
		const read = readGoalLedger(ctx);
		assert.equal(read.events.length, 1);
		assert.equal(read.events[0].type, "audit_subscription_emitted");
		assert.equal(read.malformed, 0);
		assert.equal(notifyCalls.length, 1);
		assert.match(notifyCalls[0], /pause/);
		assert.match(notifyCalls[0], /g1/);
	});

	it("includes taskId in payload when provided", async () => {
		const ctx = tmpCtx();
		const notifyCalls: string[] = [];
		emitAuditorSubscription(
			ctx,
			{ auditorSubscriptions: [{ event: "task_skip", mode: "async" }] },
			"task_skip",
			{ goalId: "g1", taskId: "t1", details: { reason: "r" } },
			fixedIso,
			(m) => notifyCalls.push(m),
		);
		await new Promise((r) => setTimeout(r, 10));
		const read = readGoalLedger(ctx);
		assert.equal(read.events.length, 1);
		assert.match(notifyCalls[0], /t1/);
	});

	it("silently skips unmatched event names", async () => {
		const ctx = tmpCtx();
		const notifyCalls: string[] = [];
		emitAuditorSubscription(
			ctx,
			{ auditorSubscriptions: [{ event: "pause", mode: "async" }] },
			"unmatched_event",
			{ goalId: "g1" },
			fixedIso,
			(m) => notifyCalls.push(m),
		);
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(notifyCalls.length, 0);
		assert.equal(fs.existsSync(path.join(ctx.cwd, GOAL_LEDGER_FILE)), false);
	});

	it("works without notify callback (no throw)", async () => {
		const ctx = tmpCtx();
		emitAuditorSubscription(
			ctx,
			{ auditorSubscriptions: [{ event: "abort", mode: "async" }] },
			"abort",
			{ goalId: "g1" },
			fixedIso,
			undefined,
		);
		await new Promise((r) => setTimeout(r, 10));
		const read = readGoalLedger(ctx);
		assert.equal(read.events.length, 1);
	});

	it("swallows ledger write failures (no throw to caller)", async () => {
		// Make cwd a path where write fails — use a non-existent dir nested under a file
		const fileAsDir = path.join(os.tmpdir(), "pgxx-blocker-file");
		fs.writeFileSync(fileAsDir, "x");
		const ctx = { cwd: path.join(fileAsDir, "subdir") };
		// Should not throw despite impossible mkdir/write
		emitAuditorSubscription(
			ctx,
			{ auditorSubscriptions: [{ event: "pause", mode: "async" }] },
			"pause",
			{ goalId: "g1" },
			fixedIso,
			undefined,
		);
		await new Promise((r) => setTimeout(r, 10));
		// No assertion needed — survival is the test
		assert.ok(true);
	});

	it("swallows notify callback failures", async () => {
		const ctx = tmpCtx();
		const throwingNotify = () => { throw new Error("notify boom"); };
		emitAuditorSubscription(
			ctx,
			{ auditorSubscriptions: [{ event: "pause", mode: "async" }] },
			"pause",
			{ goalId: "g1" },
			fixedIso,
			throwingNotify,
		);
		await new Promise((r) => setTimeout(r, 10));
		// Ledger write should still have succeeded
		const read = readGoalLedger(ctx);
		assert.equal(read.events.length, 1);
	});

	it("emits multiple events when multiple subscriptions match different events", async () => {
		const ctx = tmpCtx();
		const settings = {
			auditorSubscriptions: [
				{ event: "pause", mode: "async" as const },
				{ event: "abort", mode: "async" as const },
			],
		};
		emitAuditorSubscription(ctx, settings, "pause", { goalId: "g1" }, fixedIso, undefined);
		emitAuditorSubscription(ctx, settings, "abort", { goalId: "g1" }, fixedIso, undefined);
		emitAuditorSubscription(ctx, settings, "complete", { goalId: "g1" }, fixedIso, undefined);
		await new Promise((r) => setTimeout(r, 10));
		const read = readGoalLedger(ctx);
		assert.equal(read.events.length, 2); // pause + abort, not complete
	});
});
