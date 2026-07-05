/**
 * Manual smoke test for unified-prompt-config (verification contract #5).
 * Exercises the 4 required scenarios end-to-end via the real modules.
 *
 * Run: node --experimental-strip-types smoke-unified-prompt-config.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolvePrompt } from "./extensions/prompt-resolver.ts";
import { loadAuditorPrompt } from "./extensions/auditor-prompt.ts";
import { expandContractTemplates } from "./extensions/contract-templating.ts";
import { wrapHandler, loadHook, type CommandHandler } from "./extensions/command-hook-loader.ts";
import type { GoalSettings } from "./extensions/goal-settings.ts";

function section(name: string) { console.log(`\n═══ ${name} ═══`); }
function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "smoke-")); }

let pass = 0, fail = 0;
function check(cond: boolean, label: string) {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}`); }
}

// (a) prompts.goal-running override + append
section("(a) prompts.goal-running override + append");
{
	const cwd = tmpDir();
	const promptsDir = ".pi/pi-goal-xx/prompts/";
	fs.mkdirSync(path.join(cwd, promptsDir), { recursive: true });
	fs.writeFileSync(path.join(cwd, promptsDir, "goal-running.md"), "APPEND-RULE-X9", "utf8");

	const appendSettings: GoalSettings = { prompts: { "goal-running": { mode: "append" } } };
	const appendR = resolvePrompt("goal-running", appendSettings.prompts!["goal-running"], cwd, "HARDCODED", {});
	check(appendR.final === "HARDCODED\n\nAPPEND-RULE-X9", "append: default + file body");
	check(appendR.injected === "APPEND-RULE-X9", "append: injected = file body");

	const overrideSettings: GoalSettings = { prompts: { "goal-running": { mode: "override", inline: "OVERRIDE-ONLY" } } };
	const overrideR = resolvePrompt("goal-running", overrideSettings.prompts!["goal-running"], cwd, "HARDCODED", {});
	check(overrideR.final === "OVERRIDE-ONLY", "override: replaces default entirely");
	check(!overrideR.final.includes("HARDCODED"), "override: hardcoded NOT present");
}

// (b) /goals hook pre/post fire with commandHooks.enabled=true
section("(b) /goals hook pre/post with commandHooks.enabled=true");
{
	const log: string[] = [];
	const builtin: CommandHandler = async (args: string) => { log.push(`builtin(${args})`); return "builtin-ran"; };
	const hook = {
		pre: async (args: string) => { log.push(`pre(${args})`); return { transformArgs: args + "-tx" }; },
		post: async (args: string) => { log.push(`post(${args})`); },
	};
	const settings: GoalSettings = { commandHooks: { enabled: true, goals: { mode: "append" } } };
	const wrapped = wrapHandler("goals", builtin, settings, "/cwd", hook);
	await wrapped("ARG", { ui: { notify: () => {} } });
	check(log[0] === "pre(ARG)", "pre-hook fired first");
	check(log[1] === "builtin(ARG-tx)", "builtin received transformed args");
	check(log[2] === "post(ARG)", "post-hook fired last");

	// enabled=false → no wrapping
	const log2: string[] = [];
	const offSettings: GoalSettings = { commandHooks: { enabled: false, goals: { mode: "append" } } };
	const wrappedOff = wrapHandler("goals", async (a: string) => { log2.push(`b(${a})`); return "x"; }, offSettings, "/cwd", hook);
	await wrappedOff("A", {});
	check(log2.length === 1 && log2[0] === "b(A)", "enabled=false: builtin runs unwrapped, no hooks");
}

// (c) {{verifier-loop}} snippet expands at goal-create (write time)
section("(c) {{verifier-loop}} snippet expands at write time");
{
	const cwd = tmpDir();
	const contractsDir = ".pi/pi-goal-xx/contracts/";
	fs.mkdirSync(path.join(cwd, contractsDir), { recursive: true });
	fs.writeFileSync(path.join(cwd, contractsDir, "verifier-loop.md"), "Run verifier-loop and require <approved/> before complete_goal", "utf8");

	const contract = "Verification contract: {{verifier-loop}}";
	const r = expandContractTemplates(contract, cwd, { home: os.homedir() } as GoalSettings);
	check(r.expanded.includes("Run verifier-loop and require <approved/>"), "snippet expanded");
	check(!r.expanded.includes("{{verifier-loop}}"), "placeholder gone");
	check(r.warnings.length === 0, "no warnings");

	// unknown snippet → preserved + warning
	const r2 = expandContractTemplates("{{unknown-x}}", cwd, { home: os.homedir() } as GoalSettings);
	check(r2.expanded === "{{unknown-x}}", "unknown snippet preserved");
	check(r2.warnings.includes("unknown-x"), "warning emitted for unknown");
}

// (d) legacy auditorPrompt setting still resolves end-to-end
section("(d) legacy auditorPrompt setting still resolves");
{
	const cwd = tmpDir();
	// Legacy path: <cwd>/.pi/auditor-prompt.md
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "auditor-prompt.md"), "LEGACY-FILE-BODY", "utf8");

	const legacySettings: GoalSettings = { auditorPromptMode: "local" };
	const r = loadAuditorPrompt(legacySettings, cwd, "DEFAULT", os.homedir());
	check(r.prompt === "LEGACY-FILE-BODY", "legacy file path still consulted");
	check(r.source === "local", "legacy resolves with local source");

	// Legacy inline override
	const r2 = loadAuditorPrompt({ auditorPrompt: "LEGACY-INLINE", auditorPromptMode: "local" }, cwd, "DEFAULT", os.homedir());
	check(r2.prompt === "LEGACY-INLINE" && r2.source === "inline", "legacy inline override still wins");

	// Legacy → prompts.auditor alias (via settings parse path)
	const { parseGoalSettings } = await import("./extensions/goal-settings.ts");
	const parsed = parseGoalSettings({ auditorPrompt: "ALIAS-CHECK", auditorPromptMode: "override" });
	const aud = (parsed.prompts as Record<string, { inline?: string; mode?: string }>)?.auditor;
	check(aud?.inline === "ALIAS-CHECK", "legacy auditorPrompt aliased to prompts.auditor.inline");
	check(aud?.mode === "override", "legacy auditorPromptMode aliased to prompts.auditor.mode");
}

section("RESULT");
console.log(`  pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
