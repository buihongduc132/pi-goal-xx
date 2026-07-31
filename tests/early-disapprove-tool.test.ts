/**
 * RED PHASE — early_disapprove tool definition (LD1 + LD9, OT8).
 *
 * Spec: flow/findings/2026-07-31-auditor-capabilities-gaps/
 *   - 2026-07-31-locked-decisions.yaml → LD1 (must implement early disapproval),
 *     LD9 (signal mechanism = dedicated tool call `early_disapprove(reason)`)
 *   - 2026-07-31-open-threads.yaml → OT8 (Rank 1 CRITICAL: do NOT watch text_delta
 *     for <disapproved/> mid-stream — it false-positives on quoted markers.
 *     Use a dedicated tool call instead.)
 * Plan: flow/plans/2026-07-31_pre-audit-hooks-and-early-disapprove.md (RED-B).
 *
 * Contract under test (GREEN implements):
 *  - New module `extensions/early-disapprove-tool.ts`.
 *  - Exports `EARLY_DISAPPROVE_TOOL_NAME` (const === "early_disapprove").
 *  - Exports `earlyDisapproveTool` (a defineTool() result):
 *      * name === "early_disapprove"
 *      * parameters accept { reason: string } (reason required)
 *      * description and/or promptSnippet states it aborts the session immediately
 *      * execute(toolCallId, { reason }) returns AgentToolResult whose content text
 *        contains the supplied reason
 *
 * Today these FAIL: the module does not exist yet (import resolves to "cannot find
 * module" at runtime). Project `tsc --noEmit` stays green because tests are excluded
 * from tsconfig (see tool-instruction-parts.test.ts precedent).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	EARLY_DISAPPROVE_TOOL_NAME,
	earlyDisapproveTool,
} from "../extensions/early-disapprove-tool.ts";

// The tool object is a ToolDefinition. describe/label/parameters/execute are all
// part of the pi-coding-agent ToolDefinition contract — see
// node_modules/@earendil-works/pi-coding-agent/.../extensions/types.d.ts.
interface ToolLike {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	parameters: {
		type: string;
		properties?: Record<string, { type?: string }>;
		required?: string[];
	};
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content?: Array<{ type: string; text?: string }>; details?: unknown }>;
}

const tool = earlyDisapproveTool as unknown as ToolLike;

describe("early_disapprove tool — name constant (LD9)", () => {
	it("EARLY_DISAPPROVE_TOOL_NAME === 'early_disapprove'", () => {
		assert.equal(EARLY_DISAPPROVE_TOOL_NAME, "early_disapprove");
	});

	it("tool.name === 'early_disapprove'", () => {
		assert.equal(tool.name, "early_disapprove");
	});
});

describe("early_disapprove tool — parameters accept { reason: string }", () => {
	it("parameters is an object schema", () => {
		assert.equal(tool.parameters.type, "object");
	});

	it("parameters declare a `reason` string property", () => {
		assert.ok(tool.parameters.properties, "parameters must have a properties map");
		const reason = tool.parameters.properties!.reason;
		assert.ok(reason, "parameters must declare a `reason` property");
		assert.equal(reason.type, "string", "`reason` must be a string");
	});

	it("`reason` is a REQUIRED parameter", () => {
		assert.ok(
			Array.isArray(tool.parameters.required) && tool.parameters.required.includes("reason"),
			"`reason` must be listed in parameters.required",
		);
	});
});

describe("early_disapprove tool — metadata says it aborts the session immediately", () => {
	it("description and/or promptSnippet mention abort", () => {
		const combined = `${tool.description} ${tool.promptSnippet ?? ""}`.toLowerCase();
		assert.ok(
			combined.includes("abort"),
			"tool metadata must communicate that calling it aborts the session",
		);
	});

	it("description and/or promptSnippet mention immediacy (immediate / immediately / early)", () => {
		const combined = `${tool.description} ${tool.promptSnippet ?? ""}`.toLowerCase();
		assert.ok(
			combined.includes("immediate") || combined.includes("immediately") || combined.includes("early"),
			"tool metadata must communicate that the abort is immediate / early",
		);
	});
});

describe("early_disapprove tool — execute() echoes the reason (LD9 structured reason)", () => {
	it("execute returns content whose text contains the supplied reason", async () => {
		const reason = "fundamental objective unmet — executor produced a scaffold, not the real artifact";
		const out = await tool.execute("tc-early-disapprove-test", { reason }, undefined, undefined, undefined);
		assert.ok(Array.isArray(out.content), "execute must return a content array");
		const text = out.content!.map((p) => p.text ?? "").join("\n");
		assert.ok(
			text.includes(reason),
			"execute content must include the supplied reason so the auditor result can surface it",
		);
	});
});
