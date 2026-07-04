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

describe("buildGoalAuditorPrompt — step-8: prompt-size guards", () => {
	it("caps a 200k-char objective to stay under 60k total prompt", () => {
		const huge = "Z".repeat(200_000);
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ objective: huge }),
			detailedSummary: "d",
		});
		assert.ok(out.length < 60_000, `prompt should be capped, got ${out.length} chars`);
		assert.match(out, /\u2026\(\+\d+ chars truncated from objective\)/);
	});

	it("caps detailedSummary when it exceeds the limit", () => {
		const huge = "X".repeat(100_000);
		const out = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: huge,
		});
		assert.match(out, /\u2026\(\+\d+ chars truncated from detailedSummary\)/);
		assert.ok(out.length < 60_000);
	});

	it("caps verificationSummary when it exceeds the limit", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal(),
			detailedSummary: "d",
			verificationSummary: "V".repeat(80_000),
		});
		assert.match(out, /\u2026\(\+\d+ chars truncated from verificationSummary\)/);
	});

	it("caps verificationContract when it exceeds the limit", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ verificationContract: "C".repeat(80_000) }),
			detailedSummary: "d",
		});
		assert.match(out, /\u2026\(\+\d+ chars truncated from verificationContract\)/);
	});

	it("leaves small fields untouched", () => {
		const out = buildGoalAuditorPrompt({
			goal: makeGoal({ objective: "short" }),
			detailedSummary: "short",
			completionSummary: "short",
			verificationSummary: "short",
		});
		assert.doesNotMatch(out, /truncated/);
		assert.match(out, /short/);
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

describe("runGoalCompletionAuditor — compaction enabled (step-2)", () => {
	it("passes a settingsManager with compaction enabled to createSession", async () => {
		const cwd = makeTmpCwd();
		let capturedSettingsManager: any = null;
		const capturingCreate: any = async (sessionArgs: any) => {
			capturedSettingsManager = sessionArgs.settingsManager;
			let subscriber: ((event: any) => void) | null = null;
			const session = {
				subscribe(cb: (event: any) => void) { subscriber = cb; return () => { subscriber = null; }; },
				async prompt(_text: string) {
					subscriber?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } });
				},
				abort() {},
			};
			return { session };
		};
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			createSession: capturingCreate,
		});
		assert.ok(capturedSettingsManager, "settingsManager must be passed to createSession");
		// The auditor session must have compaction ENABLED. Previously this was
		// hardcoded to { enabled: false }, which meant a long audit could blow
		// the context window with no recovery path.
		assert.equal(
			capturedSettingsManager.compaction?.enabled !== false,
			true,
			`expected compaction enabled, got: ${JSON.stringify(capturedSettingsManager.compaction)}`,
		);
	});
});

describe("runGoalCompletionAuditor — B6: onProgress guarded after abort", () => {
	it("does not call onProgress after abort signal fires", async () => {
		// B6 failure mode: after abortAudit nulls auditProgress, late session
		// events could still call onProgress, resurrecting a stale progress
		// object on an already-aborted audit. The fix adds a local `aborted`
		// flag that gates emitProgress.
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		const progressCalls: any[] = [];
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			onProgress: (p) => progressCalls.push(p),
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					// Simulate: event arrives AFTER abort, which is the race window
					{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } },
				],
				promptHook: () => ac.abort(),
			}),
		});
		// After abort, no further onProgress calls should fire.
		// The abort happens during promptHook; subsequent events are the race.
		// Find the last progress call BEFORE vs AFTER abort.
		// Since abort fires during prompt, any progress call that was triggered
		// by events AFTER the abort should NOT exist.
		// We verify by checking that no progress call has phase=thinking
		// (which would come from the thinking_start event AFTER abort).
		const postAbortPhases = progressCalls.map((p) => p.phase);
		assert.ok(
			!postAbortPhases.includes("thinking"),
			`onProgress should not be called after abort, but got phases: ${JSON.stringify(postAbortPhases)}`,
		);
	});

	it("does not call onProgress when signal already aborted before prompt", async () => {
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		ac.abort();
		const progressCalls: any[] = [];
		await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			onProgress: (p) => progressCalls.push(p),
			createSession: makeMockCreateSession({ finalOutput: "<approved/>" }),
		});
		assert.equal(progressCalls.length, 0, "no progress calls when already aborted");
	});

	it("returns aborted result when abort fires during prompt resolution (B6/B9 race)", async () => {
		// B9 defense-in-depth: abort fires while session.prompt() is resolving.
		// The local `aborted` flag is set synchronously, so the post-prompt
		// check catches the abort even if the signal hasn't fully propagated.
		const cwd = makeTmpCwd();
		const ac = new AbortController();
		const res = await runGoalCompletionAuditor({
			ctx: makeCtx(cwd), goal: makeGoal(), detailedSummary: "d",
			signal: ac.signal,
			createSession: makeMockCreateSession({
				finalOutput: "<approved/>",
				events: [
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<approved/>" }] } },
				],
				promptHook: () => {
					// Abort AFTER the message_end event has been emitted but
					// BEFORE prompt() resolves. This is the race window.
					ac.abort();
				},
			}),
		});
		// Must return aborted, NOT approved — even though <approved/> was in
		// the output, the abort takes precedence.
		assert.equal(res.approved, false, "should not approve when aborted during prompt");
		assert.match(res.error!, /Auditor aborted/);
	});
});
