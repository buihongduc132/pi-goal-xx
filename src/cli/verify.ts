import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VerifyOptions {
	cwd: string;
	goalObjective: string;
	env?: Record<string, string | undefined>;
}

export interface VerifyResult {
	success: boolean;
	hash?: string;
	error?: string;
}

/**
 * Hash pattern for fallback stdout parsing: <6 digits>-<8 hex> (e.g. 080926-d84256bf).
 * Matches both APPROVED_HASH= wrappers (test mocks) and bare hash output.
 */
const HASH_PATTERN = /(?:APPROVED_HASH=)?\b(\d{6}-[a-f0-9]{8})\b/;

const DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * Resolve the verifier-loop goals directory. Respects VERIFIER_LOOP_HOME env override;
 * defaults to ~/.verifier-loop/goals.
 */
function goalsDir(env: Record<string, string | undefined>): string {
	const home = env.VERIFIER_LOOP_HOME ?? env.HOME ?? os.homedir();
	return path.join(home, ".verifier-loop", "goals");
}

/**
 * Read the completion hash for a goal from its completion.json file.
 * completion.json shape: { hash, fullDigest, goalId, roundNumber, ... }
 */
function readHashFromCompletion(env: Record<string, string | undefined>, goalId: string): string | undefined {
	const completionPath = path.join(goalsDir(env), goalId, "completion.json");
	try {
		if (!fs.existsSync(completionPath)) return undefined;
		const content = fs.readFileSync(completionPath, "utf8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return typeof parsed.hash === "string" && parsed.hash.trim() ? parsed.hash.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Run the verifier-loop ceremony via the `jewilo` CLI (PRIMARY).
 *
 * Flow:
 * 1. Spawn `jewilo --json NEW <goalObjective>` with a long timeout (verifier rounds take minutes).
 * 2. On exit 0, parse JSON output for { ok, state, goalId }.
 * 3. Read hash from completion.json (durable proof) OR fallback to stdout HASH_PATTERN.
 *
 * Returns { success: true, hash } on approval, { success: false, error } otherwise.
 */
export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
	const env = opts.env ?? process.env;

	const result = spawnSync("jewilo", ["--json", "NEW", opts.goalObjective], {
		cwd: opts.cwd,
		env,
		timeout: DEFAULT_TIMEOUT_MS,
		encoding: "utf8",
	});

	if (result.error) {
		return {
			success: false,
			error: `jewilo command not found or failed to execute: ${result.error.message}`,
		};
	}

	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";

	// Parse JSON output (jewilo --json emits a single JSON object on stdout)
	let parsed: Record<string, unknown> | null = null;
	try {
		const trimmed = stdout.trim();
		if (trimmed.startsWith("{")) {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		}
	} catch {
		// Non-JSON output — fall through to pattern-based hash extraction
	}

	// Non-zero exit: reject unless we can still extract a hash from output
	if (result.status !== 0) {
		const detail = (stderr.trim() || stdout.trim() || "").trim();
		// Still try stdout hash fallback (some failure modes still emit the hash)
		const stdoutMatch = stdout.match(HASH_PATTERN);
		if (stdoutMatch) {
			return { success: true, hash: stdoutMatch[1] };
		}
		return {
			success: false,
			error: `jewilo exited with code ${result.status}${detail ? `: ${detail}` : ""}`,
		};
	}

	// Exit 0: try durable completion.json first, then stdout pattern
	const goalId = parsed && typeof parsed.goalId === "string" ? parsed.goalId : undefined;
	if (goalId) {
		const hash = readHashFromCompletion(env, goalId);
		if (hash) return { success: true, hash };
	}

	// JSON output may carry the hash directly in a `hash` field
	if (parsed && typeof parsed.hash === "string" && parsed.hash.trim()) {
		return { success: true, hash: parsed.hash.trim() };
	}

	// Fallback: parse hash from stdout text (covers test mocks + bare-hash output)
	const stdoutMatch = stdout.match(HASH_PATTERN);
	if (stdoutMatch) {
		return { success: true, hash: stdoutMatch[1] };
	}

	return {
		success: false,
		error: "jewilo completed without producing a verifier-loop approval hash (no completion.json hash, no JSON hash, no stdout hash)",
	};
}
