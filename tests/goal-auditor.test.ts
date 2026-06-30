import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseAuditorDecision,
	buildGoalAuditorPrompt,
	runGoalCompletionAuditor,
	type GoalAuditorResult,
} from "../extensions/goal-auditor.ts";
import type { GoalRecord, GoalTaskList } from "../extensions/goal-record.ts";

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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-aud-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function makeMockModel(provider: string, id: string): any {
	return { provider, id, name: id };
}

/** Build a mock ExtensionContext with a controllable modelRegistry. */
function makeCtx(cwd: string, over: Partial<{ model: any; models: any[] }> = {}): any {
	const models = over.models ?? [makeMockModel("def", "m1")];
	return {
		cwd,
		model: over.model ?? models[0],
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
		},
		hasUI: false,
	};
}

/** Mock createAgentSession. Captures the prompt, emits queued events, then resolves. */
function makeMockCreateSession(opts: {
	finalOutput?: string;
	events?: any[];
	throwInPrompt?: Error;
	promptHook?: (promptText: string) => void;
}): any {
	return async (sessionArgs: any) => {
		let subscriber: ((event: any) => void) | null = null;
		const session = {
			prompted: [] as string[],
			abortCalled: false,
			subscribe(cb: (event: any) => void) {
				subscriber = cb;
				return () => { subscriber = null; };
			},
			async prompt(text: string) {
				this.prompted.push(text);
				opts.promptHook?.(text);
				for (const ev of opts.events ?? []) subscriber?.(ev);
				if (opts.throwInPrompt) throw opts.throwInPrompt;
				if (opts.finalOutput !== undefined) {
					subscriber?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: opts.finalOutput }] },
					});
				}
			},
			abort() { this.abortCalled = true; },
		};
		return { session };
	};
}

describe("parseAuditorDecision", () => {
	it("approves on <approved/> only", () => {
		assert.deepEqual(parseAuditorDecision("all good\n<approved/>"), { approved: true, disapproved: false });
	});

	it("disapproves on <disapproved/> only", () => {
		assert.deepEqual(parseAuditorDecision("nope\n<disapproved/>"), { approved: false, disapproved: true });
	});

	it("disapproves when both markers present (approved suppressed)", () => {
		// disapproved wins: approved is only true if NOT disapproved
		const r = parseAuditorDecision("<approved/> <disapproved/>");
		assert.equal(r.disapproved, true);
		assert.equal(r.approved, false);
	});

	it("neither when no marker", () => {
		assert.deepEqual(parseAuditorDecision("just a report, no marker"), { approved: false, disapproved: false });
	});

	it("handles whitespace variations in self-closing tag", () => {
		assert.deepEqual(parseAuditorDecision("<approved />"), { approved: true, disapproved: false });
		assert.deepEqual(parseAuditorDecision("<disapproved  />"), { approved: false, disapproved: true });
	});
});

describe("buildGoalAuditorPrompt", () => {
	it("contains core sections and objective", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ objective: "My Obj" }),
			detailedSummary: "details here",
		});
		assert.match(out, /independent completion auditor/);
		assert.match(out, /<objective>/);
		assert.match(out, /My Obj/);
		assert.match(out, /<completion_summary>/);
		assert.match(out, /\(none provided\)/); // no completionSummary
		assert.match(out, /<goal_details>/);
		assert.match(out, /details here/);
		assert.match(out, /<approved\/>/);
		assert.match(out, /<disapproved\/>/);
	});

	it("includes completion summary when provided", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal(),
			completionSummary: "I finished it",
			detailedSummary: "d",
		});
		assert.match(out, /I finished it/);
	});

	it("includes verification summary when provided", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "d",
			verificationSummary: "verified X",
		});
		assert.match(out, /<verification_summary>/);
		assert.match(out, /verified X/);
		assert.match(out, /Check the <verification_summary>/);
	});

	it("omits verification summary block when blank", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "d",
			verificationSummary: "   ",
		});
		assert.doesNotMatch(out, /<verification_summary>/);
	});

	it("includes verification contract when present", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ verificationContract: "must pass tests" }),
			detailedSummary: "d",
		});
		assert.match(out, /<verification_contract>/);
		assert.match(out, /must pass tests/);
		assert.match(out, /satisfied every item in the/);
	});

	it("omits contract when disableContracts set", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ verificationContract: "vc" }),
			detailedSummary: "d",
			settings: { disableContracts: true } as any,
		});
		assert.doesNotMatch(out, /<verification_contract>/);
	});

	it("includes task summary block when taskList present", () => {
		const taskList: GoalTaskList = {
			tasks: [
				{ id: "t1", title: "Done", status: "complete" },
				{ id: "t2", title: "Pend", status: "pending" },
			],
			blockCompletion: true,
			proposedAt: "x",
		};
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ taskList }),
			detailedSummary: "d",
		});
		assert.match(out, /Tasks: 1\/2 complete/);
		assert.match(out, /\[x\] t1: Done/);
		assert.match(out, /\[ \] t2: Pend/);
		assert.match(out, /TASK GATE: pending tasks block completion/);
	});

	it("omits task block when disableTasks set", () => {
		const taskList: GoalTaskList = {
			tasks: [{ id: "t1", title: "x", status: "pending" }],
			blockCompletion: false,
			proposedAt: "x",
		};
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ taskList }),
			detailedSummary: "d",
			settings: { disableTasks: true } as any,
		});
		assert.doesNotMatch(out, /Tasks: /);
	});

	it("omits task block when no taskList", () => {
		const out = buildGoalAuditorPrompt({ goal: makeGoal(), detailedSummary: "d" });
		assert.doesNotMatch(out, /Tasks: /);
	});

	it("includes nested subtasks in tree", () => {
		const taskList: GoalTaskList = {
			tasks: [{
				id: "p", title: "Parent", status: "pending",
				subtasks: [{ id: "c", title: "Child", status: "complete" }],
			}],
			blockCompletion: false,
			proposedAt: "x",
		};
		const out = buildGoalAuditorPrompt({ goal: makeGoal({ taskList }), detailedSummary: "d" });
		assert.match(out, /\[ \] p: Parent/);
		assert.match(out, /  \[x\] c: Child/);
	});

	it("includes report_auditor_progress guidance", () => {
		const out = buildGoalAuditorPrompt({ goal: makeGoal(), detailedSummary: "d" });
		assert.match(out, /report_auditor_progress/);
		assert.match(out, /percentage=50/);
	});
});

describe("runGoalCompletionAuditor — model resolution", () => {
	it("returns error result when configured model not found (provider+model)", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ provider: "nope", model: "missing" }),
		);
		const ctx = makeCtx(cwd);
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d", createSession: makeMockCreateSession({}),
		});
		assert.equal(res.approved, false);
		assert.equal(res.disapproved, true);
		assert.match(res.error!, /not found: nope\/missing/);
	});

	it("uses first model for provider-only config", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ provider: "def" }),
		);
		const ctx = makeCtx(cwd, { models: [makeMockModel("def", "m1"), makeMockModel("def", "m2")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(res.approved, true);
		assert.equal(res.model, "def/m1");
	});

	it("errors when provider has no models", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ provider: "ghost" }),
		);
		const ctx = makeCtx(cwd, { models: [makeMockModel("def", "m1")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d", createSession: makeMockCreateSession({}),
		});
		assert.match(res.error!, /No available auditor model for provider: ghost/);
	});

	it("resolves slash-form model string", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ model: "def/m2" }),
		);
		const ctx = makeCtx(cwd, { models: [makeMockModel("def", "m1"), makeMockModel("def", "m2")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(res.model, "def/m2");
		assert.equal(res.approved, true);
	});

	it("errors on ambiguous bare model name", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ model: "m1" }),
		);
		const ctx = makeCtx(cwd, { models: [makeMockModel("a", "m1"), makeMockModel("b", "m1")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d", createSession: makeMockCreateSession({}),
		});
		assert.match(res.error!, /ambiguous or unavailable/);
	});

	it("resolves unique bare model name", async () => {
		const cwd = makeTmpCwd();
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify({ model: "unique" }),
		);
		const ctx = makeCtx(cwd, { models: [makeMockModel("def", "m1"), makeMockModel("def", "unique")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(res.model, "def/unique");
	});

	it("falls back to ctx.model when no config", async () => {
		const cwd = makeTmpCwd(); // no settings file → defaults
		const ctx = makeCtx(cwd, { models: [makeMockModel("def", "m1")] });
		const res = await runGoalCompletionAuditor({
			ctx, goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(res.model, "def/m1");
	});
});

describe("runGoalCompletionAuditor — session orchestration", () => {
	it("approves when output contains <approved/>", async () => {
		const cwd = makeTmpCwd();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "All good\n<approved/>" }),
		});
		assert.equal(res.approved, true);
		assert.equal(res.disapproved, false);
		assert.match(res.output, /All good/);
	});

	it("disapproves when output contains <disapproved/>", async () => {
		const cwd = makeTmpCwd();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "nope\n<disapproved/>" }),
		});
		assert.equal(res.disapproved, true);
		assert.equal(res.approved, false);
	});

	it("passes the built auditor prompt to the session", async () => {
		const cwd = makeTmpCwd();
		let captured = "";
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal({ objective: "OBJ-X" }), detailedSummary: "d",
			createSession: makeMockCreateSession({ finalOutput: "<approved/>", promptHook: (t) => { captured = t; } }),
		});
		assert.match(captured, /OBJ-X/);
		assert.match(captured, /independent completion auditor/);
	});

	it("returns auditor-aborted error when signal already aborted before prompt", async () => {
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		ac.abort();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(res.approved, false);
		assert.equal(res.disapproved, true);
		assert.match(res.error!, /Auditor aborted/);
	});

	it("returns aborted error when signal fires during prompt", async () => {
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		// emit a message_end first (partial output), then abort
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			createSession: makeMockCreateSession({
				finalOutput: "partial",
				events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }],
				promptHook: () => ac.abort(),
			}),
		});
		assert.equal(res.disapproved, true);
		assert.match(res.error!, /Auditor aborted/);
	});

	it("treats AbortError thrown from session as aborted", async () => {
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		ac.abort();
		const err = new Error("aborted");
		err.name = "AbortError";
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			createSession: makeMockCreateSession({ throwInPrompt: err }),
		});
		assert.equal(res.disapproved, true);
		assert.match(res.error!, /Auditor aborted/);
	});

	it("surfaces generic exception message in error", async () => {
		const cwd = makeTmpCwd();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({ throwInPrompt: new Error("boom") }),
		});
		assert.equal(res.disapproved, true);
		assert.match(res.error!, /boom/);
	});

	it("invokes onProgress callback with phase transitions", async () => {
		const cwd = makeTmpCwd();
		const progress: any[] = [];
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			onProgress: (p) => progress.push(p),
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					{ type: "tool_execution_start", toolName: "read", args: { p: "x" } },
					{ type: "tool_execution_end" },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } },
				],
			}),
		});
		assert.ok(progress.length > 0);
		// initial start, tool_executing, back to running, producing_report, done
		const phases = progress.map((p) => p.phase);
		assert.ok(phases.includes("tool_executing"));
		assert.ok(phases.includes("done"));
		assert.equal(progress[progress.length - 1].percentage, 100);
		assert.match(progress[progress.length - 1].label, /Audit complete/);
		// tool args captured
		const toolProg = progress.find((p) => p.phase === "tool_executing");
		assert.equal(toolProg.currentTool, "read");
		assert.ok(toolProg.currentToolArgs.includes("p"));
	});

	it("handles thinking_start/thinking_end stream events", async () => {
		const cwd = makeTmpCwd();
		const progress: any[] = [];
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			onProgress: (p) => progress.push(p),
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
					{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
				],
			}),
		});
		const phases = progress.map((p) => p.phase);
		assert.ok(phases.includes("thinking"));
	});

	it("ignores non-assistant and non-message_end events", async () => {
		const cwd = makeTmpCwd();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					{ type: "other_event" },
					{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } },
				],
			}),
		});
		// user message_end ignored; only the final approved assistant output counts
		assert.equal(res.approved, true);
	});
});
