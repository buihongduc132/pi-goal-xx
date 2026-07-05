/**
 * RED PHASE — auditor-prompt delegation + override-mode tests.
 *
 * Drives the migration of `extensions/auditor-prompt.ts` to delegate
 * internally to the unified `resolvePrompt('auditor', ...)` (design D8,
 * tasks group 2). The existing `tests/auditor-prompt.test.ts` is left
 * UNTOUCHED so the baseline stays green; this file layers on the new
 * migration contract.
 *
 * Three classes of tests:
 *
 *  1. BEHAVIORAL PARITY (must PASS today AND after migration):
 *     Representative subset of existing auditor behavior, re-asserted via
 *     the public `loadAuditorPrompt` API. Proves the public contract is
 *     preserved when GREEN refactors internals to delegate.
 *
 *  2. OVERRIDE MODE (pass today by coincidence — override currently falls
 *     through to global-local; document the expected post-migration result):
 *     Because `loadAuditorPrompt` returns ONLY the resolved body in every
 *     legacy mode (the `defaultPrompt` is a pure fallback, never prepended),
 *     override mode is behaviorally equivalent to global-local for the
 *     auditor surface. These tests assert that equivalence + source
 *     correctness, locking in the contract.
 *
 *  3. DELEGATION OBSERVABILITY (RED today — drives GREEN):
 *     After migration, `loadAuditorPrompt` MUST consult the unified
 *     prompts directory (`.pi/pi-goal-xx/prompts/auditor.md`) and honor
 *     `settings.promptsDir` overrides — the observable signature that
 *     `resolvePrompt('auditor', ...)` is actually being called. Today the
 *     legacy resolver only reads `.pi/auditor-prompt.md`, so these fail.
 *
 * Spec refs:
 *   - openspec/changes/unified-prompt-config/specs/prompt-config-resolution/spec.md
 *     (Backward compatibility for auditor settings; Path overrides)
 *   - openspec/changes/unified-prompt-config/design.md D8 (migration plan)
 *   - openspec/changes/unified-prompt-config/tasks.md group 2 (2.1–2.4)
 *
 * NOTE: `override` is not yet in the `AuditorPromptMode` type, and
 * `promptsDir` is not yet on `GoalSettings`. We cast through `unknown` to
 * exercise the runtime contract without waiting on the settings-schema
 * widenings (those land in tasks group 5).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadAuditorPrompt,
	resolveAuditorPromptMode,
} from "../extensions/auditor-prompt.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

const DEFAULT_PROMPT = "DEFAULT-HARDCODED-PROMPT";
const KEY = "auditor";
const LEGACY_DIR = ".pi";
const UNIFIED_DIR = ".pi/pi-goal-xx/prompts";

/** Cast a partial settings object into GoalSettings for testing. */
function settings(partial: Record<string, unknown>): GoalSettings {
	return partial as unknown as GoalSettings;
}

interface Sandbox {
	cwd: string;
	home: string;
	/** Legacy global path: <home>/.pi/auditor-prompt.md */
	legacyGlobal: string;
	/** Legacy local path: <cwd>/.pi/auditor-prompt.md */
	legacyLocal: string;
	/** Unified global path: <home>/.pi/pi-goal-xx/prompts/auditor.md */
	unifiedGlobal: string;
	/** Unified local path: <cwd>/.pi/pi-goal-xx/prompts/auditor.md */
	unifiedLocal: string;
	writeLegacyGlobal(text: string): void;
	writeLegacyLocal(text: string): void;
	writeUnifiedGlobal(text: string): void;
	writeUnifiedLocal(text: string): void;
	writeCustomDirLocal(dir: string, text: string): void;
}

function makeSandbox(): Sandbox {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-aud-deleg-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-aud-deleg-home-"));
	fs.mkdirSync(path.join(home, LEGACY_DIR), { recursive: true });
	fs.mkdirSync(path.join(cwd, LEGACY_DIR), { recursive: true });
	fs.mkdirSync(path.join(home, UNIFIED_DIR), { recursive: true });
	fs.mkdirSync(path.join(cwd, UNIFIED_DIR), { recursive: true });

	const legacyGlobal = path.join(home, LEGACY_DIR, "auditor-prompt.md");
	const legacyLocal = path.join(cwd, LEGACY_DIR, "auditor-prompt.md");
	const unifiedGlobal = path.join(home, UNIFIED_DIR, "auditor.md");
	const unifiedLocal = path.join(cwd, UNIFIED_DIR, "auditor.md");

	return {
		cwd,
		home,
		legacyGlobal,
		legacyLocal,
		unifiedGlobal,
		unifiedLocal,
		writeLegacyGlobal(text) { fs.writeFileSync(legacyGlobal, text, "utf8"); },
		writeLegacyLocal(text) { fs.writeFileSync(legacyLocal, text, "utf8"); },
		writeUnifiedGlobal(text) { fs.writeFileSync(unifiedGlobal, text, "utf8"); },
		writeUnifiedLocal(text) { fs.writeFileSync(unifiedLocal, text, "utf8"); },
		writeCustomDirLocal(dir, text) {
			const abs = path.join(cwd, dir);
			fs.mkdirSync(abs, { recursive: true });
			fs.writeFileSync(path.join(abs, `${KEY}.md`), text, "utf8");
		},
	};
}

let sb: Sandbox;

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => {
	try { fs.rmSync(sb.cwd, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(sb.home, { recursive: true, force: true }); } catch {}
});

// ===========================================================================
// 1. BEHAVIORAL PARITY (must pass today AND stay green after migration)
// ===========================================================================
describe("loadAuditorPrompt — behavioral parity (preserved by migration)", () => {
	it("inline settings.auditorPrompt wins → source 'inline'", () => {
		sb.writeLegacyGlobal("GLOBAL");
		sb.writeLegacyLocal("LOCAL");
		const r = loadAuditorPrompt(
			settings({ auditorPrompt: "INLINE", auditorPromptMode: "local" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "inline");
		assert.equal(r.prompt, "INLINE");
	});

	it("global-local (default): local wins over global", () => {
		sb.writeLegacyGlobal("GLOBAL");
		sb.writeLegacyLocal("LOCAL");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL");
	});

	it("global-local: falls back to global when no local", () => {
		sb.writeLegacyGlobal("GLOBAL");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});

	it("local mode: only local consulted, global ignored", () => {
		sb.writeLegacyGlobal("SHOULD-NOT-APPEAR");
		sb.writeLegacyLocal("LOCAL-ONLY");
		const r = loadAuditorPrompt(
			settings({ auditorPromptMode: "local" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL-ONLY");
	});

	it("global-local-merge: global + local merged with blank line", () => {
		sb.writeLegacyGlobal("GLOBAL");
		sb.writeLegacyLocal("LOCAL");
		const r = loadAuditorPrompt(
			settings({ auditorPromptMode: "global-local-merge" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "merged");
		assert.equal(r.prompt, "GLOBAL\n\nLOCAL");
	});

	it("no config + no files → returns defaultPrompt, source 'default'", () => {
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "default");
		assert.equal(r.prompt, DEFAULT_PROMPT);
	});

	it("empty/whitespace file treated as absent → falls back", () => {
		sb.writeLegacyGlobal("GLOBAL");
		sb.writeLegacyLocal("   \n  \n");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL");
	});

	it("resolveAuditorPromptMode defaults to global-local", () => {
		assert.equal(resolveAuditorPromptMode(undefined), "global-local");
		assert.equal(resolveAuditorPromptMode({} as GoalSettings), "global-local");
	});
});

// ===========================================================================
// 2. OVERRIDE MODE (pass today by fall-through; lock expected result)
// ===========================================================================
describe("loadAuditorPrompt — override mode (new capability)", () => {
	// Auditor never prepends defaultPrompt in ANY mode — the default is a pure
	// fallback. Therefore override mode is behaviorally equivalent to
	// global-local for the auditor surface. These tests lock in the expected
	// post-migration result: override returns the resolved block (or default)
	// with NO defaultPrompt prepended, and correct source labeling.

	it("override + inline → inline wins, source 'inline'", () => {
		sb.writeLegacyGlobal("GLOBAL");
		sb.writeLegacyLocal("LOCAL");
		const r = loadAuditorPrompt(
			settings({ auditorPrompt: "OVR-INLINE", auditorPromptMode: "override" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "inline");
		assert.equal(r.prompt, "OVR-INLINE");
		// defaultPrompt MUST NOT be prepended in override mode.
		assert.ok(!r.prompt.includes(DEFAULT_PROMPT));
	});

	it("override + local file (no inline) → file body, source 'local', no default prepend", () => {
		sb.writeLegacyLocal("LOCAL-OVR-BODY");
		const r = loadAuditorPrompt(
			settings({ auditorPromptMode: "override" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "local");
		assert.equal(r.prompt, "LOCAL-OVR-BODY");
		// Critical override-mode invariant: defaultPrompt is NOT prepended.
		// (If migration accidentally uses append-style, this fails.)
		assert.equal(r.prompt.includes(DEFAULT_PROMPT), false);
	});

	it("override + global file (no inline, no local) → global body, source 'global'", () => {
		sb.writeLegacyGlobal("GLOBAL-OVR-BODY");
		const r = loadAuditorPrompt(
			settings({ auditorPromptMode: "override" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "global");
		assert.equal(r.prompt, "GLOBAL-OVR-BODY");
	});

	it("override + nothing → defaultPrompt, source 'default'", () => {
		const r = loadAuditorPrompt(
			settings({ auditorPromptMode: "override" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.source, "default");
		assert.equal(r.prompt, DEFAULT_PROMPT);
	});

	it("override produces same prompt body as global-local for auditor (equivalence)", () => {
		// Documents the design fact: because auditor never prepends default,
		// override and global-local yield identical `prompt` for the same
		// file setup. Only the source labeling / future persona-vs-fact
		// layering differs.
		sb.writeLegacyLocal("SHARED-BODY");
		const legacy = loadAuditorPrompt(
			settings({ auditorPromptMode: "global-local" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		const override = loadAuditorPrompt(
			settings({ auditorPromptMode: "override" }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(legacy.prompt, override.prompt);
		assert.equal(legacy.source, override.source);
	});
});

// ===========================================================================
// 3. DELEGATION OBSERVABILITY (RED today — drives GREEN)
// ===========================================================================
describe("loadAuditorPrompt — delegation to resolvePrompt('auditor', …)", () => {
	// After migration, loadAuditorPrompt MUST consult the unified prompts
	// directory (.pi/pi-goal-xx/prompts/auditor.md) — the observable signal
	// that resolvePrompt('auditor', ...) is being called. Today the legacy
	// resolver only reads .pi/auditor-prompt.md, so these tests FAIL.

	it("consults unified local path (<cwd>/.pi/pi-goal-xx/prompts/auditor.md)", () => {
		sb.writeUnifiedLocal("UNIFIED-LOCAL-BODY");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.prompt, "UNIFIED-LOCAL-BODY");
		assert.equal(r.source, "local");
	});

	it("consults unified global path (<home>/.pi/pi-goal-xx/prompts/auditor.md)", () => {
		sb.writeUnifiedGlobal("UNIFIED-GLOBAL-BODY");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.prompt, "UNIFIED-GLOBAL-BODY");
		assert.equal(r.source, "global");
	});

	it("unified local wins over unified global (global-local default)", () => {
		sb.writeUnifiedGlobal("UNI-GLOBAL");
		sb.writeUnifiedLocal("UNI-LOCAL");
		const r = loadAuditorPrompt({}, sb.cwd, DEFAULT_PROMPT, sb.home);
		assert.equal(r.prompt, "UNI-LOCAL");
		assert.equal(r.source, "local");
	});

	it("honors custom promptsDir override from settings", () => {
		const customDir = ".pi/my-auditor-prompts/";
		sb.writeCustomDirLocal(customDir, "CUSTOM-DIR-BODY");
		const r = loadAuditorPrompt(
			settings({ promptsDir: customDir }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.prompt, "CUSTOM-DIR-BODY");
		assert.equal(r.source, "local");
	});

	it("custom promptsDir does NOT fall back to default unified path", () => {
		// When promptsDir is overridden, files in the default unified dir
		// must be ignored — the override fully redirects resolution.
		const customDir = ".pi/my-auditor-prompts/";
		sb.writeCustomDirLocal(customDir, "CUSTOM-DIR-WINS");
		sb.writeUnifiedLocal("DEFAULT-DIR-MUST-BE-IGNORED");
		const r = loadAuditorPrompt(
			settings({ promptsDir: customDir }),
			sb.cwd,
			DEFAULT_PROMPT,
			sb.home,
		);
		assert.equal(r.prompt, "CUSTOM-DIR-WINS");
		assert.ok(!r.prompt.includes("DEFAULT-DIR-MUST-BE-IGNORED"));
	});
});

// Keep the type import used.
((): GoalSettings => ({}))();
