import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const EXTENSIONS_DIR = path.resolve(import.meta.dirname, "..", "extensions");

/**
 * Grep-based regression guard: ensure files that call `ctx.ui.custom()`
 * do NOT guard that call with a raw `if (!ctx.hasUI)` pattern.
 *
 * This guards against the RPC hasUI lie regression (ctx.hasUI is true in
 * RPC mode but ctx.ui.custom() is a no-op returning undefined).
 *
 * Files that use ctx.ui.custom MUST use isInteractiveTui(ctx) instead.
 * Files that only use T0/T1 surfaces (notify/confirm/select) are exempt.
 */
describe("grep guard — ctx.ui.custom files must not use raw !ctx.hasUI", () => {
	it("extensions/ files with ctx.ui.custom must not contain `if (!ctx.hasUI)`", () => {
		const violations: string[] = [];
		const scanDir = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					scanDir(fullPath);
				} else if (entry.name.endsWith(".ts")) {
					const content = fs.readFileSync(fullPath, "utf-8");
					if (!content.includes("ctx.ui.custom")) continue;

					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
						if (/if\s*\(\s*!\s*ctx\.hasUI\b/.test(line)) {
							const rel = path.relative(EXTENSIONS_DIR, fullPath);
							violations.push(`${rel}:${i + 1}: ${line.trim()}`);
						}
					}
				}
			}
		};
		scanDir(EXTENSIONS_DIR);
		assert.equal(
			violations.length,
			0,
			`Files calling ctx.ui.custom must use isInteractiveTui(ctx), not raw if (!ctx.hasUI).\n${violations.join("\n")}`,
		);
	});
});
