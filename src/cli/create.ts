import {
	createGoal,
	normalizeTaskList,
	type GoalTaskList,
} from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { DEFAULT_CEREMONY_CONTRACT } from "./ceremony.ts";
import type { ParallelLanesConfig } from "./index.ts";

export interface CreateOptions {
	cwd: string;
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
	taskList?: GoalTaskList;
	verificationContract?: string;
	draftId?: string;
	worktree?: string;
	parallelLanes?: ParallelLanesConfig;
}

export interface CreateResult {
	goalPath: string;
}

export function runCreate(opts: CreateOptions): CreateResult {
	const goal = createGoal({
		objective: opts.objective,
		autoContinue: opts.autoContinue,
		sisyphus: opts.sisyphus,
	});

	let fullObjective = opts.objective;

	if (opts.worktree) {
		fullObjective += `\n\nWorktree: ${opts.worktree} — all code lands here; main checkout untouched.`;
	}

	if (opts.parallelLanes) {
		const laneLines = opts.parallelLanes.lanes
			.map((l) => `- ${l.worktree} (${l.name})`)
			.join("\n");
		const converge = opts.parallelLanes.converge;
		fullObjective += `\n\nLanes:\n${laneLines}\nConverge: ${converge.worktree} (${converge.name}) — lane PRs merge here, then converge→main.`;
	}

	goal.objective = fullObjective;

	if (opts.taskList) {
		const normalized = normalizeTaskList(opts.taskList);
		if (normalized) {
			normalized.blockCompletion = true;
			goal.taskList = normalized;
		}
	}

	goal.verificationContract = opts.verificationContract ?? DEFAULT_CEREMONY_CONTRACT;

	const written = writeActiveGoalFile({ cwd: opts.cwd }, goal);

	return { goalPath: written.activePath! };
}
