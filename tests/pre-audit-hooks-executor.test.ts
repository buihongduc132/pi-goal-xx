/**
 * RED phase — Pre-audit hooks executor (LD2, LD5, LD6, LD7, LD8) + gotchas
 * OT9 (timeout/not-found/crash), OT10 (sanitization), OT11 (chaining AND),
 * OT13 (ReDoS), OT14 (output markers).
 *
 * These tests FAIL because `extensions/pre-audit-hooks.ts` does not exist yet.
 * The imports below reference symbols the GREEN phase must implement:
 *   - runPreAuditHooks(cwd, settings): Promise<HookResult>
 *   - sanitizeHookOutput(raw, maxChars?): string
 *   - evaluateCriteria({exitCode, stdout, stderr, criteria}): {passed, reason}
 *   - validatePreAuditHooksConfig(cfg): {valid, errors}
 *
 * Spec:
 *   - locked-decisions.yaml LD6 (inject ≤5k), LD7 (global+local chaining),
 *     LD8 (schema, defaults).
 *   - open-threads.yaml OT9/OT10/OT11/OT13/OT14.
 *
 * Tests use REAL subprocess scripts (temp .sh files) where the behaviour is
 * execution-bound, and pure unit calls for criteria/sanitization logic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runPreAuditHooks,
	sanitizeHookOutput,
	evaluateCriteria,
	validatePreAuditHooksConfig,
	type HookResult,
	type HookExecResult,
} from "../extensions/pre-audit-hooks.ts";
import type { GoalSettings, PreAuditHooksConfig, PreAuditHookPassCriteria } from "../extensions/goal-settings.ts";

// ───────────────────────── helpers ─────────────────────────

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-preexec-"));
	return dir;
}

/** Write an executable bash script. Returns its absolute path. */
function writeHookScript(dir: string, name: string, body: string, opts: { executable?: boolean } = {}): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
	fs.chmodSync(p, opts.executable === false ? 0o644 : 0o755);
	return p;
}

function settingsWith(globalScript: string, over: Partial<PreAuditHooksConfig> = {}): GoalSettings {
	return {
		preAuditHooks: {
			enabled: true,
			globalScript,
			maxOutputChars: 5000,
			timeoutMs: 30000,
			injectOutput: true,
			...over,
		} as PreAuditHooksConfig,
	} as GoalSettings;
}

function crit(over: Partial<PreAuditHookPassCriteria> = {}): PreAuditHookPassCriteria {
	return {
		status: 0,
		regex: "",
		stream: "both",
		combinator: "AND",
		negate: false,
		...over,
	};
}

// ───────────────────────── evaluateCriteria (pure) ─────────────────────────

describe("evaluateCriteria — status criterion (LD8)", () => {
	it("exit 0 + no regex → PASS", () => {
		const r = evaluateCriteria({ exitCode: 0, stdout: "", stderr: "", criteria: crit() });
		assert.equal(r.passed, true);
	});

	it("non-zero exit + no regex → FAIL", () => {
		const r = evaluateCriteria({ exitCode: 1, stdout: "", stderr: "", criteria: crit() });
		assert.equal(r.passed, false);
		assert.ok(r.reason.length > 0, "FAIL must carry a reason");
	});

	it("configurable status code (exit 2 = pass when status:2)", () => {
		const r = evaluateCriteria({ exitCode: 2, stdout: "", stderr: "", criteria: crit({ status: 2 }) });
		assert.equal(r.passed, true);
	});
});

describe("evaluateCriteria — regex criterion + combinator (LD8)", () => {
	it("stdout 'PASS' + regex 'PASS' + AND + status 0 → PASS", () => {
		const r = evaluateCriteria({
			exitCode: 0,
			stdout: "BUILD PASS",
			stderr: "",
			criteria: crit({ regex: "PASS" }),
		});
		assert.equal(r.passed, true);
	});

	it("stdout 'PASS' + regex 'FAIL' + AND → FAIL (regex miss)", () => {
		const r = evaluateCriteria({
			exitCode: 0,
			stdout: "BUILD PASS",
			stderr: "",
			criteria: crit({ regex: "FAIL" }),
		});
		assert.equal(r.passed, false);
	});

	it("stdout 'PASS' + regex 'FAIL' + OR + status 0 → PASS (OR)", () => {
		const r = evaluateCriteria({
			exitCode: 0,
			stdout: "BUILD PASS",
			stderr: "",
			criteria: crit({ regex: "FAIL", combinator: "OR" }),
		});
		assert.equal(r.passed, true);
	});

	it("non-zero exit + regex matches + AND → FAIL (status fails)", () => {
		const r = evaluateCriteria({
			exitCode: 1,
			stdout: "PASS",
			stderr: "",
			criteria: crit({ regex: "PASS", combinator: "AND" }),
		});
		assert.equal(r.passed, false);
	});

	it("non-zero exit + regex matches + OR → PASS (regex rescues)", () => {
		const r = evaluateCriteria({
			exitCode: 1,
			stdout: "PASS",
			stderr: "",
			criteria: crit({ regex: "PASS", combinator: "OR" }),
		});
		assert.equal(r.passed, true);
	});

	it("empty regex (skip) → result determined by status only", () => {
		// regex "" = skip → criterion does not contribute.
		assert.equal(
			evaluateCriteria({ exitCode: 0, stdout: "anything", stderr: "", criteria: crit({ regex: "" }) }).passed,
			true,
		);
		assert.equal(
			evaluateCriteria({ exitCode: 5, stdout: "anything", stderr: "", criteria: crit({ regex: "" }) }).passed,
			false,
		);
	});
});

describe("evaluateCriteria — negate (LD8)", () => {
	it("negate:true inverts a PASS into FAIL", () => {
		const r = evaluateCriteria({ exitCode: 0, stdout: "", stderr: "", criteria: crit({ negate: true }) });
		assert.equal(r.passed, false);
	});

	it("negate:true inverts a FAIL into PASS", () => {
		const r = evaluateCriteria({ exitCode: 1, stdout: "", stderr: "", criteria: crit({ negate: true }) });
		assert.equal(r.passed, true);
	});
});

describe("evaluateCriteria — stream selection (LD8)", () => {
	it("stream:'stdout' only tests stdout", () => {
		// regex on stdout miss, stdout has 'OK', stderr has 'PASS'
		assert.equal(
			evaluateCriteria({
				exitCode: 0,
				stdout: "OK",
				stderr: "PASS",
				criteria: crit({ regex: "PASS", stream: "stdout", combinator: "AND" }),
			}).passed,
			false,
			"stdout-only must NOT match stderr content",
		);
		assert.equal(
			evaluateCriteria({
				exitCode: 0,
				stdout: "PASS",
				stderr: "OK",
				criteria: crit({ regex: "PASS", stream: "stdout", combinator: "AND" }),
			}).passed,
			true,
		);
	});

	it("stream:'stderr' only tests stderr", () => {
		assert.equal(
			evaluateCriteria({
				exitCode: 0,
				stdout: "PASS",
				stderr: "OK",
				criteria: crit({ regex: "PASS", stream: "stderr", combinator: "AND" }),
			}).passed,
			false,
			"stderr-only must NOT match stdout content",
		);
		assert.equal(
			evaluateCriteria({
				exitCode: 0,
				stdout: "OK",
				stderr: "PASS",
				criteria: crit({ regex: "PASS", stream: "stderr", combinator: "AND" }),
			}).passed,
			true,
		);
	});

	it("stream:'both' tests the concatenation of stdout+stderr", () => {
		// marker present only across both streams
		const r = evaluateCriteria({
			exitCode: 0,
			stdout: "AAA",
			stderr: "BBB-PASS",
			criteria: crit({ regex: "PASS", stream: "both", combinator: "AND" }),
		});
		assert.equal(r.passed, true);
	});
});

// ───────────────────────── sanitizeHookOutput (pure) ─────────────────────────

describe("sanitizeHookOutput — OT10 sanitization", () => {
	it("strips ANSI escape codes", () => {
		const raw = "\x1b[31mRED\x1b[0m and \x1b[1;32mgreen\x1b[0m";
		const out = sanitizeHookOutput(raw);
		assert.equal(out, "RED and green");
		assert.doesNotMatch(out, /\x1b/);
	});

	it("strips null bytes", () => {
		const raw = "A\x00B\x00C";
		const out = sanitizeHookOutput(raw);
		assert.equal(out, "ABC");
		assert.ok(!out.includes("\x00"));
	});

	it("strips/replaces non-UTF8 byte sequences (no U+FFFD survives)", () => {
		// \xff \xfe are invalid UTF-8 lead bytes; Node decodes them to U+FFFD.
		// sanitize must remove the replacement char (or the raw bytes).
		const raw = "BEFORE\uFFFD\uFFFEAFTER";
		const out = sanitizeHookOutput(raw);
		assert.ok(!out.includes("\uFFFD"), "U+FFFD must be stripped");
		assert.ok(!out.includes("\uFFFE"), "U+FFFE must be stripped");
		assert.ok(out.includes("BEFORE"));
		assert.ok(out.includes("AFTER"));
	});

	it("strips UTF-16 BOM", () => {
		const out = sanitizeHookOutput("\uFEFFhello");
		assert.equal(out, "hello");
	});

	it("redacts common secret patterns (API keys / bearer tokens)", () => {
		const raw = "token: sk-1234567890abcdef1234567890abcdef and Authorization: Bearer ya29.ABCDEFghi";
		const out = sanitizeHookOutput(raw);
		assert.ok(!out.includes("sk-1234567890abcdef1234567890abcdef"), "api-key must be redacted");
		assert.ok(!/Bearer\s+ya29\.\S+/i.test(out), "bearer token must be redacted");
		assert.match(out, /REDACTED|\[redacted\]/i, "redaction marker expected");
	});

	it("truncates to maxChars AFTER sanitization, not before", () => {
		// raw has 20 content chars wrapped in ANSI; sanitize removes ANSI → 20 chars.
		// truncate-then-sanitize would yield only a few chars (ANSI ate the budget).
		// sanitize-then-truncate yields the first 10 content chars.
		const content = "X".repeat(20);
		const raw = `\x1b[31m${content}\x1b[0m`;
		const out = sanitizeHookOutput(raw, 10);
		assert.equal(out, "X".repeat(10), "must sanitize THEN truncate (10 content chars survive)");
	});

	it("no maxChars → sanitize only, no truncation", () => {
		const long = "A".repeat(100);
		const out = sanitizeHookOutput(`\x1b[31m${long}\x1b[0m`);
		assert.equal(out, long, "full sanitized content preserved");
	});
});

// ───────────────────────── runPreAuditHooks — execution (OT9) ─────────────────────────

describe("runPreAuditHooks — exit-code execution (no regex)", () => {
	it("hook exits 0 → PASS", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "ok.sh", "echo done");
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.equal(r.passed, true);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("hook exits non-zero → FAIL with exit code recorded", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "fail.sh", "echo oops; exit 3");
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.equal(r.passed, false);
			assert.ok(r.perHook.some((h: HookExecResult) => h.exitCode === 3), "exit code 3 recorded");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("runPreAuditHooks — OT9 hook failure modes", () => {
	it("hanging hook times out → FAIL with timedOut flag (does not block 30s)", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "hang.sh", "sleep 30");
			const start = Date.now();
			const r = await runPreAuditHooks(
				cwd,
				settingsWith(script, { timeoutMs: 200 }),
			);
			const elapsed = Date.now() - start;
			assert.equal(r.passed, false);
			assert.ok(r.perHook.some((h: HookExecResult) => h.timedOut), "timedOut flag set on the hook");
			assert.ok(elapsed < 5000, `must return well under the 30s sleep (got ${elapsed}ms)`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("hook script not found → FAIL with notFound flag", async () => {
		const cwd = tmpCwd();
		try {
			const r = await runPreAuditHooks(cwd, settingsWith(path.join(cwd, "does-not-exist.sh")));
			assert.equal(r.passed, false);
			assert.ok(r.perHook.some((h: HookExecResult) => h.notFound), "notFound flag set");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("hook crashes (signal kill) → FAIL", async () => {
		const cwd = tmpCwd();
		try {
			// kill self with SIGKILL → non-zero / signal exit
			const script = writeHookScript(cwd, "crash.sh", "kill -9 $$");
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.equal(r.passed, false);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("runPreAuditHooks — OT10 output sanitization end-to-end", () => {
	it("globalScript combined output is sanitized (ANSI/null stripped, secrets redacted)", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(
				cwd,
				"dirty.sh",
				`printf '\\x1b[31mRED\\x1b[0m A\\x00B sk-1234567890abcdef1234567890abcdef'`,
			);
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.ok(!r.combinedOutput.includes("\x1b"), "ANSI stripped from combined output");
			assert.ok(!r.combinedOutput.includes("\x00"), "null stripped from combined output");
			assert.ok(
				!r.combinedOutput.includes("sk-1234567890abcdef1234567890abcdef"),
				"secret redacted from combined output",
			);
			assert.match(r.combinedOutput, /REDACTED|\[redacted\]/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("combined output truncated to maxOutputChars AFTER sanitization", async () => {
		const cwd = tmpCwd();
		try {
			// 200 content chars wrapped in ANSI; maxOutputChars 50.
			// sanitize-then-truncate → exactly 50 content chars (no ANSI).
			const script = writeHookScript(
				cwd,
				"big.sh",
				`printf '\\x1b[31m'${"X".repeat(200)}` + `\nprintf '\\x1b[0m'\n`,
			);
			const r = await runPreAuditHooks(cwd, settingsWith(script, { maxOutputChars: 50 }));
			assert.ok(
				r.combinedOutput.length <= 50,
				`combined output must be ≤ maxOutputChars (got ${r.combinedOutput.length})`,
			);
			assert.ok(!r.combinedOutput.includes("\x1b"), "no ANSI in truncated output");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ───────────────────────── runPreAuditHooks — chaining (LD7, OT11) ─────────────────────────

describe("runPreAuditHooks — global + local chaining (LD7, OT11 AND semantics)", () => {
	it("both global and local pass → overall PASS", async () => {
		const cwd = tmpCwd();
		try {
			const globalScript = writeHookScript(cwd, "g.sh", "echo global-ok");
			const localScript = writeHookScript(cwd, "l.sh", "echo local-ok");
			const r = await runPreAuditHooks(cwd, {
				preAuditHooks: {
					enabled: true,
					globalScript,
					localScript,
					maxOutputChars: 5000,
					timeoutMs: 30000,
					injectOutput: true,
				} as PreAuditHooksConfig,
			} as GoalSettings);
			assert.equal(r.passed, true);
			assert.equal(r.perHook.length, 2, "both hooks evaluated");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("global passes, local fails → overall FAIL (AND)", async () => {
		const cwd = tmpCwd();
		try {
			const globalScript = writeHookScript(cwd, "g.sh", "echo ok");
			const localScript = writeHookScript(cwd, "l.sh", "exit 1");
			const r = await runPreAuditHooks(cwd, {
				preAuditHooks: {
					enabled: true,
					globalScript,
					localScript,
					maxOutputChars: 5000,
					timeoutMs: 30000,
					injectOutput: true,
				} as PreAuditHooksConfig,
			} as GoalSettings);
			assert.equal(r.passed, false, "AND semantics: local failure fails overall");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("global fails, local passes → overall FAIL (AND)", async () => {
		const cwd = tmpCwd();
		try {
			const globalScript = writeHookScript(cwd, "g.sh", "exit 2");
			const localScript = writeHookScript(cwd, "l.sh", "echo ok");
			const r = await runPreAuditHooks(cwd, {
				preAuditHooks: {
					enabled: true,
					globalScript,
					localScript,
					maxOutputChars: 5000,
					timeoutMs: 30000,
					injectOutput: true,
				} as PreAuditHooksConfig,
			} as GoalSettings);
			assert.equal(r.passed, false, "AND semantics: global failure fails overall");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("each hook evaluates its own criteria independently; negate applies per-hook", async () => {
		// negate:true inverts PER-HOOK result. With global exit-0 (→negate→FAIL)
		// and local exit-1 (→negate→PASS), overall AND = FAIL∩PASS = FAIL.
		const cwd = tmpCwd();
		try {
			const globalScript = writeHookScript(cwd, "g.sh", "exit 0");
			const localScript = writeHookScript(cwd, "l.sh", "exit 1");
			const r = await runPreAuditHooks(cwd, {
				preAuditHooks: {
					enabled: true,
					globalScript,
					localScript,
					passCriteria: crit({ negate: true }),
					maxOutputChars: 5000,
					timeoutMs: 30000,
					injectOutput: true,
				} as PreAuditHooksConfig,
			} as GoalSettings);
			assert.equal(r.perHook.length, 2);
			// global: exit0 negated → fail ; local: exit1 negated → pass
			const globalH = r.perHook.find((h: HookExecResult) => h.name === "global");
			const localH = r.perHook.find((h: HookExecResult) => h.name === "local");
			assert.ok(globalH && localH, "both hooks recorded with names");
			assert.equal(globalH.passed, false, "global exit0 + negate → fail");
			assert.equal(localH.passed, true, "local exit1 + negate → pass");
			assert.equal(r.passed, false, "AND of per-hook results");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ───────────────────────── runPreAuditHooks — OT14 injection markers ─────────────────────────

describe("runPreAuditHooks — OT14 injected output wrapped in <hook-output> markers", () => {
	it("injectedBlock wraps combined output in <hook-output>...</hook-output>", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "emit.sh", "echo RESULT-LINE");
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.match(r.injectedBlock, /<hook-output>[\s\S]*RESULT-LINE[\s\S]*<\/hook-output>/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("injectedBlock is empty when the hook produced no output", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "silent.sh", "exit 0");
			const r = await runPreAuditHooks(cwd, settingsWith(script));
			assert.equal(r.injectedBlock, "", "no output → nothing to inject");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ───────────────────────── runPreAuditHooks — LD5 dynamic opt-in ─────────────────────────

describe("runPreAuditHooks — LD5 enabled gate (dynamic opt-in)", () => {
	it("disabled (enabled:false) → no-op pass, no hooks evaluated", async () => {
		const cwd = tmpCwd();
		try {
			const script = writeHookScript(cwd, "never.sh", "echo should-not-run; exit 0");
			const r = await runPreAuditHooks(cwd, {
				preAuditHooks: { enabled: false, globalScript: script } as PreAuditHooksConfig,
			} as GoalSettings);
			assert.equal(r.enabled, false);
			assert.equal(r.passed, true, "disabled gate is a no-op pass");
			assert.equal(r.perHook.length, 0, "no hooks evaluated when disabled");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("no preAuditHooks config at all → no-op pass", async () => {
		const cwd = tmpCwd();
		const r = await runPreAuditHooks(cwd, {} as GoalSettings);
		assert.equal(r.passed, true);
		assert.equal(r.perHook.length, 0);
	});

	it("enabled but neither script configured → no hooks run (silent skip)", async () => {
		const cwd = tmpCwd();
		const r = await runPreAuditHooks(cwd, {
			preAuditHooks: { enabled: true } as PreAuditHooksConfig,
		} as GoalSettings);
		assert.equal(r.passed, true, "no scripts → silent skip → pass");
		assert.equal(r.perHook.length, 0);
	});
});

// ───────────────────────── OT13 ReDoS protection ─────────────────────────

describe("evaluateCriteria — OT13 ReDoS protection", () => {
	it("catastrophic regex on crafted input returns within 1s (no hang)", async () => {
		// (a+)+$ against a long run of 'a' followed by a non-matching char is
		// the textbook exponential-backtracking case. A naive RegExp.test would
		// take seconds-to-minutes. The implementation MUST bound evaluation
		// (timeout / backtrack limit) and return a safe result quickly.
		const evil = "a".repeat(25) + "b"; // 2^25-ish backtracks on naive engines
		const start = Date.now();
		const r = evaluateCriteria({
			exitCode: 0,
			stdout: evil,
			stderr: "",
			criteria: crit({ regex: "(a+)+$", stream: "stdout", combinator: "AND" }),
		});
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000, `regex eval must be bounded < 1s (got ${elapsed}ms)`);
		assert.equal(typeof r.passed, "boolean", "must return a real verdict (fail-closed ok)");
	});
});

// ───────────────────────── validatePreAuditHooksConfig ─────────────────────────

describe("validatePreAuditHooksConfig — config validation", () => {
	it("accepts a valid enabled config with at least one script", () => {
		const v = validatePreAuditHooksConfig({
			enabled: true,
			globalScript: "/g.sh",
			maxOutputChars: 5000,
			timeoutMs: 30000,
			injectOutput: true,
		} as PreAuditHooksConfig);
		assert.equal(v.valid, true);
	});

	it("flags timeoutMs <= 0 as invalid", () => {
		const v = validatePreAuditHooksConfig({
			enabled: true,
			globalScript: "/g.sh",
			timeoutMs: 0,
		} as PreAuditHooksConfig);
		assert.equal(v.valid, false);
		assert.ok(v.errors.length > 0);
	});

	it("flags invalid regex at config-load time (compiles the pattern)", () => {
		const v = validatePreAuditHooksConfig({
			enabled: true,
			globalScript: "/g.sh",
			passCriteria: crit({ regex: "(unclosed[" }),
		} as PreAuditHooksConfig);
		assert.equal(v.valid, false);
		assert.ok(v.errors.some((e: string) => /regex/i.test(e)), "error mentions regex");
	});
});

// ───────────────────────── HookResult / HookExecResult types compile ─────────────────────────

describe("HookResult / HookExecResult — type contract", () => {
	it("HookResult exposes the fields GREEN must implement", () => {
		// Compile-time contract for the return shape of runPreAuditHooks.
		const r: HookResult = {
			enabled: true,
			passed: true,
			reason: "ok",
			combinedOutput: "out",
			injectedBlock: "<hook-output>out</hook-output>",
			perHook: [],
		};
		assert.equal(r.passed, true);

		const h: HookExecResult = {
			name: "global",
			script: "/g.sh",
			passed: true,
			reason: "exit 0",
			output: "out",
			exitCode: 0,
			timedOut: false,
			notFound: false,
		};
		assert.equal(h.name, "global");
	});
});
