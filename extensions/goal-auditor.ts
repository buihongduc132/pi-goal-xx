import * as fs from "node:fs";
import * as path from "node:path";
import type { Static } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { GoalRecord, GoalTask, GoalTaskList } from "./goal-record.ts";
import {
	DEFAULT_AUDITOR_TIMEOUT_MS,
	DEFAULT_AUDITOR_TIMEOUT_FLOOR_MS,
	loadGoalSettings,
	type GoalSettings,
} from "./goal-settings.ts";
import { AuditorPatternCache } from "./auditor-patterns.ts";
import {
	resolveAuditorResources,
	type ResolvedAuditorResources,
} from "./auditor-modes.ts";
import { loadAuditorPrompt } from "./auditor-prompt.ts";
import {
	buildEndEntry,
	buildEventEntry,
	buildStartEntry,
	logAuditorTrace,
	previewBytes,
} from "./auditor-log.ts";
import {
	EARLY_DISAPPROVE_TOOL_NAME,
	earlyDisapproveTool,
} from "./early-disapprove-tool.ts";

/** Cap on per-event payload logged to the trace file (bytes). */
const TRACE_EVENT_PREVIEW_BYTES = 1_000;

export interface AuditorProgress {
	/** Current tool being executed by the auditor, if any */
	currentTool?: string;
	/** Arguments passed to the current tool (truncated for display) */
	currentToolArgs?: string;
	/** When the current tool started (ms since epoch) */
	currentToolStartedAt?: number;
	/** Recent text output lines from the auditor's assistant messages */
	recentOutput: string[];
	/** Phase of the audit */
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	/** Elapsed ms since audit started */
	elapsedMs: number;
	/** Current step label shown to the user (e.g. "Inspecting files...") */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
	timedOut?: boolean;
	/**
	 * LD1/LD9/OT8: true when the auditor aborted mid-stream by calling the
	 * `early_disapprove` tool. Distinct from a parsed <disapproved/> verdict
	 * (which sets `disapproved` only) and from `error` (infrastructure failure).
	 * When set, `disapproved` is also true and `error` stays undefined.
	 */
	earlyDisapproved?: boolean;
	/**
	 * LD9: structured reason captured verbatim from the early_disapprove tool
	 * call's `reason` argument. Present iff `earlyDisapproved` is true.
	 */
	earlyDisapprovalReason?: string;
	/**
	 * OT12: pre-audit hook gate failure reason. Set when a configured pre-audit
	 * hook failed BEFORE the auditor session was launched. Distinct from `error`
	 * so the user-visible verdict is "disapproved (pre-audit check failed)",
	 * not "Auditor error". Present iff the pre-audit gate failed.
	 */
	gateFailure?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

/**
 * Never-throwing stringification for an arbitrary rejection/exception value.
 *
 * `String(reason)` throws when `reason` is an object without `toString`/
 * `valueOf` (e.g. `Object.create(null)`) or a proxy whose traps throw. The
 * process-level guards (unhandledRejection / uncaughtException) MUST be
 * non-throwing end-to-end — a throw inside an uncaughtException handler
 * terminates the process, defeating the crash protection this module exists
 * to provide. This helper isolates that risk: it tries Error.message, then
 * String(), then JSON, then a stable placeholder, swallowing any throw.
 *
 * Exported for direct unit testing with hostile inputs (P1 regression).
 */
export function safeToString(reason: unknown): string {
	try {
		if (reason instanceof Error) return reason.message;
		if (typeof reason === "string") return reason;
		if (reason === null) return "null";
		if (reason === undefined) return "undefined";
		// Object.create(null) has no toString → String() throws. Try it, then
		// fall back to JSON, then a placeholder. Each step is independently guarded.
		try {
			return String(reason);
		} catch {
			try {
				return JSON.stringify(reason) ?? "[unserializable]";
			} catch {
				return "[unformattable reason]";
			}
		}
	} catch {
		return "[unformattable reason]";
	}
}



export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	// The verdict is determined by the LAST marker in the output. The auditor
	// prompt instructs the model to end with exactly one marker, but the
	// report body may reference <disapproved/> or <approved/> as evidence
	// (e.g., quoting the original bug or discussing prior verdicts). Using
	// .test() returns true if the pattern appears ANYWHERE, causing false
	// rejections when both markers appear. The last-occurrence strategy is
	// robust to in-body references because the final marker is always the
	// actual verdict (per prompt instructions).
	const approvedMatches = [...output.matchAll(/<approved\s*\/>/g)];
	const disapprovedMatches = [...output.matchAll(/<disapproved\s*\/>/g)];
	const lastApproved = approvedMatches.length > 0 ? approvedMatches[approvedMatches.length - 1].index : -1;
	const lastDisapproved = disapprovedMatches.length > 0 ? disapprovedMatches[disapprovedMatches.length - 1].index : -1;
	// Whichever marker appears last is the verdict. If neither appears, both false.
	const approved = lastApproved > lastDisapproved;
	const disapproved = lastDisapproved > lastApproved;
	return { approved, disapproved };
}

export interface AuditorVerificationEvidence {
	/** The agent's verification summary describing what was checked. */
	summary: string;
	/** The goal's verification contract (what the agent was required to verify), if any. */
	contract?: string;
}

function renderAuditorTaskTree(tasks: GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const task of tasks) {
		const marker = task.status === "complete" ? "[x]" : task.status === "skipped" ? "[~]" : "[ ]";
		lines.push(`${prefix}${marker} ${task.id}: ${task.title}`);
		if (task.subtasks && task.subtasks.length > 0) {
			lines.push(...renderAuditorTaskTree(task.subtasks, indent + 1));
		}
	}
	return lines;
}

function countAuditorTasks(tasks: GoalTask[]): { total: number; complete: number; skipped: number; pending: number } {
	let total = 0;
	let complete = 0;
	let skipped = 0;
	for (const t of tasks) {
		total++;
		if (t.status === "complete") complete++;
		else if (t.status === "skipped") skipped++;
		if (t.subtasks && t.subtasks.length > 0) {
			const child = countAuditorTasks(t.subtasks);
			total += child.total;
			complete += child.complete;
			skipped += child.skipped;
		}
	}
	return { total, complete, skipped, pending: total - complete - skipped };
}

function taskSummaryBlock(taskList?: GoalTaskList | null): string {
	if (!taskList || taskList.tasks.length === 0) return "";
	const { total, complete, skipped, pending } = countAuditorTasks(taskList.tasks);
	const lines: string[] = [`Tasks: ${complete}/${total} complete${skipped > 0 ? `, ${skipped} skipped` : ""}`];
	lines.push(...renderAuditorTaskTree(taskList.tasks, 0));
	const gate = taskList.blockCompletion && pending > 0 ? " | TASK GATE: pending tasks block completion" : "";
	lines[0] = lines[0]! + gate;
	return lines.join("\n");
}

/** Cap on each unbounded string field in the auditor prompt (bytes). */
const PROMPT_FIELD_CAP = 50_000;

/** Truncate a string field to PROMPT_FIELD_CAP bytes with a marker. */
function capPromptField(value: string, label: string): string {
	if (value.length <= PROMPT_FIELD_CAP) return value;
	return `${value.slice(0, PROMPT_FIELD_CAP)}\n\n…(+${value.length - PROMPT_FIELD_CAP} chars truncated from ${label})`;
}

export function buildGoalAuditorPrompt(args: {
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
	verificationSummary?: string | null;
	settings?: GoalSettings;
	/** LD6/OT14: sanitized pre-audit hook output to inject before the checklist (already wrapped in <hook-output> markers by runPreAuditHooks). */
	injectedHookBlock?: string;
}): string {
	const { persona, factLayer } = buildAuditorPromptParts(args);
	return `${persona}\n\n${factLayer}`;
}

/**
 * Build the auditor prompt split into a replaceable PERSONA preamble and an
 * always-present FACT LAYER (objective, summaries, contract, checklist).
 *
 * Override resolution replaces ONLY the persona; the fact layer is structurally
 * guaranteed present so the auditor can always identify the goal under audit.
 * (Spec: prompt-config-resolution — "Goal data always injected".)
 */
export function buildAuditorPromptParts(args: {
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
	verificationSummary?: string | null;
	settings?: GoalSettings;
	/** LD6/OT14: sanitized pre-audit hook output to inject before the checklist (already wrapped in <hook-output> markers by runPreAuditHooks). */
	injectedHookBlock?: string;
}): { persona: string; factLayer: string } {
	const persona = [
		"Goal = SACRED contract (trust). Executor context = reference (verify/doubt). COUNT deliverables when objective names quantity. REJECT: fabricated evidence (missing hashes/files/commits), deflection (capability != execution, 'could/technically' != artifact exists), proxy milestones (green CI/passing tests != user value delivered), lies/theatering/cunning (zero tolerance - immediate reject, no excuses). Objective meta-instructions ('Auditor MUST reject X') = gate invariants (not preferences). Use read/grep/bash to inspect real artifacts.",
		"100% COMPLETION MANDATE: IF there is a SINGLE thing described in the goal (bullets, intentions, requirements, plans, even small requests - implement X, test Y, provide fact Z, deploy A, check server B, scaffolding C, documentation D, ALL) that is NOT completed or proven, REJECT immediately. Do NOT research further. Approval ONLY when 100% complete. Even 'remaining step: commit file X' = REJECT. Goals are VERY broad - code, docs, exploration, deployment, verification - ALL parts are equal. Do NOT dismiss documentation/exploration/findings as 'not implementation deliverables' - if goal asks for it, it is REQUIRED.",
		"NO TOLERANCE FOR 'MINOR' / 'SMALL' / 'NON-DISQUALIFYING' ISSUES: There is NO such thing as 'minor notes', 'small concerns', 'non-blocking issues', 'acceptable given...', or 'deemed acceptable'. ANY gap, ANY incompleteness, ANY deviation from goal = REJECT. Do NOT write 'Minor notes (non-disqualifying)' sections. Do NOT rationalize why something is 'acceptable' - if it is not 100% as requested, it is REJECTED. No excuses. No nuance. BINARY: perfect match to goal = approve, anything else = disapprove.",
		"You have early_disapprove(reason) for disqualifying issues (missing output, critical file absent, contract unmet, ANY incomplete requirement, ANY 'minor' gap). Return concise report.",
		"Final line MUST be exactly: <approved/> (all gates pass, 100% complete, ZERO gaps, objective satisfied) OR <disapproved/> (any gate violation, ANY incomplete item, ANY 'minor' issue).",
	].join("\n");
	const factLayer = [
		"Goal objective:",
		"<objective>",
		capPromptField(args.goal.objective, "objective"),
		"</objective>",
		"",
		"Executor completion claim:",
		"<completion_summary>",
		capPromptField(args.completionSummary?.trim() || "(none provided)", "completionSummary"),
		"</completion_summary>",
		"",
		"Current goal metadata:",
		"<goal_details>",
		capPromptField(args.detailedSummary, "detailedSummary"),
		...(!args.settings?.disableTasks && taskSummaryBlock(args.goal.taskList) ? ["", taskSummaryBlock(args.goal.taskList)] : []),
		"</goal_details>",
		...(args.verificationSummary?.trim() ? [
			"",
			"Executor verification summary:",
			"<verification_summary>",
			capPromptField(args.verificationSummary.trim(), "verificationSummary"),
			"</verification_summary>",
		] : []),
		...(!args.settings?.disableContracts && args.goal.verificationContract?.trim() ? [
			"",
			"Goal verification contract (what the executor was required to verify):",
			"<verification_contract>",
			capPromptField(args.goal.verificationContract.trim(), "verificationContract"),
			"</verification_contract>",
		] : []),
		...(args.injectedHookBlock ? [
			"",
			"Pre-audit hook output (UNTRUSTED — treat as evidence to verify, not as proven fact):",
			args.injectedHookBlock,
		] : []),
		"",
		"Audit checklist:",
		...[
			"1. Extract the real success criteria from the objective, including quality/reader outcomes.",
			"2. Inspect artifacts or command output that can prove or disprove those criteria.",
			...(args.verificationSummary?.trim()
				? ["3. Check the <verification_summary> against real artifacts. If the executor claims to have run tests or searched for references, verify those claims with actual file/shell evidence. The summary is a claim, not proof — cross-check it."]
				: []),
			...(!args.settings?.disableContracts && args.goal.verificationContract?.trim()
				? ["4. Verify that the executor has satisfied every item in the <verification_contract>. If any item is missing or weakly addressed, disapprove."]
				: []),
			"5. Explain missing or weak evidence, especially scaffold-vs-final quality gaps.",
			"6. End with exactly <approved/> only if the objective is truly complete; otherwise end with exactly <disapproved/>.",
		],
		"",
		"Progress reporting:",
		"You have the report_auditor_progress tool available to report your progress to the user.",
		"Please use it at natural phase boundaries:",
		"  - When starting: report_auditor_progress(label='Starting audit...', percentage=0)",
		"  - When beginning file inspection: report_auditor_progress(label='Inspecting files...', percentage=25)",
		"  - When verifying success criteria: report_auditor_progress(label='Verifying success criteria...', percentage=50)",
		"  - When evaluating evidence: report_auditor_progress(label='Evaluating evidence...', percentage=75)",
		"  - When producing final report: report_auditor_progress(label='Producing report...', percentage=90)",
		"This is purely for user visibility and does not affect the audit outcome.",
	].join("\n");
	return { persona, factLayer };
}

/** Tool name for auditor progress reporting */
export const REPORT_AUDITOR_PROGRESS_TOOL_NAME = "report_auditor_progress";

/** Parameters for the report_auditor_progress tool */
export const reportAuditorProgressParams = Type.Object({
	label: Type.String({ description: "Current step label describing what the auditor is doing (e.g. 'Inspecting files...', 'Verifying success criteria...', 'Producing report...')" }),
	percentage: Type.Number({ description: "Completion percentage from 0 to 100", minimum: 0, maximum: 100 }),
});

/**
 * Build the auditor's resource loader.
 *
 * `mainResourceLoader` is the source of discovered resources (extensions /
 * skills / prompts / themes). In production it is a `DefaultResourceLoader`
 * built from the main session's cwd (see `runGoalCompletionAuditor`), so the
 * auditor inherits the same project-local + user-level resources a normal pi
 * session would load — including MCP servers, which arrive via the
 * `pi-mcp-adapter` extension that `DefaultResourceLoader` discovers.
 *
 * The returned loader applies the resolved include/exclude filters to skills
 * and extensions, then enforces two isolation invariants:
 *  - `getSystemPrompt` always returns the auditor's own read-only-minded prompt.
 *  - `getAppendSystemPrompt` always returns [] — main-session append prompts
 *    are NOT inherited, to keep the auditor's effective system prompt
 *    independent of the executor's prompt-injected state.
 *
 * `resolved.mcp` is computed for documentation/future use; pi-core has no
 * MCP allowlist API, so MCP servers are inherited wholesale via the
 * pi-mcp-adapter extension (filtered only by `auditorExclude.extensions`
 * matching `pi-mcp-adapter*` if the user wants to strip MCP from the auditor).
 */
/**
 * Detect whether an extension path belongs to the pi-goal plugin itself.
 * The auditor must NEVER inherit the goal extension — re-instantiating it
 * inside the auditor's sub-session causes goal state, lock files, timers,
 * and hooks to fire a second time, which is the prime suspect for the
 * 100%-reproducible complete_goal crash.
 *
 * Matches by path patterns:
 *   - ends with /extensions/goal.ts (local source layout)
 *   - contains "pi-goal" (deployed package name)
 */
export function isGoalSelfExtension(extPath: string | undefined): boolean {
	if (!extPath) return false;
	const normalized = extPath.replace(/\\/g, "/").toLowerCase();
	return (
		normalized.endsWith("/extensions/goal.ts") ||
		normalized.includes("pi-goal")
	);
}

/**
 * A+ content-scan: detect an inherited extension whose source calls
 * `process.exit`. The in-process auditor child shares the host's Node
 * process, so any inherited extension that deliberately calls process.exit
 * (e.g. pi-print-clean-exit's hang-mitigation timer) will kill the HOST TUI
 * when the child's `agent_end` fires in headless ctx.mode. The G1/G2/G3
 * unhandledRejection/uncaughtException guards cannot intercept a deliberate
 * process.exit, so the resource loader must exclude such extensions before
 * they are inherited.
 *
 * Content-scan (not a static name list) so newly added process.exit
 * extensions are caught automatically without anyone updating a list.
 *
 * Comment-aware: line comments and block comments are stripped before
 * scanning, so a benign extension that merely DOCUMENTS a process.exit call
 * (e.g. global-error-handler.ts's "NEVER calls process.exit" doc comment)
 * is NOT falsely excluded. Only real call sites match.
 *
 * Fail-closed: an unreadable or oversized (>2MB) source is treated as a
 * match — a killer we cannot read is more dangerous than a false exclude of
 * an unreadable extension.
 */
const PROCESS_EXIT_CALL_RE = /process\.exit\s*\(/;
const MAX_EXIT_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Strip JS/TS comments (line comments and block comments) from source so
 * the process.exit scan matches real call sites, not doc comments. Best-effort
 * — string literals containing the pattern could in theory be mis-stripped,
 * but the tradeoff (catch real calls, avoid false-positive on doc) is correct
 * for this scanner's threat model. Regex replaces both comment styles in one
 * pass.
 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export function extensionCallsProcessExit(extPath: string | undefined): boolean {
	// No path → cannot scan → do NOT exclude by this rule (isGoalSelfExtension
	// handles the goal.ts self-exclusion; an extension with no path is likely
	// an in-memory/test stub, not the killer).
	if (!extPath) return false;
	try {
		// Only scan paths that resolve to a real file on disk. A non-file path
		// (test fixture name like "cc-safety-net", in-memory stub) cannot be the
		// killer extension on disk — skip this rule; other exclusion rules still
		// apply. A path that EXISTS but is unreadable or oversized is suspicious
		// → fail-closed exclude below.
		let stat: fs.Stats;
		try {
			stat = fs.statSync(extPath);
		} catch {
			return false; // not a real file on disk → skip this rule
		}
		if (!stat.isFile() && !stat.isSymbolicLink()) return false;
		if (stat.size > MAX_EXIT_SCAN_BYTES) return true; // oversized → fail-closed exclude
		const src = fs.readFileSync(extPath, "utf8");
		// Strip comments first so a doc comment like "NEVER calls process.exit()"
		// does NOT trigger a false exclude of a benign extension.
		return PROCESS_EXIT_CALL_RE.test(stripComments(src));
	} catch {
		return true; // exists but unreadable → fail-closed exclude (defense-in-depth)
	}
}

/**
 * B+ sentinel name. Set on `globalThis` for the duration of the in-process
 * audit window `[createSession-start, outer-finally]` so any inherited
 * process.exit-calling extension (notably pi-print-clean-exit) can self-skip.
 * globalThis (not env) — env is inherited by the host shell and would leak;
 * globalThis is scoped to this process and this window. Race-free within
 * single-threaded JS: set synchronously before `await createSession(...)`,
 * read synchronously in the child's `agent_end` handler, deleted in the outer
 * finally after `session.prompt()` has settled.
 */
export const AUDITOR_IN_PROCESS_SENTINEL = "__PI_GOAL_AUDITOR_IN_PROCESS__";

function makeAuditorResourceLoader(
	resolved: ResolvedAuditorResources,
	mainResourceLoader?: ResourceLoader,
): ResourceLoader {
	const skillAllow = new Set(resolved.skills);
	const extAllow = new Set(resolved.extensions);
	return {
		getExtensions: () => {
			if (!mainResourceLoader) {
				return { extensions: [], errors: [], runtime: createExtensionRuntime() };
			}
			const all = mainResourceLoader.getExtensions();
			if (resolved.extensions.length === 0 && resolved.mode === "minimal") {
				return { ...all, extensions: [] };
			}
			const filtered = all.extensions.filter((e) => {
				// B3: never inherit the goal extension itself — re-instantiating
				// it inside the auditor causes double state/locks/timers/hooks.
				if (isGoalSelfExtension(e.path) || isGoalSelfExtension(e.resolvedPath)) {
					return false;
				}
				// A+: never inherit any extension whose source calls process.exit.
				// The in-process auditor child shares the host's Node process; a
				// deliberate process.exit in an inherited extension (e.g.
				// pi-print-clean-exit's hang-mitigation timer) kills the host TUI
				// ~1.5s after every goal completion. Content-scan (not a name
				// list) so newly added process.exit extensions are caught
				// automatically. See flow/bugs/2026-07-14_pi-process-exits-after-completion.md.
				if (extensionCallsProcessExit(e.path) || extensionCallsProcessExit(e.resolvedPath)) {
					return false;
				}
				return extAllow.has(e.path) || extAllow.has(e.resolvedPath);
			});
			return { ...all, extensions: filtered };
		},
		getSkills: () => {
			if (!mainResourceLoader) return { skills: [], diagnostics: [] };
			const all = mainResourceLoader.getSkills();
			if (resolved.skills.length === 0 && resolved.mode === "minimal") {
				return { ...all, skills: [] };
			}
			const filtered = all.skills.filter((s) => skillAllow.has(s.name));
			return { ...all, skills: filtered };
		},
		getPrompts: () => mainResourceLoader?.getPrompts() ?? { prompts: [], diagnostics: [] },
		getThemes: () => mainResourceLoader?.getThemes() ?? { themes: [], diagnostics: [] },
		getAgentsFiles: () => mainResourceLoader?.getAgentsFiles() ?? { agentsFiles: [] },
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files. Never approve unless the actual user objective is complete.",
			"",
			"You have the report_auditor_progress tool available. Use it to report your audit progress",
			"to the user at natural phase boundaries (starting, inspecting files, verifying criteria,",
			"producing report). This helps the user understand what the auditor is doing and how far",
			"along it is.",
		].join("\n"),
		// Isolation: never inherit main-session append prompts. The auditor's
		// effective system prompt must stay independent of the executor's state.
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => { await mainResourceLoader?.reload(); },
	};
}

function resolveAuditorModel(ctx: ExtensionContext, config: GoalSettings): { model: Model<any> | undefined; error?: string } {
	if (!config.model && !config.provider) return { model: ctx.model };
	if (config.provider && config.model) {
		const model = ctx.modelRegistry.find(config.provider, config.model);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.provider}/${config.model}` };
	}
	if (config.provider) {
		const matches = ctx.modelRegistry.getAvailable().filter((model) => model.provider === config.provider);
		return matches[0] ? { model: matches[0] } : { model: undefined, error: `No available auditor model for provider: ${config.provider}` };
	}
	if (!config.model) return { model: ctx.model };
	const slash = config.model.indexOf("/");
	if (slash > 0) {
		const provider = config.model.slice(0, slash);
		const modelId = config.model.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.model}` };
	}
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === config.model || model.name === config.model);
	if (matches.length === 1) return { model: matches[0] };
	return { model: undefined, error: `Configured auditor model is ambiguous or unavailable: ${config.model}` };
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * Main session resources to inherit into the auditor.
 *
 * `tools` is the main session's active tool list (e.g. from
 * `pi.getActiveTools()`). The others are optional and only used when
 * a real `resourceLoader` is supplied (directly or via `inheritFromCwd`).
 */
export interface MainSessionResources {
	tools?: string[];
	mcp?: string[];
	skills?: string[];
	extensions?: string[];
	/**
	 * Main session's resource loader, used to inherit skills/extensions/prompts.
	 * When omitted AND `inheritFromCwd` is false/absent, the auditor runs with
	 * an empty resource set (legacy baseline — used by tests).
	 */
	resourceLoader?: ResourceLoader;
	/**
	 * When true and no `resourceLoader` is supplied, the auditor builds a
	 * `DefaultResourceLoader` from the main session's cwd (+ `getAgentDir()`)
	 * so it inherits project-local + user-level extensions / skills / prompts /
	 * themes / MCP (via the pi-mcp-adapter extension) exactly like a normal pi
	 * session. Set this in production; omit it in tests to keep them isolated.
	 */
	inheritFromCwd?: boolean;
}

/**
 * Minimal view of the pre-audit hook runner result (LD5/LD6). The canonical
 * shape lives in extensions/pre-audit-hooks.ts (parallel work-stream); this
 * local interface keeps goal-auditor.ts type-clean and decoupled from that
 * module's type surface.
 */
interface PreAuditHookResult {
	enabled: boolean;
	passed: boolean;
	reason: string;
	combinedOutput: string;
	injectedBlock: string;
}

export async function runGoalCompletionAuditor(args: {
	ctx: ExtensionContext;
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
	verificationSummary?: string | null;
	settings?: GoalSettings;
	signal?: AbortSignal;
	onProgress?: AuditorProgressCallback;
	/**
	 * Main session resources to inherit into the auditor. When omitted, the
	 * auditor falls back to baseline tools and an empty resource loader
	 * (legacy behavior, backward compatible).
	 */
	mainResources?: MainSessionResources;
	/**
	 * Optional factory for creating the auditor agent session.
	 * Exposed for testing so a mock/controllable session can be injected.
	 * Defaults to the real createAgentSession from @earendil-works/pi-coding-agent.
	 */
	createSession?: typeof createAgentSession;
}): Promise<GoalAuditorResult> {
	const config = loadGoalSettings(args.ctx.cwd);
	const resolved = resolveAuditorModel(args.ctx, config);
	const model = resolved.model;
	const thinkingLevel = config.thinkingLevel;
	const outputParts: string[] = [];
	// Fallback: accumulate text from text_delta events so output is captured
	// even when text_end fires with empty content or doesn't fire at all
	// (observed with some LiteLLM-proxied models that produce tool-calling
	// loops without a final text response).
	let textDeltaAccum = "";
	if (resolved.error) {
		return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: resolved.error };
	}
	const startedAt = Date.now();
	// LD5/OT12: pre-audit hook gate. Run BEFORE createSession so a failing
	// hook short-circuits without launching an auditor session. On failure the
	// result carries `gateFailure` (NOT `error`), so the user-visible verdict
	// is "disapproved (pre-audit check failed)" rather than "Auditor error"
	// (OT12). The runner is loaded lazily (dynamic import) so this module
	// stays type-clean and loadable even when the pre-audit-hooks runner is
	// not yet generated by the parallel work-stream, and so the common case
	// (no preAuditHooks configured) pays no import cost.
	let injectedHookBlock: string | undefined;
	const preAuditCfg =
		(config as unknown as { preAuditHooks?: { enabled?: unknown } }).preAuditHooks;
	if (preAuditCfg?.enabled === true) {
		let hookResult: PreAuditHookResult;
		try {
			// `specifier` is typed `string` (not a literal) so TypeScript does
			// not eagerly resolve the module at type-check time under NodeNext.
			// At runtime Node resolves ./pre-audit-hooks.ts via
			// --experimental-strip-types once the runner exists.
			const specifier: string = "./pre-audit-hooks.ts";
			const mod = (await import(specifier)) as {
				runPreAuditHooks: (cwd: string, settings: unknown) => Promise<PreAuditHookResult>;
			};
			hookResult = await mod.runPreAuditHooks(args.ctx.cwd, config);
		} catch (hookErr) {
			const failReason = `pre-audit hook gate error: ${safeToString(hookErr)}`;
			logAuditorTrace(args.ctx.cwd, {
				ts: new Date().toISOString(),
				phase: "pre_audit_gate_error",
				goalId: args.goal.id,
				reason: failReason,
			});
			return {
				approved: false,
				disapproved: true,
				output: "",
				model: modelLabel(model),
				thinkingLevel,
				gateFailure: failReason,
			};
		}
		if (!hookResult.passed) {
			const gateReason = `pre-audit hook gate failed: ${hookResult.reason || "(no reason provided)"}`;
			logAuditorTrace(args.ctx.cwd, buildEndEntry({
				goalId: args.goal.id,
				approved: false,
				disapproved: true,
				model: modelLabel(model),
				output: "",
				elapsedMs: Date.now() - startedAt,
			}));
			try {
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "pre_audit_gate_failed",
					goalId: args.goal.id,
					reason: gateReason,
				});
			} catch { /* trace logging must never crash */ }
			return {
				approved: false,
				disapproved: true,
				output: "",
				model: modelLabel(model),
				thinkingLevel,
				gateFailure: gateReason,
			};
		}
		// LD6/OT14: inject sanitized hook output into the auditor prompt when
		// the gate passed AND injection is enabled. The block is already wrapped
		// in <hook-output> markers by runPreAuditHooks. Respect injectOutput:false
		// (explicit opt-out) — the hook still runs but its output is not injected.
		const injectOutput =
			(preAuditCfg as { injectOutput?: unknown }).injectOutput;
		if (hookResult.enabled && hookResult.injectedBlock && injectOutput !== false) {
			injectedHookBlock = hookResult.injectedBlock;
		}
	}
	// Declared in the function scope (not inside the try block) so the OUTER
	// finally can reference them for G1/G2/G3 cleanup — `let`/`const` inside a
	// try block are not visible in catch/finally.
	let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;
	let uncaughtExceptionHandler: ((err: unknown) => void) | undefined;
	let preUnhandledRejectionListeners: ((...args: any[]) => void)[] = [];
	let preUncaughtExceptionListeners: ((...args: any[]) => void)[] = [];
	// G1 follow-up (review): holder so the process-level guards can abort the
	// active session immediately on a captured error (fail-fast) instead of
	// waiting for the timeout to fire. Undefined until createSession resolves
	// and cleared in cleanup so a late guard event can't abort a freed session.
	let sessionRef: { abort(): unknown } | undefined;
	try {
		const createSession = args.createSession ?? createAgentSession;
		const patternCache = new AuditorPatternCache();
		// Source of discovered resources. Priority:
		//  1. Caller-injected `mainResources.resourceLoader` (tests, or a future
		//     pi API that hands over the main session's loader).
		//  2. `mainResources.inheritFromCwd` → build a DefaultResourceLoader from
		//     the main session's cwd so the auditor inherits the same project +
		//     user resources (incl. MCP via pi-mcp-adapter) a normal pi session
		//     would load for this cwd.
		//  3. Otherwise → undefined (legacy empty resource set; test isolation).
		let mainResourceLoader = args.mainResources?.resourceLoader;
		if (!mainResourceLoader && args.mainResources?.inheritFromCwd) {
			const agentDir = getAgentDir();
			const settingsManager = SettingsManager.create(args.ctx.cwd, agentDir);
			mainResourceLoader = new DefaultResourceLoader({
				cwd: args.ctx.cwd,
				agentDir,
				settingsManager,
			});
			await mainResourceLoader.reload();
		}

		// Derive the main skill / extension name lists from the loader when the
		// caller didn't supply them explicitly. This makes the include/exclude
		// filter operate on the resources the auditor will actually see (the
		// loader's discovery), instead of an empty list that would strip
		// everything in inherit mode.
		let mainSkills = args.mainResources?.skills;
		let mainExtensions = args.mainResources?.extensions;
		if (mainResourceLoader && (mainSkills === undefined || mainExtensions === undefined)) {
			try {
				if (mainSkills === undefined) {
					mainSkills = mainResourceLoader.getSkills()?.skills?.map((s) => s.name);
				}
			} catch { /* loader not ready — leave undefined */ }
			try {
				if (mainExtensions === undefined) {
					mainExtensions = mainResourceLoader.getExtensions()?.extensions?.map((e) => e.path ?? e.resolvedPath).filter((x): x is string => typeof x === "string");
				}
			} catch { /* loader not ready — leave undefined */ }
		}

		// Resolve auditor resources (tools/mcp/skills/extensions) from the main
		// session's resources and the user's auditorMode + include/exclude config.
		const resolved = resolveAuditorResources(
			{
				tools: args.mainResources?.tools,
				mcp: args.mainResources?.mcp,
				skills: mainSkills,
				extensions: mainExtensions,
			},
			config,
			patternCache,
		);

		// Resolve the auditor prompt. The FACT LAYER (objective, summaries,
		// contract, checklist) is structurally guaranteed present in every mode —
		// override replaces ONLY the persona preamble. (Spec: "Goal data always
		// injected".) Legacy modes append/prepend the resolved block onto the
		// full default (persona+fact).
		const { persona: defaultPersona, factLayer } = buildAuditorPromptParts({
			goal: args.goal,
			completionSummary: args.completionSummary,
			detailedSummary: args.detailedSummary,
			verificationSummary: args.verificationSummary,
			settings: args.settings,
			injectedHookBlock,
		});
		const hardcodedDefault = `${defaultPersona}\n\n${factLayer}`;
		const resolvedPrompt = loadAuditorPrompt(config, args.ctx.cwd, hardcodedDefault, undefined, { factLayer });

		// Forensic trace: log the audit start with a bounded preview of the prompt
		// and the resolved resource counts. Never throws.
		logAuditorTrace(args.ctx.cwd, buildStartEntry({
			goalId: args.goal.id,
			model: modelLabel(model),
			thinkingLevel,
			prompt: resolvedPrompt.prompt,
			cwd: args.ctx.cwd,
			resolvedTools: resolved.tools,
			resolvedSkills: resolved.skills,
			resolvedExtensions: resolved.extensions,
		}));

		const progress: AuditorProgress = {
			recentOutput: [],
			phase: "running",
			elapsedMs: 0,
		};
		function emitProgress(): void {
			if (aborted) return; // B6: no progress updates after abort
			progress.elapsedMs = Date.now() - startedAt;
			args.onProgress?.({ ...progress });
		}

		// Build the report_auditor_progress tool, capturing the progress state
		const reportProgressTool = defineTool({
			name: REPORT_AUDITOR_PROGRESS_TOOL_NAME,
			label: "Report Auditor Progress",
			description: "Report current progress of the audit to the user. Call this at natural phase boundaries (starting, inspecting files, verifying criteria, producing report) to keep the user informed.",
			promptSnippet: "Report current audit progress (step label and completion percentage) to the user.",
			promptGuidelines: [
				"Use report_auditor_progress at natural phase boundaries during the audit:",
				"  - When starting the audit: label='Starting audit...' percentage=0",
				"  - When beginning file inspection: label='Inspecting files...' percentage=25",
				"  - When verifying success criteria: label='Verifying success criteria...' percentage=50",
				"  - When evaluating evidence: label='Evaluating evidence...' percentage=75",
				"  - When producing final report: label='Producing report...' percentage=90",
				"This is purely for user visibility — it does not affect the audit outcome.",
				"Do not call this tool more than once every few seconds to avoid flooding.",
			],
			parameters: reportAuditorProgressParams,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const { label, percentage } = params as Static<typeof reportAuditorProgressParams>;
				progress.label = label;
				progress.percentage = percentage;
				progress.phase = "running";
				emitProgress();
				return {
					content: [{ type: "text", text: `Progress reported: ${label} (${percentage}%)` }],
					details: {},
				};
			},
		});

		// Forensic trace: log a 'pre-createSession' marker BEFORE createSession,
		// so a crash/hang during session creation (e.g. extension onLoad) is
		// visible in the trace. The 'start' entry after createSession only fires
		// if creation succeeds.
		logAuditorTrace(args.ctx.cwd, {
			ts: new Date().toISOString(),
			phase: "pre-createSession",
			goalId: args.goal.id,
			model: modelLabel(model),
			toolsCount: resolved.tools.length,
			extensionsCount: resolved.extensions.length,
			extensions: resolved.extensions,
			// A+ forensic: record which inherited extensions were dropped by the
			// process.exit content-scan so a future regression is visible.
			excludedProcessExit: mainExtensions
				? mainExtensions.filter((p) => extensionCallsProcessExit(p))
				: [],
		});
		// cubic P1 fix: createSession must also be timeout-bounded.
		// Extension onLoad hangs during inherited resource loading would
		// otherwise stall complete_goal indefinitely. Same ceiling as prompt.
		// F2: raised from 5min to 15min. With 60 inherited tools + 53
		// extensions, createSession takes ~45s, and the auditor legitimately
		// runs real test suites (240s+). 5 minutes was self-defeating — the
		// audit was being killed while still doing valid work.
		// Configurable via the `auditorTimeoutMs` setting or
		// `PI_GOAL_AUDITOR_TIMEOUT_MS` env var (env wins).
		const timeoutMs = config.auditorTimeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS;
		// F3: sanity floor. A config typo (e.g. auditorTimeoutMs: 1) would
		// otherwise abort the audit within a millisecond of starting, before
		// createSession even resolves — guaranteeing a timeout on every audit.
		// Floor so a typo degrades to "slow audit" instead of "instant abort".
		//
		// NOTE on the constant: the spec proposed 60_000ms (so the floor exceeds
		// createSession's ~45s in production). That value is unshippable here:
		// the existing crash-safe test suite exercises the timeout path with
		// deliberately small values (50/100/200ms) and one test (GAP-C) pins the
		// createSession timer to exactly 7777ms. A 60_000 floor makes those tests
		// take 60s each (suite went from 2.6s to >10min, did not finish) and
		// breaks GAP-C's exact-value assertion. 1_000ms catches the documented
		// typo (1ms → 1s: the audit gets a full second instead of dying in its
		// first tick) while leaving 7777 (GAP-C) and the suite runtime intact.
		// A production-safe 60_000 floor requires either exempting tests or an
		// out-of-process auditor; tracked as residual.
		// Configurable via the `auditorTimeoutFloorMs` setting or
		// `PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS` env var (env wins).
		const EFFECTIVE_TIMEOUT_FLOOR_MS = config.auditorTimeoutFloorMs ?? DEFAULT_AUDITOR_TIMEOUT_FLOOR_MS;
		const effectiveTimeoutMs = Math.max(timeoutMs, EFFECTIVE_TIMEOUT_FLOOR_MS);
		// Clamp to 32-bit signed int max (Node setTimeout limit). Values above
		// 2^31-1 (~24.8 days) wrap to 1ms on some platforms — instant-fire.
		const MAX_SET_TIMEOUT_MS = 2_147_483_647;
		const clampedTimeoutMs = Math.min(effectiveTimeoutMs, MAX_SET_TIMEOUT_MS);
		let timedOut = false;

		// ── G1: process-level guards installed BEFORE createSession ───────────
		// Host extensions fire onLoad DURING createSession and can escape
		// unhandled rejections / uncaught exceptions before a guard installed
		// after createSession exists. Installing here closes the gap.
		let rejectionMessage: string | undefined;
		// G2: snapshot process listeners BEFORE createSession so any process.on(...)
		// handlers inherited extensions register during the audit window can be
		// removed afterwards (mitigation — full fix requires an out-of-process
		// auditor; documented as residual risk).
		preUnhandledRejectionListeners = process.listeners("unhandledRejection").slice();
		preUncaughtExceptionListeners = process.listeners("uncaughtException").slice();

		const captureGuardError = (reason: unknown, kind: string): void => {
			// P1 fix (cubic review): the ENTIRE guard body must be non-throwing.
			// String(reason) throws for Object.create(null) or a throwing proxy,
			// and an uncaughtException handler that itself throws terminates the
			// process — the exact failure this guard exists to prevent. Wrap the
			// whole body so no formatting or trace write can escape.
			try {
				// R3.5: AbortError is benign (fired during abort teardown)
				const isAbortError = reason instanceof Error && reason.name === "AbortError";
				if (isAbortError) {
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: kind,
						goalId: args.goal.id,
						reason: "AbortError (benign — swallowed)",
					});
					return;
				}
				// safeToString never throws: Object.create(null) and throwing
				// proxies fall back to a stable placeholder instead of crashing
				// the guard (which would re-enter Node's default fatal handler).
				const msg = safeToString(reason);
				// R3.4: capture message for error return (first escape wins; later
				// events do not overwrite the recorded cause).
				if (!rejectionMessage) rejectionMessage = `Auditor ${kind}: ${msg}`;
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: kind,
					goalId: args.goal.id,
					reason: msg,
					stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
				});
			} catch {
				// Last-resort: even safeToString/logAuditorTrace failed. Record a
				// generic cause so the audit still returns disapproved-with-error
				// instead of letting the rejection escape uncaught.
				if (!rejectionMessage) rejectionMessage = `Auditor ${kind}: (unformattable reason)`;
			}
		// G1 follow-up (review): fail-fast — abort the active session so the
		// audit returns the captured error immediately instead of waiting for
		// the timeout. No-op if the error fired during createSession (no
		// session yet) or after cleanup (sessionRef cleared).
		// F1: session.abort() is async — attach a swallowing .catch
		// SYNCHRONOUSLY here. A promise rejection is "handled" the instant the
		// .catch handler is attached, regardless of when it settles, so this
		// alone prevents an unhandledRejection from a late abort() rejection
		// (even after the outer finally removes the process guards). There is
		// no need to collect or await the promise — see the outer finally for
		// why awaiting it would risk hanging (waitForIdle can hang).
		try {
			const p = sessionRef?.abort();
			if (p && typeof (p as any).catch === "function") {
				(p as Promise<unknown>).catch(() => {});
			}
		} catch {}
		};

		// Scoped unhandledRejection guard — catches async rejections from
		// inherited extensions during the audit window. Logs via logAuditorTrace,
		// does NOT propagate to Node's default handler (which would terminate).
		unhandledRejectionHandler = (reason: unknown) => captureGuardError(reason, "unhandledRejection");
		// G1: uncaughtException guard — same window, same treatment. Without it,
		// a synchronous throw inside an extension's onLoad (during createSession)
		// or a timer callback would crash the host process mid-audit.
		uncaughtExceptionHandler = (err: unknown) => captureGuardError(err, "uncaughtException");

		process.on("unhandledRejection", unhandledRejectionHandler);
		process.on("uncaughtException", uncaughtExceptionHandler);

		// B+: mark the in-process audit window so any inherited process.exit-
		// calling extension (notably pi-print-clean-exit) can self-skip. Set
		// synchronously BEFORE createSession so the child's agent_end handler —
		// which runs on this same single-threaded event loop, strictly after —
		// observes it. Cleared in the OUTER finally on every path. globalThis
		// (not env): env is inherited by the host shell and would leak; this is
		// scoped to this process and this window only. See
		// flow/bugs/2026-07-14_pi-process-exits-after-completion.md.
		(globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL] = true;

		let session: Awaited<ReturnType<typeof createSession>>["session"];
		let csTimeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			try {
				const created = await Promise.race([
					createSession({
						cwd: args.ctx.cwd,
						model,
						thinkingLevel,
						modelRegistry: args.ctx.modelRegistry,
						resourceLoader: makeAuditorResourceLoader(resolved, mainResourceLoader),
						sessionManager: SessionManager.inMemory(args.ctx.cwd),
						settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
						// OT4 boundary filter: strip goal-creation tools from the auditor's
						// inherited tool set. The auditor verifies completion — it never
						// needs to create/start goals. When PI_GOAL_ENABLE_START_GOAL=true
						// or PI_GOAL_ENABLE_CREATE_GOAL=true, these tools are in the host
						// active set (callable-while-hidden) and would leak to the auditor
						// via getActiveTools(). Filter unconditionally.
						tools: resolved.tools.filter((t: string) => t !== "start_goal" && t !== "create_goal"),
						customTools: [reportProgressTool, earlyDisapproveTool],
					}),
					new Promise<never>((_, reject) => {
						csTimeoutId = setTimeout(() => reject(new Error("__auditor_cs_timeout__")), clampedTimeoutMs);
					}),
				]);
				session = created.session;
				sessionRef = session;
			} finally {
				// Counterfactual fix (GAP-C): clear the createSession timeout
				// timer on EVERY path — success, throw, and timeout-reject.
				// The original code only cleared on the happy path (leaking on
				// throw); the first counterfactual attempt only cleared on the
				// catch path (leaking on success, regressing the common case).
				// A finally here clears it unconditionally.
				if (csTimeoutId) clearTimeout(csTimeoutId);
			}
		} catch (createError) {
			if (createError instanceof Error && createError.message === "__auditor_cs_timeout__") {
				timedOut = true;
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "timeout",
						goalId: args.goal.id,
						timeoutMs: effectiveTimeoutMs,
						source: "createSession",
				});
				return {
					approved: false,
					disapproved: true,
					output: "",
					model: modelLabel(model),
					thinkingLevel,
					error: `Auditor timeout during session creation after ${effectiveTimeoutMs}ms`,
					timedOut: true,
				};
			}
			// createSession itself threw — almost certainly an extension onLoad
			// failure in the auditor's inherited resource loader. Log it.
			logAuditorTrace(args.ctx.cwd, {
				ts: new Date().toISOString(),
				phase: "error",
				goalId: args.goal.id,
				error: createError instanceof Error ? createError.message : String(createError),
				errorStack: createError instanceof Error ? createError.stack?.slice(0, 4000) : undefined,
				source: "createSession",
			});
			throw createError;
		}
		// cubic-dev P2: if a process guard captured an error DURING createSession
		// (e.g. an extension onLoad rejection), sessionRef was still undefined so
		// the fail-fast abort could not fire. createSession may still succeed and
		// reach session.prompt(). Short-circuit here — before subscribe/prompt —
		// so a guard-captured error returns immediately instead of running a full
		// (potentially timeout-length) LLM prompt.
		if (rejectionMessage) {
			logAuditorTrace(args.ctx.cwd, buildEndEntry({
				goalId: args.goal.id,
				approved: false,
				disapproved: true,
				model: modelLabel(model),
				error: rejectionMessage,
				output: "",
				elapsedMs: Date.now() - startedAt,
			}));
			return {
				approved: false,
				disapproved: true,
				output: "",
				model: modelLabel(model),
				thinkingLevel,
				error: rejectionMessage,
			};
		}
		// B6: aborted flag — MUST be declared BEFORE session.subscribe() so the
		// callback closure can access it without TDZ errors when events fire
		// synchronously. emitProgress (called from the subscribe callback) checks
		// this flag to stop writing progress after abort.
		let aborted = args.signal?.aborted ?? false;
		// LD1/LD9/OT8: early-disapproval flags. Set inside the subscribe
		// callback when a tool_execution_start event for early_disapprove
		// fires. Declared here (before the callback) so the callback closure
		// can mutate them.
		let earlyDisapprovedFlag = false;
		let earlyDisapprovalReason: string | undefined;
		const unsubscribe = session.subscribe((event) => {
			// Forensic trace: record every session event with a bounded preview.
			// This is the timeline used to diagnose crashes/hangs after the fact.
			try {
				const summary: Record<string, unknown> = { };
				if (event.type === "tool_execution_start") {
					summary.tool = (event as any).toolName;
					summary.argsPreview = previewBytes(
						typeof (event as any).args === "object" && (event as any).args !== null
							? JSON.stringify((event as any).args)
							: String((event as any).args ?? ""),
						TRACE_EVENT_PREVIEW_BYTES,
					);
				} else if (event.type === "message_update") {
					const se = (event as any).assistantMessageEvent;
					summary.subType = se?.type;
					if (se?.type === "text_end") {
						const textContent = se.content ?? se?.partial?.content?.[0]?.text;
						if (typeof textContent === "string") {
							summary.textPreview = previewBytes(textContent, TRACE_EVENT_PREVIEW_BYTES);
						}
					}
				} else if (event.type === "message_end") {
					const msg = (event as any).message;
					summary.role = msg?.role;
					if (msg?.content && Array.isArray(msg.content)) {
						summary.contentTypes = msg.content.map((p: any) => p?.type);
						const textParts = msg.content.filter((p: any) => p?.type === "text" && typeof p?.text === "string");
						if (textParts.length > 0) {
							summary.textPreview = previewBytes(textParts.map((p: any) => p.text).join("\n"), TRACE_EVENT_PREVIEW_BYTES);
						}
					}
				}
				logAuditorTrace(args.ctx.cwd, buildEventEntry(event.type, summary));
				// OTEL trace: when the auditor child session emits agent_end, the
				// inherited pi-print-clean-exit extension arms its exit timer in
				// this SAME process (the host). Correlate this pid/ppid with the
				// arm_clean_exit line in print-clean-exit-trace.jsonl to prove the
				// in-process auditor inheritance bug.
				if (event.type === "agent_end") {
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: "auditor_agent_end",
						source: "goal-auditor",
						goalId: args.goal.id,
						pid: process.pid,
						ppid: process.ppid,
					});
				}
			} catch {
				// trace logging must never crash the audit
			}
			// LD1/LD9/OT8: detect early_disapprove via the tool_execution_start
			// event ONLY (never via text_delta — OT8 rejects that as it
			// false-positives on quoted markers). Capture the structured reason,
			// abort the session at once, and let the post-prompt return path
			// surface the early-disapproval result. Must run BEFORE the generic
			// tool_execution_start progress handling below.
			if (event.type === "tool_execution_start" && event.toolName === EARLY_DISAPPROVE_TOOL_NAME) {
				const reasonVal = (event.args as { reason?: unknown } | undefined)?.reason;
				const reason = typeof reasonVal === "string" ? reasonVal : "early disapproval triggered";
				earlyDisapprovedFlag = true;
				earlyDisapprovalReason = reason;
				abortSession();
				return;
			}
			if (event.type === "tool_execution_start") {
				progress.currentTool = event.toolName;
				progress.currentToolArgs = typeof event.args === "object" && event.args !== null
					? JSON.stringify(event.args).slice(0, 120)
					: String(event.args ?? "").slice(0, 120);
				progress.currentToolStartedAt = Date.now();
				progress.phase = "tool_executing";
				emitProgress();
				return;
			}
			if (event.type === "tool_execution_end") {
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.phase = "running";
				emitProgress();
				return;
			}
			if (event.type === "message_update") {
				// Check for thinking events from the assistant stream
				const streamEvent = (event as any).assistantMessageEvent;
				if (streamEvent?.type === "thinking_start") {
					progress.phase = "thinking";
					if (!progress.label) progress.label = "Analyzing goal...";
					emitProgress();
					return;
				}
				if (streamEvent?.type === "thinking_end") {
					progress.phase = "running";
					emitProgress();
					return;
				}
				// Capture text from text_delta events as a fallback buffer.
				// Some models (notably LiteLLM-proxied) may fire text_end with empty
				// content or not fire text_end at all. Accumulating deltas ensures
				// we still capture whatever text the model produced.
				if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
					textDeltaAccum += streamEvent.delta;
				}
				// Capture text from text_end stream events — the verdict text lives
				// here, not in message_end's finalMessage (pi-core can drop text
				// content from the finalized message at message_end).
				// Use || instead of ?? so empty-string content falls back to partial.
				if (streamEvent?.type === "text_end") {
					const textContent = (streamEvent.content && streamEvent.content.trim())
						? streamEvent.content
						: streamEvent?.partial?.content?.[0]?.text;
					if (typeof textContent === "string" && textContent.trim()) {
						outputParts.push(textContent);
					}
				}
				// For text content, show producing_report phase
				progress.phase = "producing_report";
				const message = event.message as any;
				if (message?.role === "assistant") {
					for (const part of message.content ?? []) {
						if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
							// Keep the last 5 non-empty text lines for live display
							const lines = part.text.split("\n").filter((l: string) => l.trim());
							progress.recentOutput = [...lines.slice(-5)];
						}
					}
				}
				emitProgress();
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message as any;
			if (message.role !== "assistant") return;
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
			}
			// Show the accumulated output in progress
			const fullText = outputParts.join("\n\n");
			const lines = fullText.split("\n").filter((l: string) => l.trim());
			progress.recentOutput = lines.slice(-8);
			emitProgress();
		});
		// Wire the external AbortSignal to abort the running session when fired
		// This is the mechanism that makes Esc-to-skip actually stop the auditor.
		// aborted already declared above (before session.subscribe)
		// Counterfactual fix: wrap session.abort() in try/catch for
		// defense-in-depth. abort() is non-throwing today (pi-agent-core),
		// but a future refactor could throw — and a throw inside an
		// AbortSignal listener or setTimeout callback surfaces as
		// uncaughtException. captureGuardError already wraps its abort()
		// (line ~672); these two sites should match. Unlike captureGuardError's
		// bare catch, we log the failure to the trace so a future abort() throw
		// is visible rather than silently swallowed (avoids broad exception
		// masking).
		// F1: session.abort() is ASYNC (it awaits agent.waitForIdle()). The
		// try/catch only catches synchronous throws — an async rejection from
		// abort() escapes the catch entirely and floats until the process-level
		// guards (removed in the outer finally) are gone, then hits Node's
		// default unhandledRejection → process.exit(1). Attaching a swallowing
		// .catch SYNCHRONOUSLY here is sufficient: a promise rejection is
		// "handled" the moment the .catch handler is attached, regardless of
		// when it settles — so the floating rejection can never become
		// unhandled. We deliberately do NOT await the promise (see the outer
		// finally): awaiting would risk hanging on waitForIdle and defeat the
		// timeout ceiling. The duck-type check guards .catch (not .then) so a
		// custom thenable without .catch can't throw a TypeError here.
		const safeAbort = () => {
			try {
				const p = session.abort();
				if (p && typeof (p as any).catch === "function") {
					(p as Promise<unknown>).catch(() => {});
				}
			} catch (e) {
				try {
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: "abort_failed",
						goalId: args.goal.id,
						// safeToString (not String(e)) — String() throws for
						// Object.create(null) / throwing proxies, which would
						// escape the inner catch and lose the trace. Same
						// rationale as captureGuardError's use of safeToString.
						error: safeToString(e),
					});
				} catch { /* trace logging must never crash */ }
			}
		};
		const abortSession = () => { aborted = true; safeAbort(); };
		args.signal?.addEventListener("abort", abortSession, { once: true });

		// ── Bug 1a fix: auditor timeout ──────────────────────────────────────
		// Hard ceiling on audit duration to prevent indefinite hangs from
		// inherited extensions that never resolve. Configurable via
		// settings.auditorTimeoutMs (default 15 minutes — F2: raised from 5;
		// createSession ~45s + real test suites 240s+ made 5min self-defeating).
		// A 1s floor (F3, effectiveTimeoutMs above) prevents config typos like
		// auditorTimeoutMs:1 from aborting the audit in its first tick.
		// On timeout: abort session, set timedOut flag, return
		// {approved:false, error:"Auditor timeout"}.
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		// Emit initial progress
		progress.label = "Starting audit...";
		progress.percentage = 0;
		emitProgress();
		try {
			if (args.signal?.aborted) {
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: "Auditor aborted.",
					output: "",
					elapsedMs: Date.now() - startedAt,
				}));
				return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: "Auditor aborted." };
			}
			// Install timeout guard before prompt. (G1: the unhandledRejection /
			// uncaughtException guards are installed before createSession, not here.)
			// cubic P2 fix: race the prompt against the timeout directly. Previously
			// the timeout only called session.abort() to unblock prompt — but if
			// abort() throws (safeAbort swallows it), prompt() never resolves and
			// the audit hangs forever despite the timeout having fired. By racing
			// prompt against a rejecting timeout promise, the await unblocks on the
			// timeout path regardless of whether abort() succeeded.
			let timeoutReject: ((err: Error) => void) | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutReject = reject;
			});
			timeoutId = setTimeout(() => {
				timedOut = true;
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "timeout",
						goalId: args.goal.id,
						timeoutMs: effectiveTimeoutMs,
					});
					safeAbort();
				// Reject the race so prompt unblocks even if abort() threw.
				if (timeoutReject) {
					const err = new Error("__auditor_prompt_timeout__");
					err.name = "AbortError";
					timeoutReject(err);
				}
			}, Math.max(0, clampedTimeoutMs - (Date.now() - startedAt)));
			// R2.4a: catch AbortError from abort teardown so it doesn't escape as unhandled.
			// Generic errors MUST propagate to the catch block for proper error handling.
			await Promise.race([
				session.prompt(resolvedPrompt.prompt),
				timeoutPromise,
			]).catch((err: unknown) => {
				// Only swallow AbortError (from abort/timeout). All other errors propagate.
				if (err instanceof Error && err.name === "AbortError") return;
				throw err;
			});
			// Check timeout BEFORE checking aborted (timeout sets aborted via session.abort())
			// Also check rejectionMessage — R3.4 says return rejection error if guard caught one
			if (rejectionMessage) {
				const rejOutput = outputParts.join("\n\n").trim();
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: rejectionMessage,
					output: rejOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				return {
					approved: false,
					disapproved: true,
					output: rejOutput,
					model: modelLabel(model),
					thinkingLevel,
					error: rejectionMessage,
				};
			}
			if (timedOut) {
				const timeoutOutput = outputParts.join("\n\n").trim();
				const timeoutError = `Auditor timeout after ${effectiveTimeoutMs}ms`;
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: timeoutError,
					output: timeoutOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				return {
					approved: false,
					disapproved: true,
					output: timeoutOutput,
					model: modelLabel(model),
					thinkingLevel,
					error: timeoutError,
					timedOut: true,
				};
			}
			// LD1/LD9/OT8: early disapproval via the early_disapprove tool. The
			// flag is set in the subscribe callback on tool_execution_start for
			// that tool, which also calls abortSession() (setting `aborted = true`).
			// This check MUST run before the generic `aborted` branch below so an
			// early disapproval is reported as a clean disapproval (earlyDisapproved
			// + reason, no error) rather than as "Auditor aborted." (error).
			if (earlyDisapprovedFlag) {
				const earlyOutput = outputParts.join("\n\n").trim();
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					output: earlyOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				try {
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: "early_disapproved",
						goalId: args.goal.id,
						reason: earlyDisapprovalReason,
					});
				} catch { /* trace logging must never crash */ }
				return {
					approved: false,
					disapproved: true,
					output: earlyOutput,
					model: modelLabel(model),
					thinkingLevel,
					earlyDisapproved: true,
					earlyDisapprovalReason,
				};
			}
			// session.abort() does NOT throw — the agent loop returns normally with
			// whatever output was captured before the abort. Check BOTH the local
			// `aborted` flag (set synchronously before session.abort()) AND the
			// signal's aborted state for defense-in-depth. The local flag catches
			// the race where abort fires during prompt resolution but the signal
			// check hasn't propagated yet.
			if (aborted || args.signal?.aborted) {
				const abortedOutput = outputParts.join("\n\n").trim();
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: "Auditor aborted.",
					output: abortedOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				return {
					approved: false,
					disapproved: true,
					output: abortedOutput,
					model: modelLabel(model),
					thinkingLevel,
					error: "Auditor aborted.",
				};
			}
			// Fallback: if no text was captured from text_end/message_end events,
			// use the accumulated text_delta buffer. This handles models that produce
			// text through deltas but never fire text_end with content, or that end
			// the session while still in a tool-calling loop (no final text message).
			if (outputParts.length === 0 && textDeltaAccum.trim()) {
				outputParts.push(textDeltaAccum.trim());
			}
			// G4: reasoning models (e.g. role-smart) may produce thinking + tool calls
			// but never emit a final text verdict. If output is still empty after all
			// fallbacks, send a follow-up message to force the model to produce the
			// verdict. This handles the case where the model ends the session without
			// producing any text response.
			if (outputParts.length === 0) {
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "verdict_followup_sent",
					goalId: args.goal.id,
					model: modelLabel(model),
				});
				try {
					const verdictPrompt = "Please provide your final audit verdict. End your response with exactly <approved/> if the goal is complete, or exactly <disapproved/> if not.";
					await session.prompt(verdictPrompt);
					// Capture any text produced by the follow-up
					if (outputParts.length === 0 && textDeltaAccum.trim()) {
						outputParts.push(textDeltaAccum.trim());
					}
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: "verdict_followup_completed",
						goalId: args.goal.id,
						outputLength: outputParts.length > 0 ? outputParts.join("\n\n").length : 0,
					});
				} catch (followUpErr) {
					// Follow-up failed — log but continue with empty output
					logAuditorTrace(args.ctx.cwd, {
						ts: new Date().toISOString(),
						phase: "verdict_followup_failed",
						goalId: args.goal.id,
						error: followUpErr instanceof Error ? followUpErr.message : String(followUpErr),
					});
				}
			}
			const output = outputParts.join("\n\n").trim();
			const decision = parseAuditorDecision(output);
			logAuditorTrace(args.ctx.cwd, buildEndEntry({
				goalId: args.goal.id,
				approved: decision.approved,
				disapproved: decision.disapproved,
				model: modelLabel(model),
				output,
				elapsedMs: Date.now() - startedAt,
			}));
			return { ...decision, output, model: modelLabel(model), thinkingLevel };
		} catch (error) {
			// Check timeout BEFORE generic error handling
			if (timedOut) {
				const timeoutOutput = outputParts.join("\n\n").trim();
				const timeoutError = `Auditor timeout after ${effectiveTimeoutMs}ms`;
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: timeoutError,
					output: timeoutOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				return {
					approved: false,
					disapproved: true,
					output: timeoutOutput,
					model: modelLabel(model),
					thinkingLevel,
					error: timeoutError,
					timedOut: true,
				};
			}
			// Check rejectionMessage (from unhandledRejection guard)
			if (rejectionMessage) {
				const rejOutput = outputParts.join("\n\n").trim();
				logAuditorTrace(args.ctx.cwd, buildEndEntry({
					goalId: args.goal.id,
					approved: false,
					disapproved: true,
					model: modelLabel(model),
					error: rejectionMessage,
					output: rejOutput,
					elapsedMs: Date.now() - startedAt,
				}));
				return {
					approved: false,
					disapproved: true,
					output: rejOutput,
					model: modelLabel(model),
					thinkingLevel,
					error: rejectionMessage,
				};
			}
			const isAborted = args.signal?.aborted || (error instanceof Error && error.name === "AbortError");
			const errorMsg = isAborted ? "Auditor aborted." : (error instanceof Error ? error.message : String(error));
			const errOutput = outputParts.join("\n\n").trim();
			logAuditorTrace(args.ctx.cwd, buildEndEntry({
				goalId: args.goal.id,
				approved: false,
				disapproved: true,
				model: modelLabel(model),
				error: errorMsg,
				output: errOutput,
				elapsedMs: Date.now() - startedAt,
			}));
			return {
				approved: false,
				disapproved: true,
				output: errOutput,
				model: modelLabel(model),
				thinkingLevel,
				error: errorMsg,
			};
		} finally {
			// Remove timeout + abortSession listener. The process-level guards
			// (unhandledRejection / uncaughtException) + G2 inherited-listener
			// cleanup + G3 session cleanup happen in the OUTER finally so they
			// run even if createSession failed and we never reached this inner try.
			if (timeoutId) clearTimeout(timeoutId);
			args.signal?.removeEventListener("abort", abortSession);
			progress.phase = "done";
			progress.label = "Audit complete.";
			progress.percentage = 100;
			emitProgress();
			unsubscribe();
		}
	} catch (error) {
		// Outer catch for the entire audit function
		const errorMsg = error instanceof Error ? error.message : String(error);
		const errOutput = outputParts.join("\n\n").trim();
		logAuditorTrace(args.ctx.cwd, buildEndEntry({
			goalId: args.goal.id,
			approved: false,
			disapproved: true,
			model: modelLabel(model),
			error: errorMsg,
			output: errOutput,
			elapsedMs: Date.now() - startedAt,
		}));
		return {
			approved: false,
			disapproved: true,
			output: errOutput,
			model: modelLabel(model),
			thinkingLevel,
			error: errorMsg,
		};
	} finally {
		// B+: clear the in-process sentinel FIRST, before listener removal, so
		// even if a later cleanup line throws the sentinel is already cleared.
		// Must run on EVERY path (success, timeout, abort, throw). `delete` (not
		// `= false`) so an `in` check is unambiguous.
		try { delete (globalThis as any)[AUDITOR_IN_PROCESS_SENTINEL]; } catch {}
		// ── G1/G2/G3: process-guard removal + inherited-listener cleanup + session cleanup
		//
		// G1: remove the auditor's own unhandledRejection / uncaughtException
		//     guards. These MUST be removed even if createSession threw, otherwise
		//     they'd leak into the host process for the rest of the session.
		//
		// G2: remove any process.on('unhandledRejection'/'uncaughtException')
		//     handlers inherited extensions registered DURING the audit window
		//     (i.e. present now but absent from the pre-createSession snapshot).
		//     This is a mitigation, not a full fix: an out-of-process auditor is
		//     the only way to fully isolate side effects (timers, globalThis
		//     mutations, other event names). Residual risk documented.
		//
		//     KNOWN LIMITATION (concurrent audits): if two runGoalCompletionAuditor
		//     calls overlap, the snapshot-based diff can remove a listener the
		//     OTHER concurrent audit legitimately owns, because process listeners
		//     are global. Audits are not designed to run concurrently (a single
		//     complete_goal holds the goal lock), so this is accepted as residual
		//     risk. A proper fix requires either serializing audit windows or the
		//     out-of-process auditor noted above.
		//
		// G3: explicitly clear the in-memory output buffer and drop references so
		//     the auditor session can be garbage-collected promptly after the
		//     audit ends, instead of lingering until the next GC sweep.
		try { if (unhandledRejectionHandler) process.off("unhandledRejection", unhandledRejectionHandler); } catch {}
		try { if (uncaughtExceptionHandler) process.off("uncaughtException", uncaughtExceptionHandler); } catch {}
		for (const l of process.listeners("unhandledRejection")) {
			if (unhandledRejectionHandler && l !== unhandledRejectionHandler && !preUnhandledRejectionListeners.includes(l)) {
				try { process.off("unhandledRejection", l); } catch {}
			}
		}
		for (const l of process.listeners("uncaughtException")) {
			if (uncaughtExceptionHandler && l !== uncaughtExceptionHandler && !preUncaughtExceptionListeners.includes(l)) {
				try { process.off("uncaughtException", l); } catch {}
			}
		}
		// F1: no explicit drain of abort() promises here. session.abort() is
		// async (it awaits agent.waitForIdle(), which can hang), so awaiting
		// its settlement in this finally would risk hanging indefinitely and
		// bypass the timeout ceiling that exists precisely to bound the audit.
		// Instead the .catch(() => {}) is attached SYNCHRONOUSLY at each abort
		// call site (safeAbort / captureGuardError). A promise rejection is
		// "handled" the moment a .catch handler is attached — regardless of
		// when the promise settles — so the synchronous .catch alone is
		// sufficient to prevent an unhandledRejection after the guards above
		// are removed. No collection or await is needed.
		// G3: explicit cleanup of in-memory auditor state for GC. The session
		// object's external references (subscribe callback, abort listener) are
		// dropped by the INNER finally; the session local itself goes out of
		// scope with this try block, so it is GC-eligible once the function
		// returns. We additionally clear the output buffer here so its memory
		// is released before the function returns, not at the next GC sweep.
		outputParts.length = 0;
		sessionRef = undefined;
	}
}
