/**
 * RED PHASE tests for the unified prompt-resolver module.
 *
 * Target: ../extensions/prompt-resolver.ts (NOT YET IMPLEMENTED — these
 * tests MUST fail with a module-not-found / import error until GREEN lands).
 *
 * Spec: openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 * Design: openspec/changes/unified-prompt-config/design.md (section D1)
 *
 * Public API under test:
 *   export type PromptMode =
 *     "override" | "append" | "global-local" | "local" | "global-local-merge" | "off";
 *   export interface PromptConfig { mode?: PromptMode; inline?: string; }
 *   export interface ResolvedPrompt {
 *     body: string;
 *     source: "inline" | "global" | "local" | "merged" | "none";
 *   }
 *   export function resolvePrompt(
 *     key: string,
 *     cfg: PromptConfig | undefined,
 *     cwd: string,
 *     hardcodedDefault: string,
 *     opts?: { promptsDir?: string; home?: string },
 *   ): { final: string; injected?: string };
 *
 * Semantics (design D1 + spec):
 *   - inline ALWAYS wins regardless of mode (spec: Resolution sources and precedence)
 *   - override:   final = cfg.inline ?? <file body for key> ?? hardcodedDefault
 *   - append:     final = hardcodedDefault + (resolved ? "\n\n" + resolved : "")
 *                 injected = resolved block (or undefined)
 *   - global-local (DEFAULT): local wins over global; append-style (prepends default)
 *   - local:      only local file checked; append-style
 *   - global-local-merge: global + "\n\n" + local when both present; append-style
 *   - off:        no injection even if files exist; final = hardcodedDefault
 *
 * File paths:
 *   global = path.join(home, promptsDir, key + ".md")
 *   local  = path.join(cwd,  promptsDir, key + ".md")
 *   default promptsDir = ".pi/pi-goal-xx/prompts/"
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	resolvePrompt,
} from "../extensions/prompt-resolver.ts";
import type { PromptConfig, PromptMode } from "../extensions/prompt-resolver.ts";

const DEFAULT_PROMPT = "HARDCODED-DEFAULT-BODY";
const KEY = "goal-running";
const DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/";

interface Sandbox {
	cwd: string;
	home: string;
	/** Write a global prompt file for `key` (default promptsDir). */
	writeGlobal(text: string, key?: string): void;
	/** Write a local prompt file for `key` (default promptsDir). */
	writeLocal(text: string, key?: string): void;
	/** Remove the global prompt file for `key`. */
	removeGlobal(key?: string): void;
	/** Remove the local prompt file for `key`. */
	removeLocal(key?: string): void;
	/** Bump the global file mtime forward (forces cache invalidation). */
	bumpGlobalMtime(seconds: number, key?: string): void;
	/** Bump the local file mtime forward (forces cache invalidation). */
	bumpLocalMtime(seconds: number, key?: string): void;
}

function makeSandbox(promptsDir: string = DEFAULT_PROMPTS_DIR): Sandbox {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-resolv-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-resolv-home-"));
	fs.mkdirSync(path.join(home, promptsDir), { recursive: true });
	fs.mkdirSync(path.join(cwd, promptsDir), { recursive: true });

	const globalPath = (key: string) => path.join(home, promptsDir, `${key}.md`);
	const localPath = (key: string) => path.join(cwd, promptsDir, `${key}.md`);

	return {
		cwd,
		home,
		writeGlobal(text, key = KEY) {
			fs.writeFileSync(globalPath(key), text, "utf8");
		},
		writeLocal(text, key = KEY) {
			fs.writeFileSync(localPath(key), text, "utf8");
		},
		removeGlobal(key = KEY) {
			try { fs.unlinkSync(globalPath(key)); } catch {}
		},
		removeLocal(key = KEY) {
			try { fs.unlinkSync(localPath(key)); } catch {}
		},
		bumpGlobalMtime(seconds, key = KEY) {
			const p = globalPath(key);
			const future = (Date.now() / 1000) + seconds;
			fs.utimesSync(p, future, future);
		},
		bumpLocalMtime(seconds, key = KEY) {
			const p = localPath(key);
			const future = (Date.now() / 1000) + seconds;
			fs.utimesSync(p, future, future);
		},
	};
}

let sb: Sandbox;

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => {
	try { fs.rmSync(sb.cwd, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(sb.home, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// 1. No configuration present
// ---------------------------------------------------------------------------
describe("resolvePrompt — no configuration present", () => {
	it("returns hardcodedDefault with no injected block when cfg is undefined", () => {
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("returns hardcodedDefault when cfg is an empty object (mode absent)", () => {
		const r = resolvePrompt(KEY, {}, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("returns hardcodedDefault when no files exist and mode is the default", () => {
		const r = resolvePrompt(KEY, { mode: "global-local" }, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});
});

// ---------------------------------------------------------------------------
// 2. Inline override for a runtime prompt (mode override + inline)
// ---------------------------------------------------------------------------
describe("resolvePrompt — inline override (mode override + inline)", () => {
	it("final is the inline string only, hardcodedDefault is fully replaced", () => {
		const r = resolvePrompt(
			KEY,
			{ mode: "override", inline: "Always delegate implementation to a team" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "Always delegate implementation to a team");
	});

	it("override + inline ignores both file channels", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = resolvePrompt(
			KEY,
			{ mode: "override", inline: "INLINE-ONLY" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "INLINE-ONLY");
		assert.ok(!r.final.includes("GLOBAL"));
		assert.ok(!r.final.includes("LOCAL"));
		assert.ok(!r.final.includes(DEFAULT_PROMPT));
	});
});

// ---------------------------------------------------------------------------
// 3. Append mode + local file
// ---------------------------------------------------------------------------
describe("resolvePrompt — append mode", () => {
	it("append + local file → hardcoded + '\\n\\n' + file; injected = file body", () => {
		sb.writeLocal("Require verifier-loop before completion");
		const r = resolvePrompt(
			KEY,
			{ mode: "append" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nRequire verifier-loop before completion`);
		assert.equal(r.injected, "Require verifier-loop before completion");
	});

	it("append + global file (no local) → hardcoded + global; injected = global", () => {
		sb.writeGlobal("GLOBAL-RULE");
		const r = resolvePrompt(
			KEY,
			{ mode: "append" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGLOBAL-RULE`);
		assert.equal(r.injected, "GLOBAL-RULE");
	});

	it("append + no file → hardcodedDefault only; injected = undefined", () => {
		const r = resolvePrompt(
			KEY,
			{ mode: "append" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("append + inline → inline REPLACES default (inline always wins as override)", () => {
		// UNIFIED INLINE SEMANTICS: inline always wins as override regardless
		// of mode. This closes the off+inline divergence between the generic
		// resolver and loadAuditorPrompt. Spec: 'Inline always wins regardless
		// of mode'. File-sourced bodies remain mode-dependent.
		const r = resolvePrompt(
			KEY,
			{ mode: "append", inline: "INLINE-WINS" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "INLINE-WINS");
		assert.equal(r.source, "inline");
		assert.ok(!r.final.includes(DEFAULT_PROMPT), "hardcodedDefault dropped under inline");
	});

	it("append + merge of both files → hardcoded + merged block", () => {
		sb.writeGlobal("G");
		sb.writeLocal("L");
		const r = resolvePrompt(
			KEY,
			{ mode: "append" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		// Append mode resolves files via the default global-local strategy
		// (local wins when both present) — append is about *how* the resolved
		// block is combined with the default, not how files combine.
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nL`);
	});
});

// ---------------------------------------------------------------------------
// 4. global-local-merge with both files
// ---------------------------------------------------------------------------
describe("resolvePrompt — global-local-merge", () => {
	it("both present → hardcoded + global + local", () => {
		sb.writeGlobal("Global rule");
		sb.writeLocal("Local rule");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGlobal rule\n\nLocal rule`);
		assert.equal(r.injected, "Global rule\n\nLocal rule");
	});

	it("global only → hardcoded + global", () => {
		sb.writeGlobal("Global rule");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGlobal rule`);
		assert.equal(r.injected, "Global rule");
	});

	it("local only → hardcoded + local", () => {
		sb.writeLocal("Local rule");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLocal rule`);
		assert.equal(r.injected, "Local rule");
	});

	it("neither → hardcodedDefault; no injected", () => {
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});
});

// ---------------------------------------------------------------------------
// 5. global-local (default) — local wins
// ---------------------------------------------------------------------------
describe("resolvePrompt — global-local (default mode)", () => {
	it("both present → only local used (local wins)", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("LOCAL");
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL`);
		assert.equal(r.injected, "LOCAL");
	});

	it("global only → global used", () => {
		sb.writeGlobal("GLOBAL");
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGLOBAL`);
		assert.equal(r.injected, "GLOBAL");
	});

	it("local only → local used", () => {
		sb.writeLocal("LOCAL");
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL`);
		assert.equal(r.injected, "LOCAL");
	});

	it("explicit mode 'global-local' behaves identically to absent mode", () => {
		sb.writeGlobal("G");
		sb.writeLocal("L");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nL`);
	});
});

// ---------------------------------------------------------------------------
// 6. Inline always wins regardless of mode
// ---------------------------------------------------------------------------
describe("resolvePrompt — inline always wins regardless of mode", () => {
	it("inline + both files + global-local-merge → inline REPLACES default (unified semantics)", () => {
		// UNIFIED INLINE SEMANTICS: inline always wins as override — replaces
		// hardcodedDefault entirely, drops all file bodies. Mode is irrelevant
		// when inline is present (spec: 'Inline always wins regardless of mode').
		sb.writeGlobal("GLOBAL-BODY");
		sb.writeLocal("LOCAL-BODY");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge", inline: "X" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "X");
		assert.equal(r.source, "inline");
		assert.ok(!r.final.includes("GLOBAL-BODY"));
		assert.ok(!r.final.includes("LOCAL-BODY"));
		assert.ok(!r.final.includes(DEFAULT_PROMPT), "hardcodedDefault dropped under inline");
	});

	it("inline + override mode → final = inline, hardcodedDefault dropped", () => {
		sb.writeGlobal("G");
		sb.writeLocal("L");
		const r = resolvePrompt(
			KEY,
			{ mode: "override", inline: "INLINE" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "INLINE");
	});

	it("inline + off mode → inline STILL wins as override (unified semantics)", () => {
		sb.writeGlobal("GLOBALFILEBODY");
		sb.writeLocal("LOCALFILEBODY");
		const r = resolvePrompt(
			KEY,
			{ mode: "off", inline: "INLINE-DESPITE-OFF" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		// UNIFIED INLINE SEMANTICS: inline always wins as override — replaces
		// hardcodedDefault entirely. Off suppresses FILE injection only;
		// inline bypasses the mode check entirely. Matches loadAuditorPrompt.
		assert.equal(r.final, "INLINE-DESPITE-OFF");
		assert.equal(r.source, "inline");
		assert.ok(!r.final.includes(DEFAULT_PROMPT), "hardcodedDefault dropped under inline+off");
		assert.ok(!r.final.includes("GLOBALFILEBODY"), "global file not consulted under off");
		assert.ok(!r.final.includes("LOCALFILEBODY"), "local file not consulted under off");
	});

	it("blank inline is ignored (treated as absent)", () => {
		sb.writeLocal("LOCAL");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local", inline: "   " },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL`);
	});
});

// ---------------------------------------------------------------------------
// 7. Each of the 6 modes exercised explicitly
// ---------------------------------------------------------------------------
describe("resolvePrompt — all six modes", () => {
	const modes: PromptMode[] = [
		"override",
		"append",
		"global-local",
		"local",
		"global-local-merge",
		"off",
	];

	for (const mode of modes) {
		it(`mode "${mode}" with no files + no inline → final = hardcodedDefault`, () => {
			const cfg: PromptConfig = { mode };
			const r = resolvePrompt(KEY, cfg, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
			assert.equal(r.final, DEFAULT_PROMPT);
			assert.equal(r.injected, undefined);
		});
	}

	it("mode 'local' uses only the local file (global ignored even when present)", () => {
		sb.writeGlobal("SHOULD-NOT-APPEAR");
		sb.writeLocal("LOCAL-ONLY");
		const r = resolvePrompt(
			KEY,
			{ mode: "local" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL-ONLY`);
		assert.equal(r.injected, "LOCAL-ONLY");
		assert.ok(!r.final.includes("SHOULD-NOT-APPEAR"));
	});

	it("mode 'local' with no local file → hardcodedDefault even if global exists", () => {
		sb.writeGlobal("GLOBAL-ONLY");
		const r = resolvePrompt(
			KEY,
			{ mode: "local" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("mode 'override' with file (no inline) → final = file body, default replaced", () => {
		sb.writeLocal("FILE-AS-OVERRIDE");
		const r = resolvePrompt(
			KEY,
			{ mode: "override" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "FILE-AS-OVERRIDE");
	});

	it("mode 'override' with global file (no inline, no local) → final = global body", () => {
		sb.writeGlobal("GLOBAL-FILE");
		const r = resolvePrompt(
			KEY,
			{ mode: "override" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "GLOBAL-FILE");
	});

	it("mode 'off' with both files present → final = hardcodedDefault, no injection", () => {
		// Distinctive multi-char markers — single-letter markers like "G"/"L"
		// collide with letters inside DEFAULT_PROMPT (="HARDCODED-DEFAULT-BODY",
		// which contains "L" inside "DEFAULT"), making substring assertions
		// pass/fail for the wrong reason.
		sb.writeGlobal("GLOBAL-MARKER-X9");
		sb.writeLocal("LOCAL-MARKER-X9");
		const r = resolvePrompt(
			KEY,
			{ mode: "off" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
		assert.ok(!r.final.includes("GLOBAL-MARKER-X9"));
		assert.ok(!r.final.includes("LOCAL-MARKER-X9"));
	});
});

// ---------------------------------------------------------------------------
// 8. Custom promptsDir honored
// ---------------------------------------------------------------------------
describe("resolvePrompt — custom promptsDir", () => {
	it("custom promptsDir is honored for both global and local resolution", () => {
		const customDir = ".pi/my-custom-prompts/";
		const sb2 = makeSandbox(customDir);
		try {
			sb2.writeGlobal("CUSTOM-GLOBAL");
			sb2.writeLocal("CUSTOM-LOCAL");
			const r = resolvePrompt(
				KEY,
				{ mode: "global-local-merge" },
				sb2.cwd,
				DEFAULT_PROMPT,
				{ home: sb2.home, promptsDir: customDir },
			);
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nCUSTOM-GLOBAL\n\nCUSTOM-LOCAL`);
		} finally {
			fs.rmSync(sb2.cwd, { recursive: true, force: true });
			fs.rmSync(sb2.home, { recursive: true, force: true });
		}
	});

	it("custom promptsDir does NOT read from the default dir", () => {
		const customDir = ".pi/alt-prompts/";
		const sb2 = makeSandbox(customDir);
		try {
			// Write to the DEFAULT dir (should be ignored).
			fs.mkdirSync(path.join(sb2.cwd, DEFAULT_PROMPTS_DIR), { recursive: true });
			fs.mkdirSync(path.join(sb2.home, DEFAULT_PROMPTS_DIR), { recursive: true });
			fs.writeFileSync(
				path.join(sb2.cwd, DEFAULT_PROMPTS_DIR, `${KEY}.md`),
				"DEFAULT-DIR-LOCAL",
				"utf8",
			);
			fs.writeFileSync(
				path.join(sb2.home, DEFAULT_PROMPTS_DIR, `${KEY}.md`),
				"DEFAULT-DIR-GLOBAL",
				"utf8",
			);
			// Write to the custom dir (should win).
			sb2.writeLocal("ALT-LOCAL");

			const r = resolvePrompt(
				KEY,
				{ mode: "global-local" },
				sb2.cwd,
				DEFAULT_PROMPT,
				{ home: sb2.home, promptsDir: customDir },
			);
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nALT-LOCAL`);
			assert.ok(!r.final.includes("DEFAULT-DIR"));
		} finally {
			fs.rmSync(sb2.cwd, { recursive: true, force: true });
			fs.rmSync(sb2.home, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 9. off mode with files present
// ---------------------------------------------------------------------------
describe("resolvePrompt — off mode", () => {
	it("off mode + both files → no injection, final = hardcodedDefault", () => {
		sb.writeGlobal("G");
		sb.writeLocal("L");
		const r = resolvePrompt(
			KEY,
			{ mode: "off" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("off mode + local file only → no injection", () => {
		sb.writeLocal("L");
		const r = resolvePrompt(
			KEY,
			{ mode: "off" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});
});

// ---------------------------------------------------------------------------
// 10. mtime-keyed in-memory cache invalidation
// ---------------------------------------------------------------------------
describe("resolvePrompt — mtime cache invalidation", () => {
	it("editing a file changes the resolved body on the next call", () => {
		sb.writeLocal("VERSION-1");
		const r1 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r1.final, `${DEFAULT_PROMPT}\n\nVERSION-1`);

		// Overwrite the file with new content AND a forward-dated mtime so any
		// mtime-keyed cache MUST invalidate (regardless of FS mtime resolution).
		fs.writeFileSync(path.join(sb.cwd, DEFAULT_PROMPTS_DIR, `${KEY}.md`), "VERSION-2", "utf8");
		sb.bumpLocalMtime(60);

		const r2 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r2.final, `${DEFAULT_PROMPT}\n\nVERSION-2`);
		assert.notEqual(r2.final, r1.final);
	});

	it("global file edits are also reflected on the next call", () => {
		sb.writeGlobal("G1");
		const r1 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r1.final, `${DEFAULT_PROMPT}\n\nG1`);

		fs.writeFileSync(path.join(sb.home, DEFAULT_PROMPTS_DIR, `${KEY}.md`), "G2", "utf8");
		sb.bumpGlobalMtime(60);

		const r2 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r2.final, `${DEFAULT_PROMPT}\n\nG2`);
	});

	it("unchanged file content resolves identically across calls (cache hit is safe)", () => {
		sb.writeLocal("STABLE");
		const r1 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		const r2 = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r1.final, r2.final);
		assert.equal(r2.final, `${DEFAULT_PROMPT}\n\nSTABLE`);
	});
});

// ---------------------------------------------------------------------------
// 11. Empty / whitespace file treated as absent
// ---------------------------------------------------------------------------
describe("resolvePrompt — empty / whitespace file handling", () => {
	it("blank local file treated as missing → falls back to global", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("   \n\n  ");
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGLOBAL`);
		assert.equal(r.injected, "GLOBAL");
	});

	it("blank global + blank local → hardcodedDefault, no injection", () => {
		sb.writeGlobal("\n\n\n");
		sb.writeLocal("\t\t  \n");
		const r = resolvePrompt(KEY, undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("blank local in global-local-merge → only global used (no merge)", () => {
		sb.writeGlobal("GLOBAL");
		sb.writeLocal("   ");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local-merge" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGLOBAL`);
	});

	it("blank file in override mode → falls back to hardcodedDefault", () => {
		sb.writeLocal("   \n  ");
		const r = resolvePrompt(
			KEY,
			{ mode: "override" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
	});
});

// ---------------------------------------------------------------------------
// 12. cwd-safe behavior: empty-string cwd
// ---------------------------------------------------------------------------
describe("resolvePrompt — empty-string cwd safety", () => {
	it("empty cwd + inline → inline resolves as override (unified semantics, no fs context needed)", () => {
		// UNIFIED INLINE SEMANTICS: inline always wins as override regardless
		// of mode. No fs context needed — inline bypasses the mode check.
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local", inline: "INLINE-NO-CWD" },
			"",
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "INLINE-NO-CWD");
		assert.equal(r.source, "inline");
		assert.ok(!r.final.includes(DEFAULT_PROMPT), "hardcodedDefault dropped under inline");
	});

	it("empty cwd + global file → global still resolves via home", () => {
		sb.writeGlobal("GLOBAL-VIA-HOME");
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local" },
			"",
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nGLOBAL-VIA-HOME`);
	});

	it("empty cwd + no inline + no global → hardcodedDefault (local not consulted)", () => {
		const r = resolvePrompt(
			KEY,
			{ mode: "global-local" },
			"",
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, DEFAULT_PROMPT);
		assert.equal(r.injected, undefined);
	});

	it("empty cwd + override + inline → final = inline only", () => {
		const r = resolvePrompt(
			KEY,
			{ mode: "override", inline: "OVR-NO-CWD" },
			"",
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, "OVR-NO-CWD");
	});
});

// ---------------------------------------------------------------------------
// Bonus: distinct keys resolve independently
// ---------------------------------------------------------------------------
describe("resolvePrompt — key isolation", () => {
	it("different keys read different files", () => {
		sb.writeLocal("RUNNING-BODY", "goal-running");
		sb.writeLocal("DRAFTING-BODY", "goal-drafting");
		const r1 = resolvePrompt("goal-running", undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		const r2 = resolvePrompt("goal-drafting", undefined, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
		assert.equal(r1.final, `${DEFAULT_PROMPT}\n\nRUNNING-BODY`);
		assert.equal(r2.final, `${DEFAULT_PROMPT}\n\nDRAFTING-BODY`);
	});
});

// ---------------------------------------------------------------------------
// 13. cfg.file — arbitrary file path source
// ---------------------------------------------------------------------------
//
// RED PHASE: `cfg.file` is NOT yet implemented in prompt-resolver.ts.
// Resolution priority once GREEN lands:
//   inline > cfg.file > mode-based file lookup (${promptsDir}/${key}.md)
//   > legacy > default
//
// Feature tests below (basic load, override, append, tilde, relative) MUST
// fail until GREEN adds cfg.file support. A subset are INVARIANT guards
// (inline beats file, off ignores file, missing/empty file falls through)
// that pass in BOTH phases because they assert the file is correctly ignored.
describe("cfg.file — arbitrary file path source", () => {
	it("basic load: cfg.file points at a real file → appended to default", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-src-"));
		try {
			const fileAbs = path.join(dir, "prompt-from-file.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(KEY, { file: fileAbs }, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nFROM-FILE`);
			assert.equal(r.injected, "FROM-FILE");
			assert.equal(r.source, "local");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("override mode + cfg.file → file REPLACES default entirely", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-ovr-"));
		try {
			const fileAbs = path.join(dir, "override.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(
				KEY,
				{ file: fileAbs, mode: "override" },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home: sb.home },
			);
			assert.equal(r.final, "FROM-FILE");
			assert.equal(r.injected, "FROM-FILE");
			assert.equal(r.source, "local");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("append mode + cfg.file → file merged with default", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-app-"));
		try {
			const fileAbs = path.join(dir, "append.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(
				KEY,
				{ file: fileAbs, mode: "append" },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home: sb.home },
			);
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nFROM-FILE`);
			assert.equal(r.source, "local");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("inline beats cfg.file when both set (inline > file)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-inl-"));
		try {
			const fileAbs = path.join(dir, "ignored.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(
				KEY,
				{ inline: "INLINE", file: fileAbs },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home: sb.home },
			);
			assert.equal(r.source, "inline");
			assert.equal(r.final, "INLINE");
			assert.ok(!r.final.includes("FROM-FILE"), "cfg.file body must be ignored under inline");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("nonexistent cfg.file falls through to mode-based local lookup", () => {
		sb.writeLocal("LOCAL-FILE-BODY");
		const r = resolvePrompt(
			KEY,
			{ file: "/does/not/exist.md" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.source, "local");
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL-FILE-BODY`);
		assert.ok(!r.final.includes("FROM-FILE"), "missing cfg.file must NOT leak into output");
	});

	it("empty (whitespace-only) cfg.file falls through to mode-based lookup", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-empty-"));
		try {
			const fileAbs = path.join(dir, "blank.md");
			fs.writeFileSync(fileAbs, "   \n\n  ", "utf8");
			sb.writeLocal("LOCAL-FALLBACK");
			const r = resolvePrompt(KEY, { file: fileAbs }, sb.cwd, DEFAULT_PROMPT, { home: sb.home });
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nLOCAL-FALLBACK`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cfg.file tilde-expands to home directory", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-tilde-home-"));
		try {
			fs.writeFileSync(path.join(home, "my-prompt.md"), "TILDE-BODY", "utf8");
			const r = resolvePrompt(
				KEY,
				{ file: "~/my-prompt.md" },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home },
			);
			assert.equal(r.final, `${DEFAULT_PROMPT}\n\nTILDE-BODY`);
			assert.equal(r.source, "local");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("cfg.file relative path resolves against cwd", () => {
		fs.writeFileSync(path.join(sb.cwd, "relative.md"), "RELATIVE-BODY", "utf8");
		const r = resolvePrompt(
			KEY,
			{ file: "./relative.md" },
			sb.cwd,
			DEFAULT_PROMPT,
			{ home: sb.home },
		);
		assert.equal(r.final, `${DEFAULT_PROMPT}\n\nRELATIVE-BODY`);
		assert.equal(r.source, "local");
	});

	it("off mode + cfg.file → cfg.file ignored (file injection suppressed)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-off-"));
		try {
			const fileAbs = path.join(dir, "off.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(
				KEY,
				{ file: fileAbs, mode: "off" },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home: sb.home },
			);
			assert.equal(r.final, DEFAULT_PROMPT);
			assert.equal(r.source, "none");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cfg.file + inline both set with mode override → inline still wins", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-file-inl2-"));
		try {
			const fileAbs = path.join(dir, "both.md");
			fs.writeFileSync(fileAbs, "FROM-FILE", "utf8");
			const r = resolvePrompt(
				KEY,
				{ inline: "INLINE", file: fileAbs, mode: "override" },
				sb.cwd,
				DEFAULT_PROMPT,
				{ home: sb.home },
			);
			assert.equal(r.source, "inline");
			assert.equal(r.final, "INLINE");
			assert.ok(!r.final.includes("FROM-FILE"), "cfg.file must yield to inline even under override");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Keep the type imports used so tsc doesn't drop them.
((): PromptConfig => ({ mode: "override", inline: "x" }))();
((): PromptMode => "off")();
