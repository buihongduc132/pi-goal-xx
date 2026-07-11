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
import { loadGoalSettings, type GoalSettings } from "./goal-settings.ts";
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
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}



export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	const approved = /<approved\s*\/>/.test(output);
	const disapproved = /<disapproved\s*\/>/.test(output);
	return { approved: approved && !disapproved, disapproved };
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
}): { persona: string; factLayer: string } {
	const persona = [
		"You are the independent completion auditor for pi-goal.",
		"The executor claims the goal is complete. Your job is to decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use read/grep/find/ls/bash as needed to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
		"Return a concise audit report. The final line MUST be exactly one of:",
		"<approved/>",
		"<disapproved/>",
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
	if (resolved.error) {
		return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: resolved.error };
	}
	const startedAt = Date.now();
	// G1: declare process-guard state at function scope so the guards can be
	// installed BEFORE createSession and removed in the OUTER finally below
	// (which covers every exit path, including createSession-timeout returns and
	// createSession throws — those previously leaked the handler because the
	// inner prompt-only finally never ran).
	// G3: `auditUnsubscribe` holds the session subscription so the outer finally
	// can release it on every path, dropping the callback's closure over
	// outputParts/progress and allowing GC.
	let rejectionMessage: string | undefined;
	let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;
	let uncaughtExceptionHandler: ((err: unknown) => void) | undefined;
	let auditUnsubscribe: (() => void) | undefined;
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
		const { persona: defaultPersona, factLayer } = buildAuditorPromptParts(args);
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
		});
		// cubic P1 fix: createSession must also be timeout-bounded.
		// Extension onLoad hangs during inherited resource loading would
		// otherwise stall complete_goal indefinitely. Same ceiling as prompt.
		const DEFAULT_AUDITOR_TIMEOUT_MS = 5 * 60 * 1000;
		const timeoutMs = config.auditorTimeoutMs ?? DEFAULT_AUDITOR_TIMEOUT_MS;
		let timedOut = false;

		// G1 + G2: install process-level guards BEFORE createSession is invoked.
		// Host extensions fire their onLoad handlers during createSession; an
		// unhandled rejection or uncaught exception there would otherwise hit
		// Node's default handlers and terminate the process. Previously these
		// guards were installed at line 796 (AFTER createSession) — too late.
		// G2 mitigation: we also snapshot the process listeners before/after and
		// the outer finally removes any handlers we added, so no global listener
		// is left behind.
		unhandledRejectionHandler = (reason: unknown) => {
			const isAbortError = reason instanceof Error && reason.name === "AbortError";
			if (isAbortError) {
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "unhandledRejection",
					goalId: args.goal.id,
					reason: "AbortError (benign — swallowed)",
				});
				return;
			}
			const msg = reason instanceof Error ? reason.message : String(reason);
			rejectionMessage = `Auditor inherited-resource rejection: ${msg}`;
			logAuditorTrace(args.ctx.cwd, {
				ts: new Date().toISOString(),
				phase: "unhandledRejection",
				goalId: args.goal.id,
				reason: msg,
				stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
			});
		};
		uncaughtExceptionHandler = (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			rejectionMessage = `Auditor inherited-resource exception: ${msg}`;
			logAuditorTrace(args.ctx.cwd, {
				ts: new Date().toISOString(),
				phase: "uncaughtException",
				goalId: args.goal.id,
				reason: msg,
				stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
			});
		};
		process.on("unhandledRejection", unhandledRejectionHandler);
		process.on("uncaughtException", uncaughtExceptionHandler);

		let session: Awaited<ReturnType<typeof createSession>>["session"];
		try {
			let csTimeoutId: ReturnType<typeof setTimeout>;
			const created = await Promise.race([
				createSession({
					cwd: args.ctx.cwd,
					model,
					thinkingLevel,
					modelRegistry: args.ctx.modelRegistry,
					resourceLoader: makeAuditorResourceLoader(resolved, mainResourceLoader),
					sessionManager: SessionManager.inMemory(args.ctx.cwd),
					settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
					tools: resolved.tools,
					customTools: [reportProgressTool],
				}),
				new Promise<never>((_, reject) => {
					csTimeoutId = setTimeout(() => reject(new Error("__auditor_cs_timeout__")), timeoutMs);
				}),
			]);
			clearTimeout(csTimeoutId!);
			session = created.session;
		} catch (createError) {
			if (createError instanceof Error && createError.message === "__auditor_cs_timeout__") {
				timedOut = true;
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "timeout",
					goalId: args.goal.id,
					timeoutMs,
					source: "createSession",
				});
				return {
					approved: false,
					disapproved: true,
					output: "",
					model: modelLabel(model),
					thinkingLevel,
					error: `Auditor timeout during session creation after ${timeoutMs}ms`,
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
			} catch {
				// trace logging must never crash the audit
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
				// Capture text from text_end stream events — the verdict text lives
				// here, not in message_end's finalMessage (pi-core can drop text
				// content from the finalized message at message_end).
				if (streamEvent?.type === "text_end") {
					const textContent = streamEvent.content ?? streamEvent?.partial?.content?.[0]?.text;
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
		// B6: set a local `aborted` flag so emitProgress stops writing to the
		// caller's progress state after abort. Without this, late events from
		// the session (which may fire after session.abort() returns) would
		// resurrect the nulled auditProgress in the caller.
		let aborted = args.signal?.aborted ?? false;
		const abortSession = () => { aborted = true; session.abort(); };
		args.signal?.addEventListener("abort", abortSession, { once: true });
		// G3: expose the session unsubscribe to the outer finally so the
		// subscription (and the callback's closure over outputParts/progress) is
		// released on EVERY exit path, not just the prompt-window one.
		auditUnsubscribe = unsubscribe;

		// ── Bug 1a fix: auditor timeout ──────────────────────────────────────
		// Hard ceiling on audit duration to prevent indefinite hangs from
		// inherited extensions that never resolve. Configurable via
		// settings.auditorTimeoutMs (default 5 minutes). On timeout: abort
		// session, set timedOut flag, return {approved:false, error:"Auditor timeout"}.
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		// G1: the unhandledRejection + uncaughtException guards are now installed
		// BEFORE createSession (see above) and removed in the OUTER finally. The
		// inner try only needs the prompt timeout.

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
			// Install the prompt timeout. The process guards were already
			// installed before createSession (G1) and are removed by the outer
			// finally (G2/G3).
			timeoutId = setTimeout(() => {
				timedOut = true;
				logAuditorTrace(args.ctx.cwd, {
					ts: new Date().toISOString(),
					phase: "timeout",
					goalId: args.goal.id,
					timeoutMs,
				});
				session.abort();
			}, Math.max(0, timeoutMs - (Date.now() - startedAt)));
			// R2.4a: catch AbortError from abort teardown so it doesn't escape as unhandled.
			// Generic errors MUST propagate to the catch block for proper error handling.
			await session.prompt(resolvedPrompt.prompt).catch((err: unknown) => {
				// Only swallow AbortError (from abort). All other errors propagate.
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
				const timeoutError = `Auditor timeout after ${timeoutMs}ms`;
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
				const timeoutError = `Auditor timeout after ${timeoutMs}ms`;
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
			// Remove the prompt timeout. The process guards are removed by the
			// OUTER finally (G1/G2) so this inner finally only owns prompt-scoped state.
			if (timeoutId) clearTimeout(timeoutId);
			args.signal?.removeEventListener("abort", abortSession);
			progress.phase = "done";
			progress.label = "Audit complete.";
			progress.percentage = 100;
			emitProgress();
			unsubscribe();
			// G3: the inner finally has released the subscription; clear the handle
			// so the outer finally doesn't double-call it.
			auditUnsubscribe = undefined;
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
	}
	// G1/G2/G3 outer finally — runs on EVERY exit path (happy, prompt-error,
	// createSession-timeout early-return, createSession-throw). Removes the
	// process guards we added at the top and releases the session subscription.
	//
	// G2 residual-risk note: this is a MITIGATION, not a full fix. The
	// in-process auditor loads host extensions that may register their OWN
	// process listeners / mutate global state during onLoad; we cannot
	// enumerate or remove handlers we did not add. The authoritative fix is an
	// out-of-process auditor (design change). Here we only guarantee our OWN
	// handlers (unhandledRejection + uncaughtException) are removed, so the
	// auditor never *leaks* the guards it installed for itself.
	finally {
		if (unhandledRejectionHandler) process.off("unhandledRejection", unhandledRejectionHandler);
		if (uncaughtExceptionHandler) process.off("uncaughtException", uncaughtExceptionHandler);
		// G3: release the session subscription + clear accumulated output so
		// the closure graph is eligible for GC once the audit returns.
		try { auditUnsubscribe?.(); } catch { /* best-effort */ }
		outputParts.length = 0;
	}
}
