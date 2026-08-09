import { spawnSync } from "node:child_process";

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

const HASH_PATTERN = /APPROVED_HASH=([a-zA-Z0-9][a-zA-Z0-9-]*)/;
const DEFAULT_TIMEOUT_MS = 1_800_000;

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
	const env = opts.env ?? process.env;

	const result = spawnSync("jewilo", ["NEW", opts.goalObjective], {
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

	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim();
		return {
			success: false,
			error: `jewilo exited with code ${result.status}${detail ? `: ${detail}` : ""}`,
		};
	}

	const output = (result.stdout || "").trim();
	const match = output.match(HASH_PATTERN);
	if (!match) {
		return {
			success: false,
			error: "jewilo output did not contain APPROVED_HASH — verifier-loop approval hash missing",
		};
	}

	return { success: true, hash: match[1] };
}
