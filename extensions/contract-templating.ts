/**
 * Contract snippet templating — `{{name}}` expansion at write time.
 *
 * See:
 *   - openspec/changes/unified-prompt-config/specs/contract-templating/spec.md
 *   - openspec/changes/unified-prompt-config/design.md (D6)
 *
 * Resolution:
 *   1. `{{name}}` placeholders resolved from snippet files.
 *   2. Local (`<cwd>/<contractsDir>/<name>.md`) wins over global
 *      (`<home>/<contractsDir>/<name>.md`).
 *   3. Missing snippet → literal `{{name}}` preserved + a warning collected.
 *   4. Disabled by `settings.contractTemplates === false` or the
 *      `PI_GOAL_DISABLE_CONTRACT_TEMPLATES=true` env var (placeholders left
 *      literal, no warnings).
 *
 * Expansion happens at write time only (goal-create / goal-tweak). The
 * expanded form is persisted in the goal file so it is self-contained at
 * audit time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSettings } from "./goal-settings.ts";

/** Default contracts directory (relative to home and cwd). */
const DEFAULT_CONTRACTS_DIR = ".pi/pi-goal-xx/contracts/";

/** Match `{{name}}` placeholders. Names: letters, digits, hyphens, underscores. */
const SNIPPET_RE = /\{\{([a-zA-Z0-9][a-zA-Z0-9_-]*)\}\}/g;

export interface ExpansionResult {
	/** The contract with all resolvable snippets expanded. */
	expanded: string;
	/** Names of snippets that could not be resolved (placeholder preserved). */
	warnings: string[];
}

/** Read a file's trimmed content if it exists and is non-empty, else undefined. */
function readFileIfExists(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Expand `{{snippet-name}}` placeholders in `contract`.
 *
 * @param contract The raw contract string (may contain placeholders).
 * @param cwd      Working directory for local snippet resolution.
 * @param settings Goal settings (contractsDir override, contractTemplates toggle, home).
 * @returns `{ expanded, warnings }`.
 */
export function expandContractTemplates(
	contract: string,
	cwd: string,
	settings: GoalSettings | undefined,
): ExpansionResult {
	// Disabled switches: explicit false OR env override.
	const envDisabled = process.env.PI_GOAL_DISABLE_CONTRACT_TEMPLATES === "true";
	const enabled = settings?.contractTemplates !== false && !envDisabled;
	if (!enabled || !contract || !contract.includes("{{")) {
		return { expanded: contract, warnings: [] };
	}

	const contractsDir = settings?.contractsDir ?? DEFAULT_CONTRACTS_DIR;
	const home = (settings as { home?: string })?.home ?? os.homedir();

	const warnings: string[] = [];
	const seen: Record<string, string | undefined> = {};

	const expanded = contract.replace(SNIPPET_RE, (full, name: string) => {
		if (name in seen) {
			const cached = seen[name];
			if (cached === undefined) {
				if (!warnings.includes(name)) warnings.push(name);
				return full;
			}
			return cached;
		}
		const localPath = cwd ? path.join(cwd, contractsDir, `${name}.md`) : "";
		const globalPath = home ? path.join(home, contractsDir, `${name}.md`) : "";
		const localText = localPath ? readFileIfExists(localPath) : undefined;
		const resolved = localText ?? (globalPath ? readFileIfExists(globalPath) : undefined);
		seen[name] = resolved;
		if (resolved === undefined) {
			if (!warnings.includes(name)) warnings.push(name);
			return full; // preserve literal placeholder
		}
		return resolved;
	});

	return { expanded, warnings };
}
