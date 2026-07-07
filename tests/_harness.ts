/**
 * Shared test harness: minimal faithful mock of the pi ExtensionAPI + ExtensionContext.
 *
 * Captures all registrations (tools, commands, event handlers, message renderers)
 * so tests can introspect and INVOKE them. The goal is to let the real goal.ts
 * extension be loaded and exercised without a running pi process.
 *
 * Design principles:
 *  - Record-only by default: handlers are stored, never auto-fired.
 *  - Lazy defaults: ctx fields return safe values unless overridden per-call.
 *  - Expose invocation helpers (invokeTool, emit, etc.) so tests drive logic.
 *  - NO network / NO real model / NO TUI rendering.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CapturedTool {
	name: string;
	definition: ToolDefinition<any, any, any>;
}

export interface CapturedCommand {
	name: string;
	options: any;
}

export type EventHandler = (event: any, ctx: any) => Promise<any> | any;

export interface CapturedMessage {
	customType: string;
	content?: unknown;
	display?: boolean;
	details?: unknown;
	options?: any;
}

export interface MockPiOptions {
	cwd?: string;
	hasUI?: boolean;
	activeTools?: string[];
}

export function createMockPi(options: MockPiOptions = {}): ExtensionAPI & {
	tools: Map<string, CapturedTool>;
	commands: Map<string, CapturedCommand>;
	handlers: Map<string, EventHandler[]>;
	renderers: Map<string, Function>;
	sentMessages: CapturedMessage[];
	userMessages: Array<string | unknown[]>;
	appendedEntries: Array<{ customType: string; data?: unknown }>;
	flags: Map<string, boolean | string>;
	ui: MockUI;
} {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<string, EventHandler[]>();
	const renderers = new Map<string, Function>();
	const sentMessages: CapturedMessage[] = [];
	const userMessages: Array<string | unknown[]> = [];
	const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	const flags = new Map<string, boolean | string>();

	const ui = createMockUI();

	let activeTools = options.activeTools ? [...options.activeTools] : [
		"read", "write", "edit", "bash", "grep", "find", "ls", "glob",
	];

	const api: any = {
		tools,
		commands,
		handlers,
		renderers,
		sentMessages,
		userMessages,
		appendedEntries,
		flags,
		ui,
	};

	api.on = (event: string, handler: EventHandler) => {
		const arr = handlers.get(event) ?? [];
		arr.push(handler);
		handlers.set(event, arr);
	};
	api.registerTool = (def: ToolDefinition<any, any, any>) => {
		const name = (def as any)?.name ?? (def as any)?.description?.name;
		tools.set(name, { name, definition: def });
	};
	api.registerCommand = (name: string, opts: any) => {
		commands.set(name, { name, options: opts });
	};
	api.registerShortcut = () => {};
	api.registerFlag = (name: string, opts: any) => {
		if (opts?.default !== undefined) flags.set(name, opts.default);
	};
	api.getFlag = (name: string) => flags.get(name);
	api.registerMessageRenderer = (customType: string, renderer: Function) => {
		renderers.set(customType, renderer);
	};
	api.sendMessage = (message: any, options?: any) => {
		sentMessages.push({
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			options,
		});
	};
	api.sendUserMessage = (content: string | unknown[], _options?: any) => {
		userMessages.push(content);
	};
	api.appendEntry = (customType: string, data?: unknown) => {
		appendedEntries.push({ customType, data });
	};
	api.setSessionName = () => {};
	api.getSessionName = () => undefined;
	api.setLabel = () => {};
	api.exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
	api.getActiveTools = () => [...activeTools];
	api.getAllTools = () => [];
	api.setActiveTools = (names: string[]) => { activeTools = [...names]; };
	api.getCommands = () => [];
	api.setModel = async () => true;
	api.getThinkingLevel = () => "medium" as any;
	api.setThinkingLevel = () => {};
	api.registerProvider = () => {};
	api.getStateDir = () => options.cwd ?? "/tmp";
	api.getSessionFile = () => "/tmp/session.jsonl";

	return api;
}

export interface MockUI extends ExtensionUIContext {
	notifyCalls: Array<{ msg: string; kind?: string }>;
	statusSet: Array<{ msg?: string }>;
	widgets: Array<{ id: string; node: unknown }>;
	selectAnswers: Array<unknown>;
	inputAnswers: Array<unknown>;
	confirmAnswers: Array<boolean>;
}

function createMockUI(): MockUI {
	return {
		notifyCalls: [],
		statusSet: [],
		widgets: [],
		selectAnswers: [],
		inputAnswers: [],
		confirmAnswers: [],
		notify(msg: any, kind?: any) { this.notifyCalls.push({ msg, kind }); },
		setStatus(msg?: any) { this.statusSet.push({ msg }); },
		clearStatus() {},
		setWidget(id: string, node: unknown) { this.widgets.push({ id, node }); },
		clearWidget(_id: string) {},
		async select(items: any[], _opts?: any) {
			const ans = this.selectAnswers.shift();
			return ans ?? (items[0] ?? null);
		},
		async multiSelect(items: any[], _opts?: any) {
			const ans = this.selectAnswers.shift();
			return ans ?? items;
		},
		async input(_prompt: string, _opts?: any) {
			return this.inputAnswers.shift() ?? "";
		},
		async confirm(_prompt: string, _opts?: any) {
			return this.confirmAnswers.shift() ?? false;
		},
		onTerminalInput() {},
		setWorking() {},
		clearWorking() {},
		// ctx.ui.custom<GoalQuestionnaireResult>((tui, theme, kb, done) => {...})
		// Return a confirm-shaped result WITHOUT invoking the real render callback
		// (render starts Editor render-loop intervals that would leak and hang the
		// test runner). Tests that need a non-confirm result can pre-push into
		// selectAnswers / confirmAnswers.
		custom<Res = unknown>(_render?: unknown): Res {
			return { questions: [], answers: [{ questionId: "confirm", answer: "Confirm — create this goal now" }], cancelled: false, auditorEnabled: true } as unknown as Res;
		},
	} as any;
}

export interface MockCtxOptions {
	cwd?: string;
	hasUI?: boolean;
	idle?: boolean;
	systemPrompt?: string;
	sessionManager?: any;
	mode?: string;
}

/**
 * Build an ExtensionContext for invoking a captured tool/command/event handler.
 * `pi.ui` is shared so notifications/selections are recorded.
 */
export function createMockCtx(pi: ReturnType<typeof createMockPi>, opts: MockCtxOptions = {}): ExtensionContext {
	const controller = new AbortController();
	const ctx: any = {
		ui: pi.ui,
		hasUI: opts.hasUI ?? true,
		cwd: opts.cwd ?? pi.getStateDir(),
		sessionManager: opts.sessionManager ?? { getBranch: () => [] as any[] } as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => opts.idle ?? true,
		signal: opts.idle === false ? controller.signal : undefined,
		abort: () => controller.abort(),
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => opts.systemPrompt ?? "",
	};
	if (opts.mode !== undefined) {
		ctx.mode = opts.mode;
	}
	return ctx as ExtensionContext;
}

/**
 * Invoke a tool handler captured during extension load.
 * Returns the tool's execute() result. Throws if the tool name is not registered.
 *
 * The real defineTool execute signature is:
 *   execute(toolCallId, params, signal, onUpdate, ctx)
 */
export async function invokeTool(
	pi: ReturnType<typeof createMockPi>,
	ctx: ExtensionContext,
	name: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	const captured = pi.tools.get(name);
	if (!captured) throw new Error(`Tool not registered: ${name}. Registered: ${[...pi.tools.keys()].join(", ")}`);
	const execute = (captured.definition as any).execute;
	if (typeof execute !== "function") throw new Error(`Tool ${name} has no execute()`);
	const controller = new AbortController();
	return execute(`tcall_${name}`, params, controller.signal, undefined, ctx);
}

/**
 * Emit an event to all captured handlers for that event name.
 * Returns an array of handler results (undefined for void handlers).
 */
export async function emit(
	pi: ReturnType<typeof createMockPi>,
	ctx: ExtensionContext,
	event: string,
	payload: unknown = {},
): Promise<unknown[]> {
	const list = pi.handlers.get(event) ?? [];
	const out: unknown[] = [];
	for (const h of list) out.push(await h(payload, ctx));
	return out;
}

/**
 * Get all registered tool names (sorted), for assertions.
 */
/**
 * Invoke a slash command captured during extension load.
 * `rawArgs` is the command's argument string.
 */
export async function invokeCommand(
	pi: ReturnType<typeof createMockPi>,
	ctx: ExtensionContext,
	name: string,
	rawArgs: string = "",
): Promise<unknown> {
	const captured = pi.commands.get(name);
	if (!captured) throw new Error(`Command not registered: ${name}`);
	const handler = captured.options?.handler;
	if (typeof handler !== "function") throw new Error(`Command ${name} has no handler`);
	return handler(rawArgs, ctx);
}

/**
 * Convenience: create a goal immediately via the /goals-set command (no dialog).
 */
export async function createGoalViaCommand(
	pi: ReturnType<typeof createMockPi>,
	ctx: ExtensionContext,
	objective: string,
	sisyphus = false,
): Promise<unknown> {
	return invokeCommand(pi, ctx, sisyphus ? "sisyphus-set" : "goals-set", objective);
}

export function registeredToolNames(pi: ReturnType<typeof createMockPi>): string[] {
	return [...pi.tools.keys()].sort();
}

export function registeredCommandNames(pi: ReturnType<typeof createMockPi>): string[] {
	return [...pi.commands.keys()].sort();
}

/**
 * Clear goal.ts internal timers (status refresh, continuation, audit animation)
 * by emitting session_shutdown. Call in afterEach to prevent the test runner
 * from hanging on leaked setInterval handles.
 */
export async function cleanupTimers(
	pi: ReturnType<typeof createMockPi>,
	cwd: string,
): Promise<void> {
	try {
		const ctx = createMockCtx(pi, { cwd });
		const list = pi.handlers.get("session_shutdown") ?? [];
		for (const h of list) await h({}, ctx);
	} catch {
		// best-effort
	}
}

/**
 * Write an active goal .md file under <cwd>/.pi/goals in the format
 * readActiveGoalPool / normalizeGoalRecord expects (JSON header + markdown).
 * Mirrors the on-disk layout the goal extension reads at session_start.
 */
export interface WriteGoalOpts {
	id: string;
	objective?: string;
	status?: string;
	autoContinue?: boolean;
	sisyphus?: boolean;
}
export function writeGoalFile(cwd: string, opts: WriteGoalOpts): string {
	const id = opts.id;
	const objective = opts.objective ?? `Objective: ${id}. Success criteria: done.`;
	const status = opts.status ?? "active";
	const autoContinue = opts.autoContinue ?? true;
	const sisyphus = opts.sisyphus ?? false;
	const record = {
		version: 3,
		id,
		status,
		sisyphus,
		autoContinue,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		activePath: `.pi/goals/active_goal_20260101_${id}.md`,
	};
	const content = `${JSON.stringify(record, null, 2)}\n\n# Goal Prompt\n\n${objective}\n\n## Progress\n\n- Status: ${status}\n- Auto-continue: ${autoContinue ? "on" : "off"}\n- Sisyphus mode: ${sisyphus ? "yes" : "no"}\n`;
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	const filePath = path.join(cwd, ".pi", "goals", `active_goal_20260101_${id}.md`);
	fs.writeFileSync(filePath, content);
	return filePath;
}

/**
 * Await macrotasks so any unref'd continuation timers (setTimeout(...,0) in
 * queueContinuation/sendQueuedContinuation) have a chance to fire before the
 * test asserts on sentMessages.
 */
export async function flushContinuation(ms = 25): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count continuation messages the extension emitted. A queued+-fired
 * continuation calls pi.sendMessage with customType "pi-goal-event"
 * (GOAL_EVENT_ENTRY) and triggerTurn:true. Returns the number observed.
 */
export function countContinuations(pi: ReturnType<typeof createMockPi>): number {
	return pi.sentMessages.filter((m) => m.customType === "pi-goal-event").length;
}

/**
 * True iff at least one continuation message fired (auto-run was NOT blocked
 * by the queueContinuation chokepoint).
 */
export function continuationFired(pi: ReturnType<typeof createMockPi>): boolean {
	return countContinuations(pi) > 0;
}

/**
 * Resolve the focused-goal id the extension currently holds, by invoking the
 * get_goal tool and parsing the returned text. Returns null when no goal is
 * focused (text indicates unfocused).
 */
export async function focusedGoalIdViaTool(
	pi: ReturnType<typeof createMockPi>,
	ctx: ExtensionContext,
): Promise<string | null> {
	const result = await invokeTool(pi, ctx, "get_goal", {});
	const text = (result as any)?.content?.[0]?.text ?? "";
	if (!text || text.includes("No goal") || text.includes("No active goal") || text.includes("unfocused")) return null;
	// Goal records contain their id; match the first 8+ char alphanumeric token.
	const match = text.match(/\b([a-z0-9][a-z0-9-]{6,})\b/i);
	return match ? match[1] : null;
}

/**
 * Env vars that affect goal-focus resolution and MUST be controlled in tests.
 * Tests run inside environments where PI_TEAMS_WORKER may be set (e.g. when the
 * suite is executed by a team-worker agent). The production code's
 * isWorkerSession() / autoFocus gates read these, so each test must pin them.
 */
export const GOAL_ENV_KEYS = ["PI_TEAMS_WORKER", "PI_GOAL_AUTO_FOCUS"] as const;

export interface EnvSnapshot {
	[key: string]: string | undefined;
}

/** Snapshot the current values of GOAL_ENV_KEYS for later restore. */
export function snapshotGoalEnv(): EnvSnapshot {
	const snap: EnvSnapshot = {};
	for (const key of GOAL_ENV_KEYS) snap[key] = process.env[key];
	return snap;
}

/**
 * Force the process to look like a NON-worker, single-session pi for the
 * duration of a test: PI_TEAMS_WORKER deleted and PI_GOAL_AUTO_FOCUS deleted
 * (so the LD3 default 'resume' applies). Returns the prior snapshot.
 */
export function forceNonWorkerEnv(): EnvSnapshot {
	const snap = snapshotGoalEnv();
	delete process.env.PI_TEAMS_WORKER;
	delete process.env.PI_GOAL_AUTO_FOCUS;
	return snap;
}

/** Restore a snapshot produced by snapshotGoalEnv / forceNonWorkerEnv. */
export function restoreGoalEnv(snap: EnvSnapshot): void {
	for (const key of GOAL_ENV_KEYS) {
		if (snap[key] === undefined) delete process.env[key];
		else process.env[key] = snap[key];
	}
}

