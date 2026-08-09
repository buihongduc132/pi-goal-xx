#!/usr/bin/env node
import { parseArgs } from "./index.ts";
import { runCreate } from "./create.ts";
import { runVerify } from "./verify.ts";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	switch (args.command) {
		case "create": {
			const result = runCreate({
				cwd: process.cwd(),
				objective: args.objective,
				autoContinue: args.autoContinue,
				sisyphus: args.sisyphus,
				taskList: args.tasks,
				verificationContract: args.verificationContract,
				draftId: args.draftId,
				worktree: args.worktree,
				parallelLanes: args.parallelLanes,
			});
			console.log(`Goal created: ${result.goalPath}`);
			break;
		}
		case "verify": {
			const result = await runVerify({
				cwd: process.cwd(),
				goalObjective: args.objective,
			});
			if (result.success) {
				console.log(`Verifier loop passed. Hash: ${result.hash}`);
			} else {
				console.error(`Verifier loop failed: ${result.error}`);
				process.exitCode = 1;
			}
			break;
		}
		default:
			console.error(`Unknown command: ${args.command}. Usage: goal-xx {create|verify} [options]`);
			process.exitCode = 1;
			break;
	}
}

main();
