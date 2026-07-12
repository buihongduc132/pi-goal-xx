/**
 * Permanent guard: no `console.*` calls in extensions/.
 *
 * All operational logging MUST route through the goal-trace module
 * (extensions/goal-trace.ts). This test reads the source of every extension
 * file and fails if any `console.log|error|warn|info|debug` call is present.
 *
 * Rationale: the project suffered recurring crash/exit bugs with logging that
 * went only to stderr (lost in RPC/headless mode). The goal-trace JSONL sink is
 * the single source of truth for diagnostics. This guard prevents regressions
 * where a `console.*` is reintroduced.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const EXTENSIONS_DIR = path.join(import.meta.dirname, "..", "extensions");

function listExtensionFiles(): string[] {
	return fs.readdirSync(EXTENSIONS_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => path.join(EXTENSIONS_DIR, f));
}

// Matches `console.<method>(` as a real call. We intentionally do NOT match the
// word "console" inside a string/comment by anchoring on the call form. A stray
// mention in a comment is allowed; a call is not.
const CONSOLE_CALL = /console\s*\.\s*(?:log|error|warn|info|debug)\s*\(/g;

describe("no-console guard — extensions/ routes all logging through goal-trace", () => {
	it("no extension file contains a console.* call", () => {
		const offenders: string[] = [];
		for (const file of listExtensionFiles()) {
			const src = fs.readFileSync(file, "utf8");
			// Strip block + line comments so commented-out console calls (rare,
			// but possible in dev notes) don't trip the guard — only real code counts.
			const stripped = src
				.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
				.replace(/^\s*\/\/.*$/gm, "");     // line comments
			const matches = stripped.match(CONSOLE_CALL);
			if (matches && matches.length > 0) {
				offenders.push(`${path.basename(file)}: ${matches.length} call(s)`);
			}
		}
		assert.deepEqual(
			offenders,
			[],
			`Found console.* calls — all logging must go through goal-trace.ts:\n${offenders.join("\n")}`,
		);
	});
});
