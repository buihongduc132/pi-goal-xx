import { normalizeTaskList, type GoalTaskList } from "../../extensions/goal-record.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LaneDef {
	name: string;
	worktree: string;
}

export interface ParallelLanesConfig {
	lanes: LaneDef[];
	converge: LaneDef;
}

export interface ParsedArgs {
	command: string;
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
	tasks?: GoalTaskList;
	verificationContract?: string;
	draftId?: string;
	worktree?: string;
	parallelLanes?: ParallelLanesConfig;
}

export function parseArgs(args: string[]): ParsedArgs {
	const command = args[0];
	if (!command) {
		throw new Error("No command specified. Usage: goal-xx {create|verify} [options]");
	}

	const result: ParsedArgs = {
		command,
		objective: "",
		autoContinue: true,
		sisyphus: false,
	};

	let i = 1;
	while (i < args.length) {
		const arg = args[i];

		switch (arg) {
			case "--objective":
				result.objective = args[++i] ?? "";
				break;
			case "--no-auto-continue":
				result.autoContinue = false;
				break;
			case "--auto-continue":
				result.autoContinue = true;
				break;
			case "--sisyphus":
				result.sisyphus = true;
				break;
			case "--tasks": {
				const raw = args[++i];
				let parsed: unknown;
				try {
					// Try JSON string first
					parsed = JSON.parse(raw);
				} catch {
					// Fall back to file path
					try {
						const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
						const content = fs.readFileSync(resolved, "utf8");
						parsed = JSON.parse(content);
					} catch {
						throw new Error("--tasks invalid: failed to parse JSON or invalid task list");
					}
				}
				try {
					const normalized = normalizeTaskList(parsed);
					if (!normalized) throw new Error("empty");
					result.tasks = normalized;
				} catch {
					throw new Error("--tasks invalid: failed to parse JSON or invalid task list");
				}
				break;
			}
			case "--verification-contract":
				result.verificationContract = args[++i];
				break;
			case "--draft-id":
				result.draftId = args[++i];
				break;
			case "--worktree":
				result.worktree = args[++i];
				break;
			case "--parallel-lanes": {
				const raw = args[++i];
				try {
					result.parallelLanes = JSON.parse(raw);
				} catch {
					throw new Error("--parallel-lanes invalid: failed to parse JSON");
				}
				break;
			}
			default:
				break;
		}
		i++;
	}

	if ((command === "create" || command === "verify") && !result.objective) {
		throw new Error("--objective is required for create command");
	}

	return result;
}
