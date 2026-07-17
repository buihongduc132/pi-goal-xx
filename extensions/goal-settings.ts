/**
 * Unified global goal settings.
 *
 * Reads `.pi/pi-goal-xx-settings.json` with env var overrides:
 *   PI_GOAL_DISABLE_TASKS     — "true" to disable, any other value = use file config
 *   PI_GOAL_DISABLE_CONTRACTS — "true" to disable, any other value = use file config
 *   PI_GOAL_DISABLED_TOOLS    — comma-separated list of tool names to hide entirely
 *   PI_GOAL_SETTINGS_FILE     — alternative settings file path (relative to cwd or absolute)
 *   PI_GOAL_LOG_LEVEL         — trace log level override: off|error|warn|info|debug
 *   PI_GOAL_AUDITOR_TIMEOUT_MS       — auditor timeout in ms (default 900000 = 15min)
 *   PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS — minimum auditor timeout floor in ms (default 1000 = 1s)
 *
 * The file may contain:
 *   disableTasks, disableContracts, subtaskDepth,
 *   provider, model, thinkingLevel, disabled,
 *   disabledTools (string[]), auditorSubscriptions (AuditorSubscription[]),
 *   auditorMode ("inherit" | "minimal"), auditorExclude (AuditorResourceFilter),
 *   auditorInclude (AuditorResourceFilter),
 *   auditorPromptMode ("global-local" | "local" | "global-local-merge"),
 *   auditorPrompt (inline string override),
 *   goalPromptMode ("global-local" | "local" | "global-local-merge"),
 *   goalPrompt (inline string override — injected into runtime goal/continuation prompts),
 *   auditorTimeoutMs (number), auditorTimeoutFloorMs (number)
 *
 * additionalProperties: false — unknown keys are rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PromptConfig, PromptMode } from "./prompt-resolver.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Auditor operational mode. */
export type AuditorMode = "inherit" | "minimal";

/** Auditor prompt resolution mode. */
export type AuditorPromptMode = "global-local" | "local" | "global-local-merge";

/** Goal prompt resolution mode (supports all unified modes including override). */
export type GoalPromptMode = PromptMode;

/** Resource filter applied to tools / mcp / skills / extensions arrays. */
export interface AuditorResourceFilter {
	tools?: string[];
	mcp?: string[];
	skills?: string[];
	extensions?: string[];
}

/**
 * Subscription entry: when `event` fires, asynchronously forward to the auditor.
 * `event` may be any string — unmatched event names are silently skipped.
 * `mode` is currently restricted to "async" (sync invocation is not supported yet).
 */
export interface AuditorSubscription {
	event: string;
	mode: "async";
}

/** Per-command hook configuration. */
export interface CommandHookConfig {
	/** "append" wraps built-in with pre/post; "override" replaces it. */
	mode?: "append" | "override";
	/** Prompt-only text (never evaluated as JS) appended before the command. */
	preInline?: string;
	/** Prompt-only text (never evaluated as JS) appended after the command. */
	postInline?: string;
}

/** commandHooks block: gated by `enabled` (default false). */
export interface CommandHooksConfig {
	/** MUST be explicitly true to load any hooks. Defaults false. */
	enabled?: boolean;
	/** Per-command overrides keyed by command name (e.g. "goals", "goal-abort"). */
	[command: string]: boolean | CommandHookConfig | undefined;
}

export interface GoalSettings {
	disableTasks?: boolean;
	disableContracts?: boolean;
	subtaskDepth?: number;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
	/** Tool names to hide entirely (never registered, agent never sees them). */
	disabledTools?: string[];
	/** Events that should be asynchronously forwarded to the auditor. */
	auditorSubscriptions?: AuditorSubscription[];
	/** Auditor operational mode. Defaults to "inherit". */
	auditorMode?: AuditorMode;
	/** Resources to exclude in "inherit" mode (glob patterns allowed). */
	auditorExclude?: AuditorResourceFilter;
	/** Resources to include in "minimal" mode (glob patterns allowed). */
	auditorInclude?: AuditorResourceFilter;
	/** Auditor prompt resolution mode. Defaults to "global-local". */
	auditorPromptMode?: AuditorPromptMode;
	/** Inline auditor prompt override; takes precedence over file-based prompts. */
	auditorPrompt?: string;
	/** Goal custom prompt resolution mode. Defaults to "global-local". */
	goalPromptMode?: GoalPromptMode;
	/** Inline goal custom prompt override; injected into runtime goal/continuation prompts. */
	goalPrompt?: string;
	/** Goal focus lock lease duration in ms. Default 180000 (3 min). */
	leaseMs?: number;
	/** Heartbeat refresh interval in ms. Default 60000 (60s). */
	heartbeatMs?: number;
	/** UNIFIED: per-key prompt config (key → {mode, inline}). */
	prompts?: Record<string, PromptConfig>;
	/** UNIFIED: override the prompts directory (default `.pi/pi-goal-xx/prompts/`). */
	promptsDir?: string;
	/**
	 * UNIFIED: per-tool-instruction replacement config (keyed by tool name).
	 * Only consulted when the tool is in `disabledTools`. The default instruction
	 * for a disabled tool is suppressed; this provides a replacement via
	 * `resolvePrompt("tool-instruction-<name>", cfg, ...)`. See
	 * openspec/changes/add-prompt-tool-instruction-config/.
	 */
	toolInstructions?: Record<string, PromptConfig>;
	/** UNIFIED: per-command pre/post/override hooks. Default off. */
	commandHooks?: CommandHooksConfig;
	/** UNIFIED: override the hooks directory (default `.pi/pi-goal-xx/hooks/`). */
	hooksDir?: string;
	/** UNIFIED: enable `{{snippet}}` expansion in verification contracts. Default true. */
	contractTemplates?: boolean;
	/** UNIFIED: override the contracts directory (default `.pi/pi-goal-xx/contracts/`). */
	contractsDir?: string;
	/** Auditor timeout in milliseconds. Default 900000 (15 minutes). */
	auditorTimeoutMs?: number;
	/** Auditor timeout floor in milliseconds. Prevents config typos from instant-aborting. Default 1000 (1s). */
	auditorTimeoutFloorMs?: number;
	/**
	 * Operational trace logging. Controls the rotating `goal-trace.jsonl`
	 * (tool/command spans, focus-lock ops, heartbeat, hook dispatch). Default
	 * level is "info"; "off" disables all trace writes. Never affects the
	 * event-sourced goal_events.jsonl ledger or auditor-trace.jsonl.
	 */
	logging?: GoalLoggingConfig;
}

/**
 * Trace logging configuration. Mirrors the goal-trace sink config.
 *   - level: minimum severity to emit. "off" disables tracing entirely.
 *     Ordered: off < error < warn < info < debug. Default "info".
 *   - toStderr: mirror every emitted trace line to stderr for live debugging.
 *     Default false.
 */
export interface GoalLoggingConfig {
	level?: "off" | "error" | "warn" | "info" | "debug";
	toStderr?: boolean;
}

/** Default auditor timeout ceiling: 15 minutes. Configurable via auditorTimeoutMs / PI_GOAL_AUDITOR_TIMEOUT_MS. */
export const DEFAULT_AUDITOR_TIMEOUT_MS = 15 * 60 * 1000;
/** Default auditor timeout floor: 1 second. Configurable via auditorTimeoutFloorMs / PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS. */
export const DEFAULT_AUDITOR_TIMEOUT_FLOOR_MS = 1_000;

export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";
/** Env override for the trace log level: off|error|warn|info|debug. Takes precedence over file config. */
export const PI_GOAL_LOG_LEVEL_ENV = "PI_GOAL_LOG_LEVEL";
/** Env override for auditor timeout in ms. */
export const PI_GOAL_AUDITOR_TIMEOUT_MS_ENV = "PI_GOAL_AUDITOR_TIMEOUT_MS";
/** Env override for auditor timeout floor in ms. */
export const PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV = "PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const ALLOWED_SETTINGS_KEYS = new Set([
	"disableTasks",
	"disableContracts",
	"subtaskDepth",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"disabled",
	"disabledTools",
	"auditorSubscriptions",
	"auditorMode",
	"auditorExclude",
	"auditorInclude",
	"auditorPromptMode",
	"auditorPrompt",
	"goalPromptMode",
	"goalPrompt",
	"leaseMs",
	"heartbeatMs",
	"prompts",
	"promptsDir",
	"toolInstructions",
	"commandHooks",
	"hooksDir",
	"contractTemplates",
	"contractsDir",
	"auditorTimeoutMs",
	"auditorTimeoutFloorMs",
	"logging",
]);

const AUDITOR_MODES = new Set<AuditorMode>(["inherit", "minimal"]);
const AUDITOR_PROMPT_MODES = new Set<AuditorPromptMode>([
	"global-local",
	"local",
	"global-local-merge",
]);

/** All six unified prompt resolution modes. */
const UNIFIED_PROMPT_MODES = new Set<PromptMode>([
	"override",
	"append",
	"global-local",
	"local",
	"global-local-merge",
	"off",
]);

/**
 * Known runtime prompt keys. Tool-prompt overrides use the `tool-<toolName>`
 * pattern and are matched by prefix rather than enumeration.
 */
const KNOWN_PROMPT_KEYS = new Set([
	"goal",
	"goal-running",
	"goal-continuation",
	"goal-drafting",
	"goal-tweak",
	"goal-stale",
	"goal-unfocused",
	"auditor",
]);

/** Is `key` a recognized prompt key (enumerated or `tool-*`)? */
function isKnownPromptKey(key: string): boolean {
	return KNOWN_PROMPT_KEYS.has(key) || key.startsWith("tool-");
}

/** Validate + coerce a raw prompt config entry into PromptConfig. Throws on invalid. */
function asPromptConfig(key: string, raw: unknown): PromptConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const knownNested = new Set(["mode", "inline"]);
	const unknownNested = Object.keys(rec).filter((k) => !knownNested.has(k));
	if (unknownNested.length > 0) {
		throw new Error(
			`Unknown prompts.${key} nested key(s): ${unknownNested.join(", ")}`,
		);
	}
	const cfg: PromptConfig = {};
	const inline = asNonEmptyString(rec.inline);
	if (inline) cfg.inline = inline;
	if (rec.mode !== undefined) {
		const mode = asNonEmptyString(rec.mode);
		if (!mode || !UNIFIED_PROMPT_MODES.has(mode as PromptMode)) {
			throw new Error(
				`Invalid prompts.${key}.mode: ${String(rec.mode)} (must be one of ${[...UNIFIED_PROMPT_MODES].join(", ")})`,
			);
		}
		cfg.mode = mode as PromptMode;
	}
	return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/** Validate + coerce the prompts block. Throws on unknown keys / invalid shapes. */
function asPromptsBlock(raw: unknown): Record<string, PromptConfig> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const out: Record<string, PromptConfig> = {};
	for (const [key, val] of Object.entries(rec)) {
		if (!isKnownPromptKey(key)) {
			throw new Error(`Unknown prompt key: ${key}`);
		}
		const cfg = asPromptConfig(key, val);
		if (cfg) out[key] = cfg;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate + coerce the `toolInstructions` block.
 * Each entry is a tool name → PromptConfig. Unlike `prompts`, tool keys are
 * NOT enumerated (any non-empty string accepted — future-proof). Each entry
 * is validated via asPromptConfig with the nested-key check.
 * Returns undefined for empty input.
 */
function asToolInstructionsBlock(raw: unknown): Record<string, PromptConfig> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const out: Record<string, PromptConfig> = {};
	for (const [key, val] of Object.entries(rec)) {
		if (!key) continue;
		const cfg = asPromptConfig(`toolInstructions.${key}`, val);
		if (cfg) out[key] = cfg;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const LOGGING_LEVELS = new Set(["off", "error", "warn", "info", "debug"]);

/** Validate + coerce the logging block. Throws on unknown nested keys / invalid level. */
function asLoggingConfig(raw: unknown): GoalLoggingConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const knownNested = new Set(["level", "toStderr"]);
	const unknownNested = Object.keys(rec).filter((k) => !knownNested.has(k));
	if (unknownNested.length > 0) {
		throw new Error(
			`Unknown logging nested key(s): ${unknownNested.join(", ")}`,
		);
	}
	const cfg: GoalLoggingConfig = {};
	if (rec.level !== undefined) {
		const level = typeof rec.level === "string" ? rec.level.toLowerCase() : "";
		if (!LOGGING_LEVELS.has(level)) {
			throw new Error(
				`Invalid logging.level: ${String(rec.level)} (must be one of ${[...LOGGING_LEVELS].join(", ")})`,
			);
		}
		cfg.level = level as GoalLoggingConfig["level"];
	}
	if (rec.toStderr === true || rec.toStderr === "true") cfg.toStderr = true;
	else if (rec.toStderr === false || rec.toStderr === "false") cfg.toStderr = false;
	return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/** Validate + coerce the commandHooks block. */
function asCommandHooksBlock(raw: unknown): CommandHooksConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const out: CommandHooksConfig = {};
	if (rec.enabled === true || rec.enabled === "true") out.enabled = true;
	else out.enabled = false; // default false when block present
	for (const [cmd, val] of Object.entries(rec)) {
		if (cmd === "enabled") continue;
		if (val === true) {
			out[cmd] = { mode: "append" };
			continue;
		}
		if (val === false) continue;
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const cRec = val as Record<string, unknown>;
		const knownHookNested = new Set(["mode", "preInline", "postInline"]);
		const unknownHookNested = Object.keys(cRec).filter((k) => !knownHookNested.has(k));
		if (unknownHookNested.length > 0) {
			throw new Error(
				`Unknown commandHooks.${cmd} nested key(s): ${unknownHookNested.join(", ")}`,
			);
		}
		const cfg: CommandHookConfig = {};
		const mode = asNonEmptyString(cRec.mode);
		if (mode) {
			if (mode !== "append" && mode !== "override") {
				throw new Error(
					`Invalid commandHooks.${cmd}.mode: ${mode} (must be append or override)`,
				);
			}
			cfg.mode = mode as CommandHookConfig["mode"];
		}
		const preInline = asNonEmptyString(cRec.preInline);
		if (preInline) cfg.preInline = preInline;
		const postInline = asNonEmptyString(cRec.postInline);
		if (postInline) cfg.postInline = postInline;
		if (Object.keys(cfg).length > 0) out[cmd] = cfg;
	}
	return out;
}

/**
 * Resolve the path to the unified settings file.
 * Uses `PI_GOAL_SETTINGS_FILE` env var if set (relative to cwd or absolute).
 * Otherwise defaults to `.pi/pi-goal-xx-settings.json`.
 */
export function goalSettingsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = asNonEmptyString(env[PI_GOAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? override : path.join(cwd, override);
	}
	return path.join(cwd, ".pi", "pi-goal-xx-settings.json");
}

/**
 * Resolve the path to the GLOBAL settings file.
 * If PI_CODING_AGENT_DIR is set → dirname(agentDir) + "/pi-goal-xx-settings.json".
 * Otherwise → ~/.pi/pi-goal-xx-settings.json.
 */
export function globalGoalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = asNonEmptyString(env.PI_CODING_AGENT_DIR);
	if (agentDir) {
		return path.join(path.dirname(agentDir), "pi-goal-xx-settings.json");
	}
	return path.join(os.homedir(), ".pi", "pi-goal-xx-settings.json");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 1) return n;
	}
	return undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

/**
 * Coerce unknown value into a string[]. Accepts array of strings or a
 * comma/whitespace-separated string. Returns undefined if not coercible.
 * Empty strings are dropped. Duplicates are preserved (callers de-dup if needed).
 */
function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const v of value) {
			const s = typeof v === "string" ? v.trim() : "";
			if (s) out.push(s);
		}
		return out.length > 0 ? out : undefined;
	}
	if (typeof value === "string") {
		const parts = value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
		return parts.length > 0 ? parts : undefined;
	}
	return undefined;
}

/**
 * Coerce unknown value into AuditorSubscription[]. Each entry must have a
 * non-empty `event` string and `mode` === "async". Entries that don't match
 * are silently dropped (treated as unmatched config).
 */
function asAuditorSubscriptions(value: unknown): AuditorSubscription[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: AuditorSubscription[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const event = asNonEmptyString(rec.event);
		const mode = asNonEmptyString(rec.mode);
		if (!event) continue;
		// Only "async" is currently supported; unknown modes silently dropped.
		if (mode !== "async") continue;
		out.push({ event, mode: "async" });
	}
	return out.length > 0 ? out : undefined;
}

/** Parse auditorMode; invalid values fall back to undefined (caller defaults to "inherit"). */
function asAuditorMode(value: unknown): AuditorMode | undefined {
	const text = asNonEmptyString(value);
	return text && AUDITOR_MODES.has(text as AuditorMode) ? (text as AuditorMode) : undefined;
}

/** Parse auditorPromptMode; invalid values fall back to undefined (caller defaults to "global-local"). */
function asAuditorPromptMode(value: unknown): AuditorPromptMode | undefined {
	const text = asNonEmptyString(value);
	return text && AUDITOR_PROMPT_MODES.has(text as AuditorPromptMode)
		? (text as AuditorPromptMode)
		: undefined;
}

/** Parse goalPromptMode; accepts all unified PromptMode values including "override". */
function asGoalPromptMode(value: unknown): GoalPromptMode | undefined {
	const text = asNonEmptyString(value);
	return text && UNIFIED_PROMPT_MODES.has(text as PromptMode)
		? (text as GoalPromptMode)
		: undefined;
}

/**
 * Coerce unknown value into an AuditorResourceFilter. Each of the four arrays
 * (tools/mcp/skills/extensions) is independently parsed via asStringArray.
 * Returns undefined if no array yielded any entries.
 */
function asAuditorResourceFilter(value: unknown): AuditorResourceFilter | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const rec = value as Record<string, unknown>;
	const filter: AuditorResourceFilter = {};
	const tools = asStringArray(rec.tools);
	if (tools) filter.tools = tools;
	const mcp = asStringArray(rec.mcp);
	if (mcp) filter.mcp = mcp;
	const skills = asStringArray(rec.skills);
	if (skills) filter.skills = skills;
	const extensions = asStringArray(rec.extensions);
	if (extensions) filter.extensions = extensions;
	return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Parse raw (deserialized JSON) into a GoalSettings object.
 * Rejects unknown keys (additionalProperties: false semantics).
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((k) => !ALLOWED_SETTINGS_KEYS.has(k));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown pi-goal-xx-settings.json key(s): ${unknownKeys.join(", ")}`);
	}
	const settings: GoalSettings = {};
	const disableTasks = asBool(record.disableTasks);
	const disableContracts = asBool(record.disableContracts);
	const subtaskDepth = asPositiveInt(record.subtaskDepth);
	const provider = asNonEmptyString(record.provider);
	const model = asNonEmptyString(record.model);
	const thinkingLevel = asThinkingLevel(record.thinkingLevel ?? record.thinking_level);
	if (disableTasks !== undefined) settings.disableTasks = disableTasks;
	if (disableContracts !== undefined) settings.disableContracts = disableContracts;
	if (subtaskDepth !== undefined) settings.subtaskDepth = subtaskDepth;
	if (provider !== undefined) settings.provider = provider;
	if (model !== undefined) settings.model = model;
	if (thinkingLevel !== undefined) settings.thinkingLevel = thinkingLevel;
	if (record.disabled === true || record.disabled === "true") settings.disabled = true;
	const disabledTools = asStringArray(record.disabledTools);
	if (disabledTools !== undefined) settings.disabledTools = disabledTools;
	const auditorSubscriptions = asAuditorSubscriptions(record.auditorSubscriptions);
	if (auditorSubscriptions !== undefined) settings.auditorSubscriptions = auditorSubscriptions;
	const auditorMode = asAuditorMode(record.auditorMode);
	if (auditorMode) settings.auditorMode = auditorMode;
	const auditorExclude = asAuditorResourceFilter(record.auditorExclude);
	if (auditorExclude) settings.auditorExclude = auditorExclude;
	const auditorInclude = asAuditorResourceFilter(record.auditorInclude);
	if (auditorInclude) settings.auditorInclude = auditorInclude;
	const auditorPromptMode = asAuditorPromptMode(record.auditorPromptMode);
	if (auditorPromptMode) settings.auditorPromptMode = auditorPromptMode;
	const auditorPrompt = asNonEmptyString(record.auditorPrompt);
	if (auditorPrompt) settings.auditorPrompt = auditorPrompt;
	const goalPromptMode = asGoalPromptMode(record.goalPromptMode);
	if (goalPromptMode) settings.goalPromptMode = goalPromptMode;
	const goalPrompt = asNonEmptyString(record.goalPrompt);
	if (goalPrompt) settings.goalPrompt = goalPrompt;
	const prompts = asPromptsBlock(record.prompts);
	if (prompts) settings.prompts = prompts;
	const toolInstructions = asToolInstructionsBlock(record.toolInstructions);
	if (toolInstructions) settings.toolInstructions = toolInstructions;
	const promptsDir = asNonEmptyString(record.promptsDir);
	if (promptsDir) settings.promptsDir = promptsDir;
	const commandHooks = asCommandHooksBlock(record.commandHooks);
	if (commandHooks) settings.commandHooks = commandHooks;
	const hooksDir = asNonEmptyString(record.hooksDir);
	if (hooksDir) settings.hooksDir = hooksDir;
	// contractTemplates defaults true (enabled). Explicit false persists.
	if (record.contractTemplates === false || record.contractTemplates === "false") {
		settings.contractTemplates = false;
	} else {
		settings.contractTemplates = true;
	}
	const contractsDir = asNonEmptyString(record.contractsDir);
	if (contractsDir) settings.contractsDir = contractsDir;
	const leaseMs = asPositiveInt(record.leaseMs) ?? 180_000;
	settings.leaseMs = leaseMs;
	const heartbeatMs = asPositiveInt(record.heartbeatMs) ?? 60_000;
	settings.heartbeatMs = heartbeatMs;
	const auditorTimeoutMsRaw = asPositiveInt(record.auditorTimeoutMs);
	if (auditorTimeoutMsRaw !== undefined) settings.auditorTimeoutMs = auditorTimeoutMsRaw;
	const auditorTimeoutFloorMsRaw = asPositiveInt(record.auditorTimeoutFloorMs);
	if (auditorTimeoutFloorMsRaw !== undefined) settings.auditorTimeoutFloorMs = auditorTimeoutFloorMsRaw;
	const logging = asLoggingConfig(record.logging);
	if (logging) settings.logging = logging;
	// Legacy alias mapping: auditorPrompt/auditorPromptMode → prompts.auditor
	// ONLY when prompts.auditor is absent (explicit prompts.auditor wins).
	// Read the raw mode value (not the legacy-validated one) so unified modes
	// like "override" pass through when set via the legacy key.
	if (!settings.prompts?.auditor) {
		const legacyInline = settings.auditorPrompt;
		const legacyModeRaw = asNonEmptyString(record.auditorPromptMode);
		if (legacyInline || legacyModeRaw) {
			settings.prompts = {
				...(settings.prompts ?? {}),
				auditor: { inline: legacyInline, mode: legacyModeRaw as PromptMode | undefined },
			};
		}
	}
	return settings;
}

/**
 * Load settings from the file on disk. Returns {} if file missing or invalid.
 * Merges global (base) + project-local (overlay) per-key.
 */
export function loadGoalSettingsFileConfig(cwd: string, env?: NodeJS.ProcessEnv): GoalSettings {
	const resolvedEnv = env ?? process.env;
	let globalConfig: GoalSettings = {};
	try {
		const globalPath = globalGoalSettingsPath(resolvedEnv);
		if (fs.existsSync(globalPath)) {
			globalConfig = parseGoalSettings(JSON.parse(fs.readFileSync(globalPath, "utf8")));
		}
	} catch {
		// global file missing, malformed JSON, etc. — use defaults
	}
	let localConfig: GoalSettings = {};
	try {
		const configPath = goalSettingsPath(cwd, resolvedEnv);
		if (fs.existsSync(configPath)) {
			localConfig = parseGoalSettings(JSON.parse(fs.readFileSync(configPath, "utf8")));
		}
	} catch {
		// file missing, malformed JSON, etc. — use defaults
	}
	return mergeSettings(globalConfig, localConfig);
}

/** Merge two GoalSettings: local wins per-key over global (shallow overlay). */
function mergeSettings(global: GoalSettings, local: GoalSettings): GoalSettings {
	const result: GoalSettings = {};
	const keys = new Set([...Object.keys(global), ...Object.keys(local)]) as Set<keyof GoalSettings>;
	for (const key of keys) {
		const val = local[key] ?? global[key];
		if (val !== undefined) {
			(result as Record<string, unknown>)[key as string] = val;
		}
	}
	return result;
}

/**
 * Load settings with env var overrides.
 * Env vars take precedence over file config.
 * Default: all flags false/undefined (features enabled, default model).
 */
export function loadGoalSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	const fileConfig = loadGoalSettingsFileConfig(cwd, env);
	return {
		disableTasks: asBool(env.PI_GOAL_DISABLE_TASKS) ?? fileConfig.disableTasks ?? false,
		disableContracts: asBool(env.PI_GOAL_DISABLE_CONTRACTS) ?? fileConfig.disableContracts ?? false,
		subtaskDepth: fileConfig.subtaskDepth ?? 1,
		provider: fileConfig.provider,
		model: fileConfig.model,
		thinkingLevel: fileConfig.thinkingLevel,
		disabled: fileConfig.disabled,
		disabledTools: asStringArray(env.PI_GOAL_DISABLED_TOOLS) ?? fileConfig.disabledTools,
		auditorSubscriptions: fileConfig.auditorSubscriptions,
		auditorMode: fileConfig.auditorMode,
		auditorExclude: fileConfig.auditorExclude,
		auditorInclude: fileConfig.auditorInclude,
		auditorPromptMode: fileConfig.auditorPromptMode,
		auditorPrompt: fileConfig.auditorPrompt,
		goalPromptMode: fileConfig.goalPromptMode,
		goalPrompt: fileConfig.goalPrompt,
		leaseMs: fileConfig.leaseMs ?? 180_000,
		heartbeatMs: fileConfig.heartbeatMs ?? 60_000,
		prompts: fileConfig.prompts,
		promptsDir: fileConfig.promptsDir,
		toolInstructions: fileConfig.toolInstructions,
		hooksDir: fileConfig.hooksDir,
		contractTemplates: asBool(env.PI_GOAL_DISABLE_CONTRACT_TEMPLATES) === true
			? false
			: (fileConfig.contractTemplates ?? true),
		contractsDir: fileConfig.contractsDir,
		auditorTimeoutMs: asPositiveInt(env[PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]) ?? fileConfig.auditorTimeoutMs,
		auditorTimeoutFloorMs: asPositiveInt(env[PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV]) ?? fileConfig.auditorTimeoutFloorMs,
		logging: resolveLoggingFromEnv(env, fileConfig.logging),
	};
}

/**
 * Resolve the effective logging config: PI_GOAL_LOG_LEVEL env overrides the
 * file-configured level (and enables logging when the file had none). An
 * invalid env value is ignored (falls back to file config). `toStderr` is only
 * applied from the file config — there is no env override for it.
 */
function resolveLoggingFromEnv(env: NodeJS.ProcessEnv, fileLogging?: GoalLoggingConfig): GoalLoggingConfig | undefined {
	const envLevel = typeof env[PI_GOAL_LOG_LEVEL_ENV] === "string"
		? (env[PI_GOAL_LOG_LEVEL_ENV] as string).toLowerCase()
		: undefined;
	if (envLevel && LOGGING_LEVELS.has(envLevel)) {
		return { level: envLevel as GoalLoggingConfig["level"], toStderr: fileLogging?.toStderr };
	}
	return fileLogging;
}

/**
 * Save settings to the unified settings file on disk.
 * Persists only non-default values using the canonical key names.
 */
/**
 * Determine whether the auditor should be enabled by default based on settings.
 * The auditor is enabled by default unless settings.disabled === true.
 */
export function isAuditorEnabledByDefault(settings: GoalSettings): boolean {
	return settings.disabled !== true;
}

export function saveGoalSettingsFileConfig(cwd: string, settings: GoalSettings): GoalSettings {
	const clean: GoalSettings = {};
	const provider = asNonEmptyString(settings.provider);
	const model = asNonEmptyString(settings.model);
	const thinkingLevel = asThinkingLevel(settings.thinkingLevel);
	const disableTasks = asBool(settings.disableTasks);
	const disableContracts = asBool(settings.disableContracts);
	const subtaskDepth = asPositiveInt(settings.subtaskDepth);
	const disabledTools = asStringArray(settings.disabledTools);
	const auditorSubscriptions = asAuditorSubscriptions(settings.auditorSubscriptions);
	const auditorMode = asAuditorMode(settings.auditorMode);
	const auditorExclude = asAuditorResourceFilter(settings.auditorExclude);
	const auditorInclude = asAuditorResourceFilter(settings.auditorInclude);
	const auditorPromptMode = asAuditorPromptMode(settings.auditorPromptMode);
	const auditorPrompt = asNonEmptyString(settings.auditorPrompt);
	const goalPromptMode = asGoalPromptMode(settings.goalPromptMode);
	const goalPrompt = asNonEmptyString(settings.goalPrompt);
	const leaseMs = asPositiveInt(settings.leaseMs);
	const heartbeatMs = asPositiveInt(settings.heartbeatMs);
	// Counterfactual fix: auditorTimeoutMs was read + parsed by loadGoalSettings
	// but never persisted by saveGoalSettingsFileConfig. A settings rewrite
	// (e.g. a /goal-settings edit) would silently delete the user's auditor
	// timeout, falling back to the 5min default. Round-trip it like leaseMs.
	const auditorTimeoutMs = asPositiveInt(settings.auditorTimeoutMs);
	const auditorTimeoutFloorMs = asPositiveInt(settings.auditorTimeoutFloorMs);
	if (provider) clean.provider = provider;
	if (model) clean.model = model;
	if (thinkingLevel) clean.thinkingLevel = thinkingLevel;
	if (settings.disabled === true) clean.disabled = true;
	if (disableTasks === true) clean.disableTasks = true;
	if (disableContracts === true) clean.disableContracts = true;
	if (subtaskDepth !== undefined) clean.subtaskDepth = subtaskDepth;
	if (disabledTools !== undefined) clean.disabledTools = disabledTools;
	if (auditorSubscriptions !== undefined) clean.auditorSubscriptions = auditorSubscriptions;
	if (auditorMode) clean.auditorMode = auditorMode;
	if (auditorExclude) clean.auditorExclude = auditorExclude;
	if (auditorInclude) clean.auditorInclude = auditorInclude;
	if (auditorPromptMode) clean.auditorPromptMode = auditorPromptMode;
	if (auditorPrompt) clean.auditorPrompt = auditorPrompt;
	if (goalPromptMode) clean.goalPromptMode = goalPromptMode;
	if (goalPrompt) clean.goalPrompt = goalPrompt;
	if (settings.prompts) clean.prompts = settings.prompts;
	if (settings.promptsDir) clean.promptsDir = settings.promptsDir;
	if (settings.toolInstructions) {
		const tiClean = asToolInstructionsBlock(settings.toolInstructions);
		if (tiClean) clean.toolInstructions = tiClean;
	}
	if (settings.commandHooks) clean.commandHooks = settings.commandHooks;
	if (settings.hooksDir) clean.hooksDir = settings.hooksDir;
	if (settings.contractTemplates === false) clean.contractTemplates = false;
	if (settings.contractsDir) clean.contractsDir = settings.contractsDir;
	if (leaseMs !== undefined && leaseMs !== 180_000) clean.leaseMs = leaseMs;
	if (heartbeatMs !== undefined && heartbeatMs !== 60_000) clean.heartbeatMs = heartbeatMs;
	const logging = settings.logging ? asLoggingConfig(settings.logging) : undefined;
	if (logging) clean.logging = logging;
	if (auditorTimeoutMs !== undefined) clean.auditorTimeoutMs = auditorTimeoutMs;
	if (auditorTimeoutFloorMs !== undefined) clean.auditorTimeoutFloorMs = auditorTimeoutFloorMs;
	const configPath = goalSettingsPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const persisted: Record<string, unknown> = {};
	if (clean.provider) persisted.provider = clean.provider;
	if (clean.model) persisted.model = clean.model;
	if (clean.thinkingLevel) persisted.thinking_level = clean.thinkingLevel;
	if (clean.disabled) persisted.disabled = true;
	if (clean.disableTasks) persisted.disableTasks = true;
	if (clean.disableContracts) persisted.disableContracts = true;
	if (clean.subtaskDepth !== undefined) persisted.subtaskDepth = clean.subtaskDepth;
	if (clean.disabledTools) persisted.disabledTools = clean.disabledTools;
	if (clean.auditorSubscriptions) persisted.auditorSubscriptions = clean.auditorSubscriptions;
	if (clean.auditorMode) persisted.auditorMode = clean.auditorMode;
	if (clean.auditorExclude) persisted.auditorExclude = clean.auditorExclude;
	if (clean.auditorInclude) persisted.auditorInclude = clean.auditorInclude;
	if (clean.auditorPromptMode) persisted.auditorPromptMode = clean.auditorPromptMode;
	if (clean.auditorPrompt) persisted.auditorPrompt = clean.auditorPrompt;
	if (clean.goalPromptMode) persisted.goalPromptMode = clean.goalPromptMode;
	if (clean.goalPrompt) persisted.goalPrompt = clean.goalPrompt;
	if (clean.prompts) persisted.prompts = clean.prompts;
	if (clean.promptsDir) persisted.promptsDir = clean.promptsDir;
	if (clean.toolInstructions) persisted.toolInstructions = clean.toolInstructions;
	if (clean.commandHooks) persisted.commandHooks = clean.commandHooks;
	if (clean.hooksDir) persisted.hooksDir = clean.hooksDir;
	if (clean.contractTemplates === false) persisted.contractTemplates = false;
	if (clean.contractsDir) persisted.contractsDir = clean.contractsDir;
	if (clean.leaseMs !== undefined) persisted.leaseMs = clean.leaseMs;
	if (clean.heartbeatMs !== undefined) persisted.heartbeatMs = clean.heartbeatMs;
	if (clean.logging) persisted.logging = clean.logging;
	if (clean.auditorTimeoutMs !== undefined) persisted.auditorTimeoutMs = clean.auditorTimeoutMs;
	if (clean.auditorTimeoutFloorMs !== undefined) persisted.auditorTimeoutFloorMs = clean.auditorTimeoutFloorMs;
	fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
	return clean;
}
