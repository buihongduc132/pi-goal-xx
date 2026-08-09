/**
 * RED PHASE tests for goal-display-liveness OpenSpec change.
 *
 * Tests the new `liveLockHolder?: boolean | undefined` parameter on the
 * display functions in goal-core.ts:
 * - `compactStatusLabel` — picker/list row pill
 * - `statusLabel` — verbose footer label
 * - `footerStatus` — footer status bar text
 *
 * Tri-state semantics:
 * - `true`  → live lock holder exists → "running" (existing behavior)
 * - `false` → confirmed no live holder → "stale"
 * - `undefined` → cannot determine → "running" (legacy fallback, never stale)
 *
 * These tests are expected to FAIL until the GREEN phase adds the parameter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	compactStatusLabel,
	statusLabel,
	footerStatus,
} from "../extensions/goal-core.ts";
import type { GoalDisplayRecordLike } from "../extensions/goal-core.ts";

// ── compactStatusLabel ───────────────────────────────────────────────────────

describe("compactStatusLabel — liveLockHolder liveness", () => {
	it("active+autoContinue+true → 'running'", () => {
		assert.equal(
			compactStatusLabel({ status: "active", autoContinue: true }, true),
			"running",
		);
	});

	it("active+autoContinue+false → 'stale'", () => {
		assert.equal(
			compactStatusLabel({ status: "active", autoContinue: true }, false),
			"stale",
		);
	});

	it("active+autoContinue+undefined → 'running' (legacy fallback)", () => {
		assert.equal(
			compactStatusLabel({ status: "active", autoContinue: true }, undefined),
			"running",
		);
	});

	it("active+autoContinue+omitted → 'running' (backward compat)", () => {
		assert.equal(
			compactStatusLabel({ status: "active", autoContinue: true }),
			"running",
		);
	});

	it("paused+false → 'paused' (lock irrelevant for non-active)", () => {
		assert.equal(
			compactStatusLabel({ status: "paused", autoContinue: false }, false),
			"paused",
		);
	});

	it("paused·agent+false → 'paused·agent' (lock irrelevant)", () => {
		assert.equal(
			compactStatusLabel({ status: "paused", autoContinue: false, stopReason: "agent" }, false),
			"paused·agent",
		);
	});

	it("paused+true → 'paused' (lock irrelevant for non-active)", () => {
		assert.equal(
			compactStatusLabel({ status: "paused", autoContinue: false }, true),
			"paused",
		);
	});
});

// ── statusLabel ──────────────────────────────────────────────────────────────

describe("statusLabel — liveLockHolder liveness", () => {
	it("active+autoContinue+false → contains 'stale'", () => {
		const out = statusLabel({ sisyphus: false, status: "active", autoContinue: true }, false);
		assert.ok(out.includes("stale"), `expected 'stale' in '${out}'`);
	});

	it("active+autoContinue+true → contains 'running'", () => {
		const out = statusLabel({ sisyphus: false, status: "active", autoContinue: true }, true);
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("active+autoContinue+undefined → contains 'running' (legacy)", () => {
		const out = statusLabel({ sisyphus: false, status: "active", autoContinue: true }, undefined);
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("active+autoContinue+omitted → contains 'running' (backward compat)", () => {
		const out = statusLabel({ sisyphus: false, status: "active", autoContinue: true });
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("sisyphus+active+autoContinue+false → contains 'stale'", () => {
		const out = statusLabel({ sisyphus: true, status: "active", autoContinue: true }, false);
		assert.ok(out.includes("stale"), `expected 'stale' in '${out}'`);
	});

	it("paused+false → 'paused' (lock irrelevant)", () => {
		assert.equal(
			statusLabel({ sisyphus: false, status: "paused", autoContinue: false }, false),
			"paused",
		);
	});
});

// ── footerStatus ─────────────────────────────────────────────────────────────

describe("footerStatus — liveLockHolder liveness", () => {
	function goal(over: Partial<GoalDisplayRecordLike>): GoalDisplayRecordLike {
		return {
			objective: "do the thing",
			status: "active",
			autoContinue: true,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			sisyphus: false,
			...over,
		};
	}

	it("active+autoContinue+false → contains 'stale'", () => {
		const out = footerStatus(goal({}), false);
		assert.ok(out.includes("stale"), `expected 'stale' in '${out}'`);
	});

	it("active+autoContinue+true → contains 'running'", () => {
		const out = footerStatus(goal({}), true);
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("active+autoContinue+undefined → contains 'running' (legacy)", () => {
		const out = footerStatus(goal({}), undefined);
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("active+autoContinue+omitted → contains 'running' (backward compat)", () => {
		const out = footerStatus(goal({}));
		assert.ok(out.includes("running"), `expected 'running' in '${out}'`);
	});

	it("paused+false → does NOT contain 'stale' (lock irrelevant)", () => {
		const out = footerStatus(goal({ status: "paused", autoContinue: false }), false);
		assert.ok(!out.includes("stale"), `must not contain 'stale' for paused goal, got '${out}'`);
	});
});
