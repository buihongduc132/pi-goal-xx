/**
 * RED tests for isInteractiveTui bug.
 *
 * Bug: In production pi, TUI mode sets ctx.mode = "tui", NOT "interactive".
 * But isInteractiveTui checks for mode === "interactive", so it returns false
 * in production TUI mode. This causes the non-TUI path to run, which shows
 * warning text instead of the picker.
 *
 * User complaint: "it is in TUI and it is NOT even shows the TUI selection"
 *
 * Root cause: isInteractiveTui in goal-questionnaire.ts checks mode === "interactive"
 * but production sets mode = "tui".
 *
 * Fix: isInteractiveTui should check for mode === "tui" OR mode === "interactive".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInteractiveTui } from "../extensions/goal-questionnaire.ts";

describe("RED — isInteractiveTui must recognize production TUI mode", () => {
	it("BUG: mode='tui' should return true (production TUI mode)", () => {
		const ctx = { hasUI: true, mode: "tui" };
		assert.ok(isInteractiveTui(ctx), "mode='tui' should be recognized as interactive TUI");
	});

	it("BUG: mode='interactive' should return true (test harness mode)", () => {
		const ctx = { hasUI: true, mode: "interactive" };
		assert.ok(isInteractiveTui(ctx), "mode='interactive' should be recognized as interactive TUI");
	});

	it("mode=undefined with hasUI=true should return true (fallback)", () => {
		const ctx = { hasUI: true };
		assert.ok(isInteractiveTui(ctx), "hasUI=true should fallback to true");
	});

	it("mode='non-interactive' should return false", () => {
		const ctx = { hasUI: true, mode: "non-interactive" };
		assert.ok(!isInteractiveTui(ctx), "mode='non-interactive' should return false");
	});

	it("mode='headless' should return false", () => {
		const ctx = { hasUI: true, mode: "headless" };
		assert.ok(!isInteractiveTui(ctx), "mode='headless' should return false");
	});

	it("mode='headless' with hasUI=false should return false", () => {
		const ctx = { hasUI: false, mode: "headless" };
		assert.ok(!isInteractiveTui(ctx), "mode='headless' with hasUI=false should return false");
	});

	it("hasUI=false with no mode should return false", () => {
		const ctx = { hasUI: false };
		assert.ok(!isInteractiveTui(ctx), "hasUI=false with no mode should return false");
	});
});
