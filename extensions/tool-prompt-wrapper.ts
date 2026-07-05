/**
 * Tool prompt wrapping — merges unified resolver output onto a tool's
 * promptSnippet / promptGuidelines at registration time (group 4, D3).
 *
 * See:
 *   - openspec/changes/unified-prompt-config/design.md (D3)
 *
 * Key convention: tool prompt keys are `tool-<toolName>` (e.g.
 * `tool-get-goal`, `tool-create-goal`). Tool prompts resolve at load via
 * defineTool wrapper; editing a tool prompt file requires `/reload`.
 */

import { resolvePrompt, type PromptConfig } from "./prompt-resolver.ts";
import type { GoalSettings } from "./goal-settings.ts";

/** Minimal tool shape we wrap (anything with name + promptSnippet/guidelines). */
export interface ToolDefinitionLike {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

/**
 * Wrap a tool definition, merging unified prompt config for `tool-<name>`.
 *
 * - append (default-ish): the resolved block is appended to promptSnippet and
 *   pushed onto promptGuidelines.
 * - override: the resolved body REPLACES promptSnippet (guidelines untouched
 *   unless the override body is multi-line — single field replaces snippet).
 * - off: no injection.
 *
 * Returns a new object (does not mutate the input).
 */
export function wrapToolDefinition<T extends ToolDefinitionLike>(
	tool: T,
	settings: GoalSettings | undefined,
	cwd: string | undefined,
): T {
	if (!settings?.prompts) return tool;
	const key = `tool-${tool.name}`;
	const cfg: PromptConfig | undefined = (settings.prompts as Record<string, PromptConfig>)[key];
	if (!cfg) return tool;

	const resolved = resolvePrompt(key, cfg, cwd ?? ".", "", {
		promptsDir: settings.promptsDir,
	});
	if (resolved.source === "none") return tool;

	const out: T = { ...tool };

	if (cfg.mode === "override") {
		// Override replaces the snippet entirely.
		out.promptSnippet = resolved.final;
		return out;
	}

	// append / global-local / local / global-local-merge: inject the block.
	if (resolved.injected) {
		const block = `[PI GOAL CUSTOM PROMPT key=${key} source=${resolved.source}]\n${resolved.injected}`;
		out.promptSnippet = tool.promptSnippet
			? `${tool.promptSnippet}\n\n${block}`
			: block;
		out.promptGuidelines = [...(tool.promptGuidelines ?? []), block];
	}
	return out;
}
