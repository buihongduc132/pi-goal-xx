/**
 * Auditor crash-trace logger — JSONL append-only log under `<cwd>/.pi/goals/`.
 *
 * Purpose: when a `complete_goal` audit crashes or hangs, this log is the
 * forensic trail. It records, in order:
 *   - session_start: goalId, model, prompt size, resource counts
 *   - each session event: type + compact summary (never full payload)
 *   - session_end: final verdict / error
 *
 * Invariants:
 *   - NEVER throws. File write failures are swallowed silently.
 *   - Non-blocking on the audit path: writes are sync + small (<2KB/line).
 *   - Truncates large fields (prompt preview, tool args, output) to bound size.
 *   - One JSONL file per cwd: `<cwd>/.pi/goals/auditor-trace.jsonl`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_FILE_NAME = "auditor-trace.jsonl";
const PROMPT_PREVIEW_BYTES = 4_000;
const OUTPUT_PREVIEW_BYTES = 8_000;
const MAX_OUTPUT_LOG_BYTES = 32_000;

export interface AuditorTraceEntry {
	/** Monotonic timestamp (ISO). */
	ts: string;
	/** Event phase: start | event | abort | end | error. */
	phase: string;
	/** Free-form fields, all serialisable. */
	[k: string]: unknown;
}

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

/** Truncate a string to N bytes with a `…(+<n> bytes)` suffix marker. */
export function previewBytes(value: string, max: number): string {
	if (value.length <= max) return value;
	const truncated = value.slice(0, max);
	return `${truncated}…(+${value.length - max} bytes)`;
}

/**
 * Append one structured entry to the auditor trace log. Never throws.
 */
export function logAuditorTrace(cwd: string, entry: AuditorTraceEntry): void {
	try {
		ensureLogDir(cwd);
		const line = JSON.stringify({
			...entry,
			ts: entry.ts ?? new Date().toISOString(),
		}) + "\n";
		fs.appendFileSync(logPath(cwd), line, { encoding: "utf8" });
	} catch {
		// Logging is best-effort. Never let it crash the audit.
	}
}

/** Build a start entry from the call args. */
export function buildStartEntry(args: {
	goalId: string;
	model?: string;
	thinkingLevel?: string;
	prompt: string;
	cwd: string;
	resolvedTools: string[];
	resolvedSkills: string[];
	resolvedExtensions: string[];
}): AuditorTraceEntry {
	return {
		ts: new Date().toISOString(),
		phase: "start",
		goalId: args.goalId,
		model: args.model,
		thinkingLevel: args.thinkingLevel,
		promptBytes: args.prompt.length,
		promptPreview: previewBytes(args.prompt, PROMPT_PREVIEW_BYTES),
		toolsCount: args.resolvedTools.length,
		tools: args.resolvedTools,
		skillsCount: args.resolvedSkills.length,
		skills: args.resolvedSkills,
		extensionsCount: args.resolvedExtensions.length,
		extensions: args.resolvedExtensions,
	};
}

/** Build an event entry from a session event. */
export function buildEventEntry(eventType: string, payload: Record<string, unknown>): AuditorTraceEntry {
	return {
		ts: new Date().toISOString(),
		phase: "event",
		eventType,
		...payload,
	};
}

/** Build an end entry capturing the final verdict. */
export function buildEndEntry(args: {
	goalId: string;
	approved: boolean;
	disapproved: boolean;
	model?: string;
	error?: string;
	output: string;
	elapsedMs: number;
}): AuditorTraceEntry {
	// Distinguish three terminal phases for forensics:
	//   - "end"   = audit ran to completion (approved or disapproved, no error)
	//   - "abort" = audit was aborted by the user (Esc) or external signal
	//   - "error" = audit crashed/threw unexpectedly
	const phase = args.error === "Auditor aborted." ? "abort" : args.error ? "error" : "end";
	return {
		ts: new Date().toISOString(),
		phase,
		goalId: args.goalId,
		approved: args.approved,
		disapproved: args.disapproved,
		model: args.model,
		error: args.error,
		elapsedMs: args.elapsedMs,
		outputBytes: args.output.length,
		outputPreview: previewBytes(args.output, OUTPUT_PREVIEW_BYTES),
	};
}

/** Where the trace log lives, for surfacing to users. */
export function auditorTraceLogPath(cwd: string): string {
	return logPath(cwd);
}

/** Cap on accumulated output log size (for callers that pre-aggregate). */
export const MAX_OUTPUT_LOG = MAX_OUTPUT_LOG_BYTES;
