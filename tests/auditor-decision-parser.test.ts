/**
 * Regression tests for parseAuditorDecision.
 *
 * Bug: Parser used .test() which returns true if pattern appears ANYWHERE.
 * When auditor's report body references <disapproved/> as evidence (quoting
 * the original bug), the parser saw both markers and rejected even though
 * the final verdict was <approved/>.
 *
 * Fix: Use last-occurrence strategy — whichever marker appears LAST is the
 * actual verdict (the prompt instructs the model to end with one marker).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuditorDecision } from "../extensions/goal-auditor.ts";

describe("parseAuditorDecision — basic parsing", () => {
	it("returns approved:true when output ends with <approved/>", () => {
		const result = parseAuditorDecision("Audit report\n\n<approved/>");
		assert.equal(result.approved, true);
		assert.equal(result.disapproved, false);
	});

	it("returns disapproved:true when output ends with <disapproved/>", () => {
		const result = parseAuditorDecision("Audit report\n\n<disapproved/>");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
	});

	it("returns both false when no markers present", () => {
		const result = parseAuditorDecision("Audit report without verdict");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, false);
	});
});

describe("parseAuditorDecision — last-occurrence strategy (the bug)", () => {
	it("approves when body mentions <disapproved/> as evidence but ends with <approved/>", () => {
		// This is the exact pattern that caused the false rejection:
		// auditor's report quotes the original bug evidence (<disapproved/>)
		// but the final verdict is <approved/>.
		const output = [
			"The trace confirms the bug: 5th attempt produced 8660 bytes with `<disapproved/>`.",
			"",
			"## Audit Report",
			"Root cause fixed. Tests added. Deployed.",
			"",
			"<approved/>",
		].join("\n");
		const result = parseAuditorDecision(output);
		assert.equal(result.approved, true, "should approve — final marker wins");
		assert.equal(result.disapproved, false);
	});

	it("disapproves when body mentions <approved/> as evidence but ends with <disapproved/>", () => {
		const output = [
			"Previous attempt incorrectly showed `<approved/>` in trace.",
			"",
			"## Audit Report",
			"Objective not satisfied.",
			"",
			"<disapproved/>",
		].join("\n");
		const result = parseAuditorDecision(output);
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true, "should disapprove — final marker wins");
	});

	it("approves when multiple <disapproved/> in body but <approved/> is last", () => {
		const output = [
			"<disapproved/>",
			"<disapproved/>",
			"<disapproved/>",
			"",
			"<approved/>",
		].join("\n");
		const result = parseAuditorDecision(output);
		assert.equal(result.approved, true, "should approve — last marker wins");
		assert.equal(result.disapproved, false);
	});

	it("disapproves when multiple <approved/> in body but <disapproved/> is last", () => {
		const output = [
			"<approved/>",
			"<approved/>",
			"",
			"<disapproved/>",
		].join("\n");
		const result = parseAuditorDecision(output);
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true, "should disapprove — last marker wins");
	});
});

describe("parseAuditorDecision — edge cases", () => {
	it("handles markers with whitespace variations", () => {
		const result = parseAuditorDecision("Report\n\n<approved />");
		assert.equal(result.approved, true);
		assert.equal(result.disapproved, false);
	});

	it("handles markers with extra newlines after", () => {
		const result = parseAuditorDecision("Report\n\n<approved/>\n\n\n");
		assert.equal(result.approved, true);
		assert.equal(result.disapproved, false);
	});

	it("handles empty output", () => {
		const result = parseAuditorDecision("");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, false);
	});
});
