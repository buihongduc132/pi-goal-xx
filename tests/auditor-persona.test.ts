/**
 * RED phase: Tests for brutal auditor persona replacement.
 *
 * These tests MUST FAIL against the current weak persona in
 * extensions/goal-auditor.ts buildAuditorPromptParts().
 *
 * Goal: Replace 10-line weak persona with 3-5 line brutal verifier
 * that closes W1-W5 gaps (documented in flow/findings/2026-08-09-goal-prompt-override-append-mode/2026-08-09-turn15-auditor-gotchas.md).
 */

import { describe, it, expect } from "vitest";
import { buildAuditorPromptParts } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

describe("Brutal Auditor Persona", () => {
	const mockGoal: GoalRecord = {
		id: "test-goal",
		objective: "Test objective",
		status: "active",
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	const mockSummary = "Test summary";

	it("persona is 3-5 lines (not 10+ like current weak persona)", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lines = persona.trim().split("\n").filter(l => l.trim().length > 0);
		
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines.length).toBeLessThanOrEqual(5);
	});

	it("persona includes deliverable counting mandate", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must mention counting/quantity when objective names numbers
		expect(
			lowerPersona.includes("count") || 
			lowerPersona.includes("quantity") ||
			lowerPersona.includes("deliverable")
		).toBe(true);
	});

	it("persona includes fabrication detection (missing hashes/files = reject)", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must mention fabrication/lies/missing evidence
		expect(
			lowerPersona.includes("fabricat") || 
			lowerPersona.includes("lies") ||
			lowerPersona.includes("missing") ||
			lowerPersona.includes("fake")
		).toBe(true);
	});

	it("persona includes deflection rejection (capability ≠ execution)", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must reject "technically capable" / "could" claims
		expect(
			lowerPersona.includes("deflect") || 
			lowerPersona.includes("capable") ||
			lowerPersona.includes("could")
		).toBe(true);
	});

	it("persona includes proxy-milestone rejection (green CI ≠ user value)", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must reject green CI / passing tests as proof alone
		expect(
			lowerPersona.includes("proxy") || 
			lowerPersona.includes("milestone") ||
			lowerPersona.includes("ci") ||
			lowerPersona.includes("tests pass")
		).toBe(true);
	});

	it("persona treats objective meta-instructions as gate invariants", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must treat objective's auditor rules as invariants (not preferences)
		expect(
			lowerPersona.includes("invariant") || 
			lowerPersona.includes("gate") ||
			lowerPersona.includes("objective") && lowerPersona.includes("rule")
		).toBe(true);
	});

	it("persona establishes goal as sacred contract, executor claims must be verified", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must establish trust hierarchy: goal = sacred, executor = doubt/verify
		expect(
			lowerPersona.includes("sacred") || 
			lowerPersona.includes("contract") ||
			lowerPersona.includes("trust") && lowerPersona.includes("goal") ||
			lowerPersona.includes("verify") && lowerPersona.includes("claim")
		).toBe(true);
	});

	it("persona has zero-tolerance stance (lies/theatering/cunning = immediate reject)", () => {
		const { persona } = buildAuditorPromptParts({
			goal: mockGoal,
			completionSummary: null,
			detailedSummary: mockSummary,
			verificationSummary: null,
		});

		const lowerPersona = persona.toLowerCase();
		
		// Must have explicit zero-tolerance language
		expect(
			lowerPersona.includes("zero tolerance") || 
			lowerPersona.includes("immediate") && lowerPersona.includes("reject") ||
			lowerPersona.includes("no excuse")
		).toBe(true);
	});
});
