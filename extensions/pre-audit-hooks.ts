/**
 * Pre-audit hooks — standalone gate system (LD2, LD5, LD6, LD7, LD8).
 *
 * Runs user-configured scripts before the auditor session launches. The gate
 * is dynamic-opt-in (LD5): `preAuditHooks.enabled` MUST be true. When the gate
 * is disabled or unconfigured, it is a no-op pass. When enabled, global +
 * local scripts chain with AND semantics (LD7, OT11) — any single failure
 * fails the overall verdict.
 *
 * Gotcha coverage:
 *   - OT9:  timeout / not-found / crash → fail-closed
 *   - OT10: sanitize ANSI / null / non-UTF8 / secrets
 *   - OT11: AND chaining (global first, then local)
 *   - OT13: ReDoS protection via bounded regex evaluation (sync)
 *   - OT14: wrap injected output in <hook-output>...</hook-output>
 *
 * Spec: flow/findings/2026-07-31-auditor-capabilities-gaps/ (locked-decisions.yaml,
 * open-threads.yaml).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import * as cp from "node:child_process";
import type {
	GoalSettings,
	PreAuditHooksConfig,
	PreAuditHookPassCriteria,
} from "./goal-settings.ts";

// ───────────────────────── types ─────────────────────────

/** Result of evaluating a single hook script. */
export interface HookExecResult {
	/** "global" or "local". */
	name: string;
	/** Script path as configured (globalScript/localScript). */
	script: string;
	/** Per-hook pass/fail verdict (after criteria + negate). */
	passed: boolean;
	/** Human-readable reason for the verdict. */
	reason: string;
	/** Sanitized stdout+stderr of the hook. */
	output: string;
	/** Exit code (null if killed by signal / spawn error). */
	exitCode: number | null;
	/** True if the hook exceeded timeoutMs. */
	timedOut: boolean;
	/** True if the script file does not exist. */
	notFound: boolean;
}

/** Aggregate result of the pre-audit gate. */
export interface HookResult {
	/** Whether the gate was active (enabled === true). */
	enabled: boolean;
	/** Overall verdict: true = pass (auditor may proceed), false = gate failed. */
	passed: boolean;
	/** Human-readable overall reason. */
	reason: string;
	/** Sanitized + truncated combined output of all hooks (≤ maxOutputChars). */
	combinedOutput: string;
	/** `<hook-output>...</hook-output>` block when combinedOutput non-empty, else "". */
	injectedBlock: string;
	/** Per-hook details (global first, then local). */
	perHook: HookExecResult[];
}

export interface CriteriaVerdict {
	passed: boolean;
	reason: string;
}

// ───────────────────────── sanitization (OT10) ─────────────────────────

// Comprehensive ANSI escape sequence stripper (CSI + OSC + single-char).
// CSI: ESC [ ... letter. OSC: ESC ] BEL or ESC \ . Single: ESC ( B etc.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// Common secret patterns to redact.
//   - OpenAI-style API keys: sk-<hex>  (20+ chars after sk-)
//   - Generic sk-/key-/apikey- prefixes with token body
//   - Bearer tokens (OAuth/JWT): Bearer <token>
//   - xoxb-/xoxp- (Slack), ghp_/gho_ (GitHub), ya29. (Google)
const SECRET_RES: RegExp[] = [
	/sk-[0-9a-zA-Z_\-]{16,}/g,
	/Bearer\s+[0-9a-zA-Z_\-\.]+/gi,
	/xox[bp]-[0-9a-zA-Z\-]{10,}/g,
	/gh[pousr]_[0-9a-zA-Z]{16,}/g,
	/ya29\.[0-9a-zA-Z_\-]+/g,
	/key-[0-9a-zA-Z]{16,}/gi,
	/api[_-]?key[\s=:]+[0-9a-zA-Z_\-]{8,}/gi,
];

/**
 * Sanitize raw hook output for safe injection into the agent prompt.
 * Steps (in order): strip ANSI → strip null/control bytes → strip non-UTF8
 * replacement chars → strip BOM → redact secrets. Truncation happens LAST
 * (only when maxChars is provided) so the budget counts sanitized content.
 */
export function sanitizeHookOutput(raw: string, maxChars?: number): string {
	if (typeof raw !== "string") raw = String(raw ?? "");
	// 1. ANSI escape sequences
	let out = raw.replace(ANSI_RE, "");
	// 2. Null bytes
	out = out.replace(/\x00/g, "");
	// 3. Non-UTF8 replacement char (U+FFFD) + noncharacter U+FFFE/U+FFFF
	out = out.replace(/[\uFFFD\uFFFE\uFFFF]/g, "");
	// 4. UTF-16/UTF-8 BOM (U+FEFF)
	out = out.replace(/\uFEFF/g, "");
	// 5. Secret redaction
	for (const re of SECRET_RES) {
		out = out.replace(re, "[REDACTED]");
	}
	// 6. Truncate AFTER sanitization
	if (maxChars !== undefined && maxChars >= 0 && out.length > maxChars) {
		out = out.slice(0, maxChars);
	}
	return out;
}

// ───────────────────────── criteria evaluation (LD8, OT13) ─────────────────────────

/** Timeout for a single bounded regex test (ms). Caps ReDoS exposure. */
const REGEX_EVAL_TIMEOUT_MS = 800;

/**
 * Run a regex test with a synchronous hard timeout (OT13 ReDoS protection).
 * Uses node:vm.runInNewContext with { timeout } — the only synchronous way to
 * bound V8 regex backtracking. Returns false + timedOut flag on timeout so the
 * caller can fail-closed with a clear reason.
 */
function boundedRegexTest(pattern: string, input: string): { matched: boolean; timedOut: boolean } {
	const sandbox = { __input: input, __result: false };
	const code = `__result = (new RegExp(${JSON.stringify(pattern)})).test(__input);`;
	try {
		vm.runInNewContext(code, sandbox, { timeout: REGEX_EVAL_TIMEOUT_MS });
		return { matched: Boolean(sandbox.__result), timedOut: false };
	} catch (err: unknown) {
		const e = err as { code?: string; message?: string };
		if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(e.message ?? "")) {
			return { matched: false, timedOut: true };
		}
		// Invalid regex / other error → treat as no match (fail-closed at criteria layer).
		return { matched: false, timedOut: false };
	}
}

/** Select the stream text to test the regex against. */
function selectStreamText(stream: PreAuditHookPassCriteria["stream"], stdout: string, stderr: string): string {
	if (stream === "stdout") return stdout;
	if (stream === "stderr") return stderr;
	return stdout + stderr;
}

/**
 * Evaluate pass/fail for a single hook against its criteria.
 *
 * Status criterion: exitCode === criteria.status (null exitCode fails).
 * Regex criterion: tested against the selected stream ("" = skip).
 * Combinator: AND (both must pass) | OR (either passes). When regex is
 * skipped (""), the verdict is the status result alone.
 * Negate: inverts the final verdict.
 *
 * SYNCHRONOUS (callers do not await). ReDoS is bounded synchronously via vm.
 */
export function evaluateCriteria(args: {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	criteria: PreAuditHookPassCriteria;
}): CriteriaVerdict {
	const { exitCode, stdout, stderr, criteria } = args;

	const statusPass = exitCode !== null && exitCode === criteria.status;
	const regexSkipped = !criteria.regex;

	let passed: boolean;
	let reason: string;

	if (regexSkipped) {
		// Regex skipped → verdict is status only.
		passed = statusPass;
		reason = statusPass
			? `exit code ${exitCode} matches expected status ${criteria.status}`
			: `exit code ${exitCode} does not match expected status ${criteria.status}`;
	} else {
		const text = selectStreamText(criteria.stream, stdout, stderr);
		const { matched, timedOut } = boundedRegexTest(criteria.regex, text);
		if (timedOut) {
			return { passed: false, reason: "regex evaluation timed out (possible ReDoS)" };
		}
		if (criteria.combinator === "OR") {
			passed = statusPass || matched;
		} else {
			// AND (default)
			passed = statusPass && matched;
		}
		const parts: string[] = [];
		parts.push(statusPass ? `status ok (${exitCode})` : `status fail (${exitCode}≠${criteria.status})`);
		parts.push(matched ? `regex matched` : `regex not matched`);
		reason = parts.join(", ");
	}

	if (criteria.negate) {
		passed = !passed;
		reason = `negated → ${passed ? "pass" : "fail"} (${reason})`;
	}

	return { passed, reason };
}

// ───────────────────────── config validation ─────────────────────────

/**
 * Validate a PreAuditHooksConfig at config-load time. Catches typos that would
 * otherwise only surface at gate-evaluation time: invalid regex (compiles the
 * pattern), non-positive timeoutMs, invalid stream/combinator.
 */
export function validatePreAuditHooksConfig(cfg: PreAuditHooksConfig): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	if (cfg.timeoutMs !== undefined && !(Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0)) {
		errors.push(`timeoutMs must be a positive integer (got ${String(cfg.timeoutMs)})`);
	}
	if (cfg.maxOutputChars !== undefined && !(Number.isInteger(cfg.maxOutputChars) && cfg.maxOutputChars > 0)) {
		errors.push(`maxOutputChars must be a positive integer (got ${String(cfg.maxOutputChars)})`);
	}
	if (cfg.passCriteria) {
		const { stream, combinator, regex } = cfg.passCriteria;
		if (stream !== undefined && !VALID_STREAMS.has(stream)) {
			errors.push(`passCriteria.stream invalid: ${String(stream)}`);
		}
		if (combinator !== undefined && !VALID_COMBINATORS.has(combinator)) {
			errors.push(`passCriteria.combinator invalid: ${String(combinator)}`);
		}
		if (regex !== undefined && regex !== "") {
			try {
				new RegExp(regex);
			} catch (err: unknown) {
				errors.push(`passCriteria.regex invalid: ${(err as Error).message}`);
			}
		}
	}
	return { valid: errors.length === 0, errors };
}

const VALID_STREAMS = new Set(["stdout", "stderr", "both"]);
const VALID_COMBINATORS = new Set(["AND", "OR"]);

// ───────────────────────── execution ─────────────────────────

interface SpawnResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Spawn a hook script, capture stdout+stderr, enforce timeoutMs. */
function spawnHook(scriptPath: string, timeoutMs: number): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child = cp.spawn(scriptPath, [], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (result: SpawnResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				// Kill the entire process group (detached: true makes the child its own group leader).
				// Without this, only the direct child (e.g. env/bash) dies; grandchildren (sleep, etc.) survive.
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch { /* already dead */ }
			}
		}, timeoutMs);

		child.on("error", (err) => {
			stderr += `\nspawn error: ${err.message}`;
			finish({ exitCode: null, stdout, stderr, timedOut });
		});

		child.on("close", (code) => {
			finish({ exitCode: code, stdout, stderr, timedOut });
		});
	});
}

const DEFAULT_CRITERIA: PreAuditHookPassCriteria = {
	status: 0,
	regex: "",
	stream: "both",
	combinator: "AND",
	negate: false,
};

/**
 * Run all configured pre-audit hooks and return an aggregate verdict.
 *
 * Resolution: globalScript (absolute, as-is) runs first; localScript
 * (cwd-relative) runs second. AND semantics (OT11): any failure fails overall.
 * When disabled or unconfigured → no-op pass (gate inactive).
 */
export async function runPreAuditHooks(cwd: string, settings: GoalSettings): Promise<HookResult> {
	const cfg = settings.preAuditHooks;

	// LD5 dynamic opt-in: gate inactive unless enabled === true.
	if (!cfg || !cfg.enabled) {
		return {
			enabled: false,
			passed: true,
			reason: "disabled",
			combinedOutput: "",
			injectedBlock: "",
			perHook: [],
		};
	}

	// No scripts configured → silent skip (still a pass).
	if (!cfg.globalScript && !cfg.localScript) {
		return {
			enabled: true,
			passed: true,
			reason: "no hooks configured",
			combinedOutput: "",
			injectedBlock: "",
			perHook: [],
		};
	}

	const criteria = cfg.passCriteria ?? DEFAULT_CRITERIA;
	const scripts: { name: "global" | "local"; script: string; resolve: (s: string) => string }[] = [];
	if (cfg.globalScript) {
		scripts.push({ name: "global", script: cfg.globalScript, resolve: (s) => s });
	}
	if (cfg.localScript) {
		scripts.push({ name: "local", script: cfg.localScript, resolve: (s) => path.resolve(cwd, s) });
	}

	const perHook: HookExecResult[] = [];

	for (const { name, script, resolve } of scripts) {
		const resolvedPath = resolve(script);

		// OT9: not-found → fail-closed.
		if (!fs.existsSync(resolvedPath)) {
			perHook.push({
				name,
				script,
				passed: false,
				reason: "script not found",
				output: "",
				exitCode: null,
				timedOut: false,
				notFound: true,
			});
			continue;
		}

		const { exitCode, stdout, stderr, timedOut } = await spawnHook(resolvedPath, cfg.timeoutMs);

		// OT9: timeout → fail-closed.
		if (timedOut) {
			perHook.push({
				name,
				script,
				passed: false,
				reason: `script timeout (>${cfg.timeoutMs}ms)`,
				output: sanitizeHookOutput(stdout + stderr),
				exitCode: null,
				timedOut: true,
				notFound: false,
			});
			continue;
		}

		const verdict = evaluateCriteria({ exitCode, stdout, stderr, criteria });
		perHook.push({
			name,
			script,
			passed: verdict.passed,
			reason: verdict.reason,
			output: sanitizeHookOutput(stdout + stderr),
			exitCode,
			timedOut: false,
			notFound: false,
		});
	}

	// OT11: AND semantics — all hooks must pass.
	const allPassed = perHook.every((h) => h.passed);

	// combinedOutput: concatenate sanitized per-hook outputs (global then local),
	// truncate AFTER sanitization to maxOutputChars.
	const nonEmptyOutputs = perHook.map((h) => h.output).filter((o) => o.length > 0);
	const rawCombined = nonEmptyOutputs.join("\n");
	const combinedOutput = rawCombined.length > cfg.maxOutputChars
		? rawCombined.slice(0, cfg.maxOutputChars)
		: rawCombined;

	const injectedBlock = combinedOutput.length > 0
		? `<hook-output>\n${combinedOutput}\n</hook-output>`
		: "";

	return {
		enabled: true,
		passed: allPassed,
		reason: allPassed
			? "all hooks passed"
			: `hook gate failed: ${perHook.filter((h) => !h.passed).map((h) => h.name).join(", ")}`,
		combinedOutput,
		injectedBlock,
		perHook,
	};
}
