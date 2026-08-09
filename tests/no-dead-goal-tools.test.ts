/**
 * RED-phase guard: the four "dead" goal tools MUST NOT come back.
 *
 * Dead tools (the block/question/pause family the user demanded removed):
 *   pause_goal, abort_goal, goal_question, goal_questionnaire
 *
 * This test scans every file in extensions/ and asserts:
 *   1. No dead tool name appears as a registered tool (i.e. not passed to
 *      pi.registerTool / ctx.registerTool with that exact name).
 *   2. No dead tool name appears inside an ACTIVE/PAUSED/WORK tool surface
 *      constant (string literal occurrence is enough to fail — these sets are
 *      small and intentionally curated).
 *
 * The agent-prompt strings in goal.ts / goal-prompts.ts MUST NOT instruct the
 * agent to "call pause_goal", "call abort_goal", "call goal_question", or
 * "call goal_questionnaire". We assert that no prompt string contains
 * `call pause_goal`, `call abort_goal`, `call goal_question`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const DEAD_TOOLS = ["pause_goal", "abort_goal", "goal_question", "goal_questionnaire"] as const;

const EXT_DIR = path.resolve(import.meta.dirname, "..", "extensions");

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

function readFiles(): Map<string, string> {
	const map = new Map<string, string>();
	for (const f of listTsFiles(EXT_DIR)) {
		map.set(path.relative(EXT_DIR, f), fs.readFileSync(f, "utf8"));
	}
	return map;
}

describe("dead goal tools are absent from extensions/ source", () => {
	it("no dead tool name appears anywhere in extensions/*.ts", () => {
		const files = readFiles();
		const violations: string[] = [];
		for (const [rel, src] of files) {
			for (const dead of DEAD_TOOLS) {
				// Plain substring scan — any occurrence (literal string, identifier,
				// comment) means the dead tool has crept back in.
				if (src.includes(dead)) {
					violations.push(`${rel}: contains "${dead}"`);
				}
			}
		}
		assert.deepEqual(violations, [], `dead tool names still present:\n${violations.join("\n")}`);
	});

	it("no prompt instructs the agent to call a dead tool", () => {
		const files = readFiles();
		const bannedCalls = [
			"call pause_goal",
			"call abort_goal",
			"call goal_question",
			"call goal_questionnaire",
			"use goal_question",
			"use goal_questionnaire",
			"use pause_goal",
			"use abort_goal",
		];
		const violations: string[] = [];
		for (const [rel, src] of files) {
			const lower = src.toLowerCase();
			for (const ban of bannedCalls) {
				if (lower.includes(ban.toLowerCase())) {
					violations.push(`${rel}: instructs "${ban}"`);
				}
			}
		}
		assert.deepEqual(violations, [], `dead-tool call instructions still present:\n${violations.join("\n")}`);
	});
});
