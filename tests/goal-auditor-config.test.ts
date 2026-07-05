import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGoalCompletionAuditor, isGoalSelfExtension } from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-aud",
		objective: "Build the thing",
		status: "active",
		autoContinue: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-aud-int-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function makeCtx(cwd: string): any {
	const model = { provider: "def", id: "m1", name: "m1" };
	return {
		cwd,
		model,
		modelRegistry: {
			find: (p: string, i: string) => (p === "def" && i === "m1" ? model : undefined),
			getAvailable: () => [model],
		},
		hasUI: false,
	};
}

interface CapturedSessionArgs {
	tools: string[];
	resourceLoader: any;
	cwd: string;
}

function makeCapturingCreateSession(
	captured: CapturedSessionArgs,
	finalOutput = "<approved/>",
): any {
	return async (sessionArgs: any) => {
		captured.tools = [...(sessionArgs.tools ?? [])];
		captured.resourceLoader = sessionArgs.resourceLoader;
		captured.cwd = sessionArgs.cwd;
		let subscriber: ((event: any) => void) | null = null;
		const session = {
			subscribe(cb: (event: any) => void) {
				subscriber = cb;
				return () => { subscriber = null; };
			},
			async prompt(_text: string) {
				subscriber?.({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: finalOutput }] },
				});
			},
			abort() {},
		};
		return { session };
	};
}

async function capture(cwd: string, settings: any, mainResources?: any): Promise<CapturedSessionArgs> {
	const captured: CapturedSessionArgs = { tools: [], resourceLoader: null as any, cwd: "" };
	if (settings && Object.keys(settings).length > 0) {
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify(settings),
		);
	}
	await runGoalCompletionAuditor({
		ctx: makeCtx(cwd),
		goal: makeGoal(),
		detailedSummary: "d",
		createSession: makeCapturingCreateSession(captured),
		...(mainResources ? { mainResources } : {}),
	});
	return captured;
}

describe("runGoalCompletionAuditor — backward compat (no mainResources)", () => {
	it("falls back to baseline tools when no mainResources", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(cwd, {});
		// Inherit mode with empty main tools → baseline + report_auditor_progress
		assert.ok(c.tools.includes("read"));
		assert.ok(c.tools.includes("bash"));
		assert.ok(c.tools.includes("report_auditor_progress"));
	});
});

describe("runGoalCompletionAuditor — tool inheritance (inherit mode)", () => {
	const mainTools = ["read", "write", "edit", "bash", "gitnexus_query", "gitnexus_context"];

	it("inherits all main tools by default", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(cwd, {}, { tools: mainTools });
		assert.ok(c.tools.includes("write"));
		assert.ok(c.tools.includes("gitnexus_query"));
		assert.ok(c.tools.includes("report_auditor_progress"));
	});

	it("applies auditorExclude.tools (exact)", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(
			cwd,
			{ auditorExclude: { tools: ["write", "edit"] } },
			{ tools: mainTools },
		);
		assert.equal(c.tools.includes("write"), false);
		assert.equal(c.tools.includes("edit"), false);
		assert.ok(c.tools.includes("bash"));
	});

	it("applies auditorExclude.tools (wildcard)", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(
			cwd,
			{ auditorExclude: { tools: ["gitnexus*"] } },
			{ tools: mainTools },
		);
		assert.equal(c.tools.includes("gitnexus_query"), false);
		assert.equal(c.tools.includes("gitnexus_context"), false);
		assert.ok(c.tools.includes("write"));
	});

	it("never strips report_auditor_progress even with wildcard exclude", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(
			cwd,
			{ auditorExclude: { tools: ["*"] } },
			{ tools: mainTools },
		);
		assert.deepEqual(c.tools, ["report_auditor_progress"]);
	});
});

describe("runGoalCompletionAuditor — minimal mode", () => {
	const mainTools = ["read", "write", "gitnexus_query"];

	it("uses baseline only when no includes", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(cwd, { auditorMode: "minimal" }, { tools: mainTools });
		assert.ok(c.tools.includes("read"));
		assert.ok(c.tools.includes("bash"));
		assert.equal(c.tools.includes("write"), false);
		assert.equal(c.tools.includes("gitnexus_query"), false);
	});

	it("adds included tools from main", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(
			cwd,
			{ auditorMode: "minimal", auditorInclude: { tools: ["gitnexus_query"] } },
			{ tools: mainTools },
		);
		assert.ok(c.tools.includes("gitnexus_query"));
		assert.ok(c.tools.includes("read"));
		assert.equal(c.tools.includes("write"), false);
	});
});

describe("runGoalCompletionAuditor — prompt resolution", () => {
	it("uses hardcoded default when no inline/file prompts", async () => {
		const cwd = makeTmpCwd();
		let promptedText = "";
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal({ objective: "UNIQUE-OBJECTIVE-MARKER" }),
			detailedSummary: "d",
			createSession: async (sessionArgs: any) => {
				let sub: ((e: any) => void) | null = null;
				const session = {
					subscribe(cb: (e: any) => void) { sub = cb; return () => { sub = null; }; },
					async prompt(t: string) {
						promptedText = t;
						sub?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } });
					},
					abort() {},
				};
				return { session };
			},
		});
		// Default prompt is buildGoalAuditorPrompt output, which contains the objective.
		assert.match(promptedText, /UNIQUE-OBJECTIVE-MARKER/);
		assert.match(promptedText, /independent completion auditor/);
	});

	it("uses inline auditorPrompt override", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ auditorPrompt: "INLINE-OVERRIDE-PROMPT" }),
		);
		let promptedText = "";
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal({ objective: "UNIQUE-OBJECTIVE-MARKER" }),
			detailedSummary: "d",
			createSession: async (_sessionArgs: any) => {
				let sub: ((e: any) => void) | null = null;
				const session = {
					subscribe(cb: (e: any) => void) { sub = cb; return () => { sub = null; }; },
					async prompt(t: string) {
						promptedText = t;
						sub?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } });
					},
					abort() {},
				};
				return { session };
			},
		});
		// SPEC (prompt-config-resolution "Goal data always injected"): the fact
		// layer (objective + summaries + checklist) is ALWAYS concatenated, even
		// under inline override — the auditor must identify the goal under audit.
		assert.ok(promptedText.startsWith("INLINE-OVERRIDE-PROMPT"));
		assert.match(promptedText, /UNIQUE-OBJECTIVE-MARKER/);
		assert.match(promptedText, /<objective>/);
	});

	it("uses local file prompt when present (global-local mode default)", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(path.join(cwd, ".pi", "auditor-prompt.md"), "LOCAL-FILE-PROMPT");
		let promptedText = "";
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd),
			goal: makeGoal(),
			detailedSummary: "d",
			createSession: async (_sessionArgs: any) => {
				let sub: ((e: any) => void) | null = null;
				const session = {
					subscribe(cb: (e: any) => void) { sub = cb; return () => { sub = null; }; },
					async prompt(t: string) {
						promptedText = t;
						sub?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } });
					},
					abort() {},
				};
				return { session };
			},
		});
		// SPEC: fact layer always present (objective etc.) appended after the
		// resolved local file body.
		assert.ok(promptedText.startsWith("LOCAL-FILE-PROMPT"));
		assert.match(promptedText, /<objective>/);
	});
});

describe("runGoalCompletionAuditor — resourceLoader inheritance", () => {
	it("uses an empty resourceLoader when neither inheritFromCwd nor resourceLoader is provided (legacy/test path)", async () => {
		const cwd = makeTmpCwd();
		const c = await capture(cwd, {}, { tools: ["read", "bash"] });
		assert.equal(typeof c.resourceLoader.getSkills, "function");
		assert.deepEqual(c.resourceLoader.getSkills().skills, []);
		assert.deepEqual(c.resourceLoader.getExtensions().extensions, []);
	});

	it("delegates to main resourceLoader when provided (inherit mode)", async () => {
		const cwd = makeTmpCwd();
		const fakeSkill = { name: "deploy-skill", filePath: "/x", baseDir: "/x", sourceInfo: {}, disableModelInvocation: false, description: "d" };
		const fakeExt = { path: "cc-safety-net", resolvedPath: "/cc", sourceInfo: {}, handlers: new Map(), tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
		const mainLoader = {
			getExtensions: () => ({ extensions: [fakeExt], errors: [], runtime: {} }),
			getSkills: () => ({ skills: [fakeSkill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const c = await capture(cwd, {}, { tools: ["read", "bash"], skills: ["deploy-skill"], extensions: ["cc-safety-net"], resourceLoader: mainLoader });
		const skills = c.resourceLoader.getSkills().skills;
		assert.equal(skills.length, 1);
		assert.equal(skills[0].name, "deploy-skill");
		const exts = c.resourceLoader.getExtensions().extensions;
		assert.equal(exts.length, 1);
	});

	it("filters inherited skills by exclude pattern", async () => {
		const cwd = makeTmpCwd();
		const fakeSkillA = { name: "deploy-skill", filePath: "/a", baseDir: "/a", sourceInfo: {}, disableModelInvocation: false, description: "d" };
		const fakeSkillB = { name: "test-skill", filePath: "/b", baseDir: "/b", sourceInfo: {}, disableModelInvocation: false, description: "d" };
		const mainLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
			getSkills: () => ({ skills: [fakeSkillA, fakeSkillB], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const c = await capture(
			cwd,
			{ auditorExclude: { skills: ["deploy*"] } },
			{ tools: ["read"], skills: ["deploy-skill", "test-skill"], extensions: [], resourceLoader: mainLoader },
		);
		const skills = c.resourceLoader.getSkills().skills;
		// resolveAuditorResources filters to only test-skill (deploy excluded)
		assert.deepEqual(skills.map((s: any) => s.name), ["test-skill"]);
	});

	it("inheritFromCwd=true discovers project-local skills written to <cwd>/.pi/skills/", async () => {
		// Proves the auditor inherits cwd's resources via DefaultResourceLoader:
		// a skill placed under <cwd>/.pi/skills/ is discovered and survives the
		// filter wrapper (inherit mode, no excludes).
		const cwd = makeTmpCwd();
		const fakeAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-agentdir-"));
		// Plant a project-local skill on disk.
		const skillDir = path.join(cwd, ".pi", "skills", "my-proj-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-proj-skill\ndescription: x\n---\nbody\n");
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
		try {
			const c = await capture(cwd, {}, { tools: ["read"], inheritFromCwd: true });
			const skillNames = c.resourceLoader.getSkills().skills.map((s: any) => s.name);
			assert.ok(skillNames.includes("my-proj-skill"), `expected my-proj-skill in ${JSON.stringify(skillNames)}`);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			try {
				fs.rmSync(fakeAgentDir, { recursive: true, force: true });
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch { /* best-effort cleanup */ }
		}
	});
});

describe("B3 — auditor excludes pi-goal self from inherited extensions", () => {
	it("isGoalSelfExtension matches source and deployed paths", () => {
		assert.equal(isGoalSelfExtension("/home/user/pi-goal-xx/extensions/goal.ts"), true);
		assert.equal(isGoalSelfExtension("C:\\Users\\pi-goal-xx\\extensions\\goal.ts"), true);
		assert.equal(isGoalSelfExtension("npm:pi-goal-xx"), true);
		assert.equal(isGoalSelfExtension("/home/user/.pi/agent/extensions/pi-goal-xx/goal.ts"), true);
	});

	it("isGoalSelfExtension does not match unrelated extensions", () => {
		assert.equal(isGoalSelfExtension("cc-safety-net"), false);
		assert.equal(isGoalSelfExtension("/path/to/lint-on-edit/index.ts"), false);
		assert.equal(isGoalSelfExtension("pi-mcp-adapter"), false);
		assert.equal(isGoalSelfExtension(undefined), false);
	});

	it("resource loader filters out the goal extension even in inherit mode", async () => {
		// B3 failure mode: the auditor inherits ALL main extensions including
		// pi-goal itself. createAgentSession then re-instantiates the goal
		// plugin inside the auditor → double state, locks, timers, hooks →
		// 100%-reproducible crash on complete_goal.
		//
		// This test proves the goal extension is stripped from the auditor's
		// resolved extensions even when it's present in the main loader and
		// no auditorExclude is configured.
		const cwd = makeTmpCwd();
		const goalExt = {
			path: "/home/user/pi-goal-xx/extensions/goal.ts",
			resolvedPath: "/home/user/pi-goal-xx/extensions/goal.ts",
			sourceInfo: {}, handlers: new Map(), tools: new Map(),
			messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
		};
		const safeExt = {
			path: "cc-safety-net", resolvedPath: "/cc", sourceInfo: {}, handlers: new Map(), tools: new Map(),
			messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
		};
		const mainLoader = {
			getExtensions: () => ({ extensions: [goalExt, safeExt], errors: [], runtime: {} }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const c = await capture(
			cwd,
			{},
			{ tools: ["read"], extensions: [goalExt.path, safeExt.path], resourceLoader: mainLoader },
		);
		const exts = c.resourceLoader.getExtensions().extensions;
		const extPaths = exts.map((e: any) => e.path);
		// cc-safety-net survives
		assert.ok(extPaths.includes("cc-safety-net"), `expected cc-safety-net in ${JSON.stringify(extPaths)}`);
		// pi-goal itself is EXCLUDED
		assert.ok(!extPaths.some((p: string) => p.includes("pi-goal") || p.endsWith("goal.ts")),
			`goal extension must NOT be in auditor extensions: ${JSON.stringify(extPaths)}`);
	});
});
