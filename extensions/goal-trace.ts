/**
 * Unified operational trace logger for pi-goal-xx — JSONL append-only log under
 * `<cwd>/.pi/goals/`.
 *
 * Purpose: capture a forensic trail for EVERY step of the goal lifecycle so the
 * recurring crashes/exits/silent-failures leave evidence. This sits alongside
 * (not replacing) the two existing sinks:
 *
 *   - `goal_events.jsonl` (goal-ledger.ts)  — event-sourced, MUST NOT rotate,
 *     replayed to reconstruct goal state. Lifecycle milestones only.
 *   - `auditor-trace.jsonl` (auditor-log.ts) — rotating forensic trace, but
 *     scoped to the `complete_goal` audit run only.
 *   - `goal-trace.jsonl` (THIS FILE)         — rotating operational trace
 *     covering tool/command spans, focus-lock ops, auto-run, heartbeat,
 *     syncGoalTools, hook dispatch, reconciliation drift, and lock-loss.
 *
 * Invariants (same as auditor-log.ts — these are why logging never becomes a
 * new crash vector; see flow/lesson_learn/2):
 *   - NEVER throws. File write failures are swallowed silently. Every public
 *     entry point wraps its body in `try { ... } catch {}`.
 *   - Non-blocking on the hot path: writes are sync + small (<2KB/line).
 *   - Truncates large fields (error strings, args previews) to bound size.
 *   - One JSONL file per cwd: `<cwd>/.pi/goals/goal-trace.jsonl`.
 *   - Rotation caps growth at 10MB × 3 archives via the shared `rotateIfNeeded`
 *     (the same helper auditor-log.ts uses).
 *
 * Level filtering: the effective level is resolved from settings
 * (GoalLoggingConfig) at write time. `off` writes nothing. Higher levels
 * include lower ones: error ⊂ warn ⊂ info ⊂ debug. When the trace entry's
 * level is below the configured floor, the write is skipped entirely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { rotateIfNeeded } from "./storage/rotating-log.ts";

const LOG_FILE_NAME = "goal-trace.jsonl";
const ERROR_PREVIEW_BYTES = 4_000;
const MESSAGE_PREVIEW_BYTES = 2_000;

/** Severity, ordered. `off` is handled at the settings layer (no floor). */
export type GoalTraceLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<GoalTraceLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

/**
 * One structured trace entry. `ts` and `level` and `step` are always present;
 * the rest are free-form but must be JSON-serialisable (truncate big strings
 * with `previewBytes` before passing them in).
 */
export interface GoalTraceEntry {
	/** Monotonic ISO timestamp; defaults to now() at write time. */
	ts?: string;
	/** Severity. */
	level: GoalTraceLevel;
	/** Stable step identifier, e.g. "tool.complete_goal", "lock.release". */
	step: string;
	/** Goal id when the step is scoped to a goal. */
	goalId?: string;
	/** Short human-readable summary (truncated at MESSAGE_PREVIEW_BYTES). */
	message?: string;
	/** Error message when the step failed (truncated at ERROR_PREVIEW_BYTES). */
	error?: string;
	/** Elapsed milliseconds for a span (set by `traceStep`). */
	durationMs?: number;
	/** Span phase: "start" | "end" | "error" | "event". Defaults to "event". */
	phase?: "start" | "end" | "error" | "event";
	/** Any additional serialisable context. */
	[k: string]: unknown;
}

/**
 * Resolved logging configuration consumed at write time. `levelFloor` of
 * `Number.POSITIVE_INFINITY` disables all writes (the `off` setting). The
 * default (`info`) is resolved here so callers do not need settings access.
 */
export interface GoalTraceSinkConfig {
	/** Minimum level rank to emit; POSITIVE_INFINITY disables writes. */
	levelFloor: number;
	/** Mirror every emitted line to stderr (live debugging). */
	toStderr: boolean;
}

/** The "everything disabled" sink config — used when settings.logging.level is "off". */
export const TRACE_SINK_OFF: GoalTraceSinkConfig = {
	levelFloor: Number.POSITIVE_INFINITY,
	toStderr: false,
};

/** The built-in default sink config (level: info, stderr: off). */
export const TRACE_SINK_DEFAULT: GoalTraceSinkConfig = {
	levelFloor: LEVEL_RANK.info,
	toStderr: false,
};

function logPath(cwd: string): string {
	return path.join(cwd, ".pi", "goals", LOG_FILE_NAME);
}

function ensureLogDir(cwd: string): void {
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	} catch {
		// best-effort; write will fail later and be swallowed
	}
}

/** Truncate a string to N bytes with a `…(+<n> bytes)` suffix marker. Mirrors auditor-log.previewBytes. */
export function previewBytes(value: string, max: number): string {
	if (value.length <= max) return value;
	const truncated = value.slice(0, max);
	return `${truncated}…(+${value.length - max} bytes)`;
}

/**
 * Resolve the effective sink config from a settings.logging block. Unknown or
 * missing input yields the default (info). Never throws — bad values fall back
 * to defaults so a malformed settings file cannot disable crash tracing.
 */
export function resolveTraceSink(
	logging?: { level?: string; toStderr?: boolean } | null,
): GoalTraceSinkConfig {
	if (!logging) return TRACE_SINK_DEFAULT;
	const level = typeof logging.level === "string" ? logging.level.toLowerCase() : "info";
	if (level === "off") return TRACE_SINK_OFF;
	const rank = LEVEL_RANK[level as GoalTraceLevel];
	if (rank === undefined) return TRACE_SINK_DEFAULT;
	return {
		levelFloor: rank,
		toStderr: logging.toStderr === true,
	};
}

/**
 * True if `entry` should be emitted under `sink`.
 *
 * Span skeleton phases (start/end/error) ALWAYS emit — they are the structural
 * trace, not noise; dropping a span boundary on a level floor would defeat the
 * purpose of step tracing. Only free-form `event` entries (and any non-span
 * level-bearing entry) are subject to level filtering. The `off` sink still
 * suppresses everything.
 */
function passesFloor(entry: GoalTraceEntry, sink: GoalTraceSinkConfig): boolean {
	if (sink.levelFloor === Number.POSITIVE_INFINITY) return false; // "off"
	const phase = entry.phase ?? "event";
	if (phase === "start" || phase === "end" || phase === "error") return true;
	return LEVEL_RANK[entry.level] >= sink.levelFloor;
}

/**
 * Append one structured entry to the goal trace log. Never throws.
 *
 * Pass an explicit `sink` (resolved from settings by the caller) to apply level
 * filtering; omit it to use the default (info) floor — used by the lock/hooks
 * layers that do not have settings in scope, where dropping a warn is wrong.
 */
export function logGoalTrace(cwd: string, entry: GoalTraceEntry, sink?: GoalTraceSinkConfig): void {
	const effective = sink ?? TRACE_SINK_DEFAULT;
	if (!passesFloor(entry, effective)) return;
	try {
		ensureLogDir(cwd);
		const target = logPath(cwd);
		const line = JSON.stringify({
			...entry,
			ts: entry.ts ?? new Date().toISOString(),
			phase: entry.phase ?? "event",
		}) + "\n";
		// Cap the trace log at 10MB and keep 3 rotations before appending.
		// Pass the incoming line length so rotation accounts for it.
		rotateIfNeeded(target, undefined, undefined, Buffer.byteLength(line, "utf8"));
		fs.appendFileSync(target, line, { encoding: "utf8" });
		if (effective.toStderr) {
			// Mirror to stderr for live debugging. Swallow any write error.
			try { process.stderr.write(line); } catch {}
		}
	} catch {
		// Logging is best-effort. Never let it crash the operation it traces.
	}
}

/**
 * Build a start entry for a span. Centralises the shape so callers stay DRY.
 */
export function buildStartEntry(step: string, goalId?: string, extra?: Record<string, unknown>): GoalTraceEntry {
	return {
		ts: new Date().toISOString(),
		level: "debug",
		phase: "start",
		step,
		goalId,
		...extra,
	};
}

/**
 * Wrap an operation (sync or async) in a start/end/error trace span. The
 * wrapped function's return value / thrown error is passed through unchanged —
 * tracing must never alter control flow. If the function rejects/throws, an
 * `error` entry is written and the error re-rethrown.
 *
 * Any trace-write failure is swallowed internally, so a broken trace file can
 * never cause the wrapped operation to fail.
 */
export function traceStep<T>(
	step: string,
	cwd: string,
	fn: () => T | Promise<T>,
	options?: { goalId?: string; sink?: GoalTraceSinkConfig; getSink?: () => GoalTraceSinkConfig; extra?: Record<string, unknown> },
): T | Promise<T> {
	const goalId = options?.goalId;
	const getSink = options?.getSink ?? (() => options?.sink ?? TRACE_SINK_DEFAULT);
	const extra = options?.extra;
	const startedAt = Date.now();
	logGoalTrace(cwd, buildStartEntry(step, goalId, extra), getSink());
	// Sync vs async detection: a thrown error from a sync fn is caught here; a
	// rejected promise is handled in the .then/.catch chain.
	let isPromise = false;
	try {
		const maybePromise = fn();
		if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
			isPromise = true;
			return (maybePromise as Promise<T>)
				.then((result) => {
					logGoalTrace(cwd, {
						ts: new Date().toISOString(),
						level: "debug",
						phase: "end",
						step,
						goalId,
						durationMs: Date.now() - startedAt,
					}, getSink());
					return result;
				})
				.catch((err: unknown) => {
					logGoalTrace(cwd, {
						ts: new Date().toISOString(),
						level: "error",
						phase: "error",
						step,
						goalId,
						error: previewError(err),
						durationMs: Date.now() - startedAt,
					}, getSink());
					throw err;
				});
		}
		// Sync success.
		logGoalTrace(cwd, {
			ts: new Date().toISOString(),
			level: "debug",
			phase: "end",
			step,
			goalId,
			durationMs: Date.now() - startedAt,
		}, getSink());
		return maybePromise;
	} catch (err) {
		if (isPromise) throw err; // already handled above; unreachable
		logGoalTrace(cwd, {
			ts: new Date().toISOString(),
			level: "error",
			phase: "error",
			step,
			goalId,
			error: previewError(err),
			durationMs: Date.now() - startedAt,
		}, getSink());
		throw err;
	}
}

/** Reduce any thrown value to a bounded string for trace records. Never throws. */
export function previewError(err: unknown): string {
	try {
		const msg = err instanceof Error
			? (err.stack || err.message)
			: (typeof err === "string" ? err : safeStringify(err));
		return previewBytes(msg, ERROR_PREVIEW_BYTES);
	} catch {
		return "<unserializable error>";
	}
}

function safeStringify(value: unknown): string {
	try {
		// JSON.stringify(undefined|function|symbol) returns undefined (not a string);
		// coalesce to String() so the declared `string` return type always holds.
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Wrap a tool/command `execute`/`handler` function in a trace span. Returns a
 * new function with identical behaviour; the only side effect is that a
 * start/end/error entry is written to goal-trace.jsonl for `step`.
 *
 * The wrapped function's `ctx` argument is inspected (as the 5th positional
 * param for tools, or a property on the args) to recover `cwd`; if not found,
 * `fallbackCwd` is used. `getSink()` (preferred — read at call time so a
 * refreshed cached sink is honoured) or `sink` (snapshot) gates the write.
 * Exported so registration chokepoints outside goal.ts (e.g.
 * goal-questionnaire.ts) can reuse it.
 */
export function wrapExecuteWithTrace(
	step: string,
	originalExecute: (...args: unknown[]) => unknown,
	options: { sink?: GoalTraceSinkConfig; getSink?: () => GoalTraceSinkConfig; fallbackCwd: string },
): (...args: unknown[]) => unknown {
	const { sink, getSink, fallbackCwd } = options;
	return function (this: unknown, ...args: unknown[]) {
		// Recover cwd: tools pass ctx as the 5th arg; commands may pass ctx as
		// the 2nd. Be defensive — never throw from cwd recovery.
		let cwd = fallbackCwd;
		try {
			for (const a of args) {
				if (a && typeof a === "object" && typeof (a as { cwd?: unknown }).cwd === "string") {
					cwd = (a as { cwd: string }).cwd;
					break;
				}
			}
		} catch {
			// keep fallbackCwd
		}
		return traceStep(step, cwd, () => originalExecute.apply(this, args), { sink, getSink }) as unknown;
	};
}

/** Where the trace log lives, for surfacing to users. */
export function goalTraceLogPath(cwd: string): string {
	return logPath(cwd);
}

/** Bounded previews for callers passing dynamic message strings. */
export const TRACE_PREVIEW = {
	error: ERROR_PREVIEW_BYTES,
	message: MESSAGE_PREVIEW_BYTES,
} as const;
