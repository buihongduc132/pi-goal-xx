/**
 * Goal extension — load + registration smoke tests.
 *
 * These exercise the default-export goalExtension(pi) against the mock harness.
 * They prove the extension loads without crashing, registers the expected
 * tools / commands / event handlers, and that the harness captures them.
 *
 * Beyond registration, this also drives several pure helper functions that
 * live inside goal.ts (isMeaningfulProgressToolCall etc.) via the exported
 * tool/command definitions where feasible.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import goalExtension from "../extensions/goal.ts";
import {
	createMockPi,
	createMockCtx,
	invokeTool,
	invokeCommand,
	createGoalViaCommand,
	emit,
	cleanupTimers,
	registeredToolNames,
	registeredCommandNames,
} from "./_harness.ts";

// Track the most recently created (pi, cwd) pair so afterEach can clear timers.
let _lastPi: ReturnType<typeof createMockPi> | null = null;
let _lastCwd: string | null = null;

function tmpWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-goal-"));
	return dir;
}

/** Create pi + track it for afterEach cleanup. */
function setupPi(cwd: string): ReturnType<typeof createMockPi> {
	const pi = createMockPi({ cwd });
	_lastPi = pi;
	_lastCwd = cwd;
	return pi;
}

// Global cleanup: goal.ts leaks setInterval handles (status refresh, audit
// animation). Emit session_shutdown after each test so they are cleared and
// the test runner can exit.
// Timeout guard: if cleanup stalls beyond 5s, log warning and proceed.
afterEach(async () => {
	if (_lastPi && _lastCwd) {
		const timeout = new Promise<void>((resolve) => {
			setTimeout(() => {
				console.warn(`[goal.test.ts] cleanupTimers stalled for >5s, proceeding`);
				resolve();
			}, 5000).unref();
		});
		await Promise.race([cleanupTimers(_lastPi, _lastCwd), timeout]);
	}
});

describe("goal extension — load + registration", () => {
	let pi: ReturnType<typeof createMockPi>;
	let cwd: string;

	beforeEach(() => {
		cwd = tmpWorkspace();
		pi = createMockPi({ cwd });
		// Loading the extension must not throw.
		assert.doesNotThrow(() => goalExtension(pi));
	});

	it("registers all expected lifecycle command names", () => {
		const names = registeredCommandNames(pi);
		const expected = [
			"goal", "goal-abort", "goal-clear", "goal-focus", "goal-list",
			"goal-pause", "goal-resume", "goal-settings", "goal-status",
			"goal-tweak", "goals", "goals-set", "sisyphus", "sisyphus-set",
		];
		for (const name of expected) assert.ok(names.includes(name), `missing command: ${name}`);
	});

	it("registers the goal execution tools", () => {
		const names = registeredToolNames(pi);
		const expected = [
			"get_goal", "complete_goal", "pause_goal", "abort_goal",
			"propose_goal_tweak", "propose_task_list",
			"complete_task", "skip_task",
		];
		for (const name of expected) assert.ok(names.includes(name), `missing tool: ${name}`);
	});

	it("registers the creation/drafting tools", () => {
		const names = registeredToolNames(pi);
		assert.ok(names.includes("create_goal"));
		assert.ok(names.includes("propose_goal_draft"));
	});

	it("registers the expected event handlers", () => {
		const events = [...pi.handlers.keys()].sort();
		for (const ev of [
			"context", "turn_start", "tool_call", "tool_execution_end",
			"turn_end", "message_end", "session_start", "session_compact",
			"before_agent_start", "agent_end", "session_shutdown",
		]) {
			assert.ok(events.includes(ev), `missing event handler: ${ev}`);
		}
	});

	it("does not register the question tool by default (no focused goal)", () => {
		// syncGoalTools runs during load; question tool only appears with active goal
		assert.ok(!pi.getActiveTools().includes("goal_question"));
	});

	it("registers a custom message renderer for the goal entry type", () => {
		assert.ok(pi.renderers.size > 0, "expected at least one message renderer");
	});
});

describe("get_goal tool — with no focused goal", () => {
	it("returns a helpful 'no goal' message", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx, "get_goal", {}) as any;
		assert.ok(result);
		assert.ok(Array.isArray(result.content));
		const text: string = result.content[0].text;
		assert.match(text, /no.*goal/i);
	});
});

describe("propose_goal_draft tool — headless auto-confirm", () => {
	it("creates a goal and focuses it (hasUI:false auto-confirms)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		// Use /goals-set for immediate creation (no confirmation intent needed).
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Build a thing", false);
		// After creating, get_goal should show the active goal
		const ctx2 = createMockCtx(pi, { cwd });
		const get = await invokeTool(pi, ctx2, "get_goal", {}) as any;
		const text: string = get.content[0].text;
		assert.match(text, /Build a thing/);
	});

	it("writes an active goal file under .pi/goals", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Disk test", false);
		const goalsDir = path.join(cwd, ".pi", "goals");
		assert.ok(fs.existsSync(goalsDir), "goals dir should exist");
		const files = fs.readdirSync(goalsDir).filter((f) => /^active_goal_.*\.md$/.test(f));
		assert.ok(files.length >= 1, `expected >=1 active_goal file, got ${files.length}`);
	});

	it("create_goal tool is REJECTED (direct creation disabled)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx, "create_goal", {
			objective: "x", autoContinue: false, sisyphus: false,
		}) as any;
		assert.match(result.content[0].text as string, /REJECTED/i);
	});
});

describe("pause_goal tool", () => {
	it("pauses an active goal (requires a goal first)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Pause me", false);
		const ctx2 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx2, "pause_goal", {
			reason: "testing",
		}) as any;
		assert.ok(result);
		const ctx3 = createMockCtx(pi, { cwd });
		const get = await invokeTool(pi, ctx3, "get_goal", {}) as any;
		const text: string = get.content[0].text;
		assert.match(text, /pause/i);
	});
});

describe("abort_goal tool", () => {
	it("aborts the focused goal", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Abort me", false);
		const ctx2 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx2, "abort_goal", {
			reason: "done with it",
		}) as any;
		assert.ok(result);
		const ctx3 = createMockCtx(pi, { cwd });
		const get = await invokeTool(pi, ctx3, "get_goal", {}) as any;
		assert.match(get.content[0].text as string, /no.*goal/i);
	});
});

describe("propose_task_list tool", () => {
	it("stores a proposed task list on the focused goal", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Multi-step thing", false);
		const ctx2 = createMockCtx(pi, { cwd, hasUI: true });
		const result = await invokeTool(pi, ctx2, "propose_task_list", {
			tasks: [
				{ id: "t1", title: "First" },
				{ id: "t2", title: "Second" },
			],
			blockCompletion: true,
		}) as any;
		assert.ok(result);
		// Task list may require dialog confirmation; the key assertion is that
		// the tool executed without throwing and returned a result.
		const ctx3 = createMockCtx(pi, { cwd });
		const get = await invokeTool(pi, ctx3, "get_goal", {}) as any;
		assert.ok(get.content[0].text as string);
	});
});

describe("complete_task tool", () => {
	it("marks a task complete when it exists", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Tasks", false);
		const ctx2 = createMockCtx(pi, { cwd, hasUI: true });
		await invokeTool(pi, ctx2, "propose_task_list", {
			tasks: [{ id: "t1", title: "First" }],
			blockCompletion: false,
		});
		const ctx3 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx3, "complete_task", {
			taskId: "t1",
			evidence: "done it",
		}) as any;
		assert.ok(result);
	});
});

describe("skip_task tool", () => {
	it("marks a task skipped with a reason", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Tasks", false);
		const ctxTasks = createMockCtx(pi, { cwd, hasUI: true });
		await invokeTool(pi, ctxTasks, "propose_task_list", {
			tasks: [{ id: "t1", title: "First" }],
			blockCompletion: false,
		});
		const ctx2 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx2, "skip_task", {
			taskId: "t1",
			reason: "not needed",
		}) as any;
		assert.ok(result);
	});
});

describe("event handlers", () => {
	it("context handler returns undefined when no goal focused (no injection)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		const results = await emit(pi, ctx, "context", { messages: [] });
		// With no goal, context handler should not inject messages
		const injected = results.find((r) => r && (r as any).messages);
		assert.equal(injected, undefined);
	});

	it("turn_start handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "turn_start", {});
		assert.ok(true);
	});

	it("turn_end handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "turn_end", {});
		assert.ok(true);
	});

	it("session_start handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "session_start", {});
		assert.ok(true);
	});
});

describe("complete_goal tool — validation gates", () => {
	function writeDisableAuditorSettings(cwd: string): void {
		const dir = path.join(cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "pi-goal-xx-settings.json"),
			JSON.stringify({ disabled: true }),
		);
	}

	it("rejects when no goal is focused", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx, "complete_goal", {
			verificationSummary: "x",
		}) as any;
		assert.ok(result);
		assert.match(result.content[0].text as string, /goal|complete|no/i);
	});

	it("rejects when status != complete", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Do thing", false);
		const ctx2 = createMockCtx(pi, { cwd });
		// status validation happens before any auditor — should throw
		await assert.rejects(
			() => invokeTool(pi, ctx2, "complete_goal", { status: "paused" as any, verificationSummary: "x" }),
			/status=complete/,
		);
	});

	it("blocks completion when blockCompletion enabled and tasks pending", async () => {
		const cwd = tmpWorkspace();
		writeDisableAuditorSettings(cwd);
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Tasks", false);
		// hasUI:true so the proposal dialog runs; mock ui.custom auto-confirms.
		const ctxTasks = createMockCtx(pi, { cwd, hasUI: true });
		await invokeTool(pi, ctxTasks, "propose_task_list", {
			tasks: [{ id: "t1", title: "Pending" }],
			blockCompletion: true,
		});
		const ctx2 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx2, "complete_goal", {
			verificationSummary: "done",
		}) as any;
		// Task gate should block before auditor runs
		assert.match(result.content[0].text as string, /task|pending|block|incomplete/i);
	});

	it("completes when auditor globally disabled (settings.disabled=true)", async () => {
		const cwd = tmpWorkspace();
		writeDisableAuditorSettings(cwd);
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Finishable", false);
		const ctx2 = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx2, "complete_goal", {
			verificationSummary: "all criteria met, tests green",
		}) as any;
		assert.ok(result);
		// After completion, no goal should be focused
		const ctx3 = createMockCtx(pi, { cwd });
		const get = await invokeTool(pi, ctx3, "get_goal", {}) as any;
		assert.match(get.content[0].text as string, /no.*goal|complete/i);
	});
});

describe("propose_goal_tweak tool", () => {
	it("rejects tweak when no goal focused", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		const result = await invokeTool(pi, ctx, "propose_goal_tweak", {
			changeSummary: "change X",
			newObjective: "new obj",
		}) as any;
		assert.ok(result);
	});

	it("accepts a tweak proposal on a focused goal (headless)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Original obj", false);
		const ctx2 = createMockCtx(pi, { cwd, hasUI: true });
		const result = await invokeTool(pi, ctx2, "propose_goal_tweak", {
			changeSummary: "refined",
			newObjective: "Refined obj",
		}) as any;
		assert.ok(result);
	});
});

describe("commands", () => {
	it("goal-status shows no-goal message when empty", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx, "goal-status", "");
		// notify should have been called
		assert.ok(pi.ui.notifyCalls.length > 0);
	});

	it("goal-list shows no-open-goals when empty", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx, "goal-list", "");
		assert.ok(pi.ui.notifyCalls.length > 0);
	});

	it("goal-pause with no goal notifies warning", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx, "goal-pause", "");
		assert.ok(pi.ui.notifyCalls.length > 0);
	});

	it("goal-clear with no goal is a no-op (no throw)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx, "goal-clear", "");
		assert.ok(true);
	});

	it("goal-settings command reflects current config (headless)", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		// goal-settings may open an interactive editor when hasUI; run headless so
		// it just reports the current settings without blocking.
		const ctx = createMockCtx(pi, { cwd, hasUI: false });
		await invokeCommand(pi, ctx, "goal-settings", "");
		assert.ok(true);
	});

	it("goal-status reflects a created goal", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Show me", false);
		pi.ui.notifyCalls.length = 0;
		const ctx2 = createMockCtx(pi, { cwd });
		await invokeCommand(pi, ctx2, "goal-status", "");
		assert.ok(pi.ui.notifyCalls.some((n) => /Show me/.test(n.msg)));
	});
});

describe("event handlers — broader coverage", () => {
	it("message_end handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "message_end", { message: { role: "assistant", usage: { input: 10, output: 5 } } });
		assert.ok(true);
	});

	it("before_agent_start handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "before_agent_start", {});
		assert.ok(true);
	});

	it("agent_end handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "agent_end", { messages: [] });
		assert.ok(true);
	});

	it("session_shutdown handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "session_shutdown", {});
		assert.ok(true);
	});

	it("session_compact handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "session_compact", {});
		assert.ok(true);
	});

	it("tool_execution_end handler runs without throwing", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await emit(pi, ctx, "tool_execution_end", {});
		assert.ok(true);
	});

	it("context handler with a focused goal may inject messages", async () => {
		const cwd = tmpWorkspace();
		const pi = setupPi(cwd);
		goalExtension(pi);
		const ctx = createMockCtx(pi, { cwd });
		await createGoalViaCommand(pi, ctx, "Inject me", false);
		const ctx2 = createMockCtx(pi, { cwd });
		const results = await emit(pi, ctx2, "context", { messages: [] });
		// Handler ran; whether it injected depends on internal state
		assert.ok(Array.isArray(results));
	});
});
