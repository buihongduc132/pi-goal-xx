/**
 * RED→GREEN tests for command-hook-loader (group 6, D4/D5).
 *
 * Spec: openspec/changes/unified-prompt-config/specs/command-hooks/spec.md
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	wrapHandler,
	loadHook,
	type LoadedHook,
	type CommandHandler,
} from "../extensions/command-hook-loader.ts";
import type { GoalSettings, CommandHooksConfig } from "../extensions/goal-settings.ts";

/** Build a fake handler that records calls + returns a value. */
function fakeHandler(label: string, log: string[]): CommandHandler {
	return async (args: string) => {
		log.push(`builtin:${label}(${args})`);
		return `builtin:${label}`;
	};
}

describe("wrapHandler — enabled gate", () => {
	it("returns original unchanged when commandHooks absent", () => {
		const log: string[] = [];
		const original = fakeHandler("goals", log);
		const wrapped = wrapHandler("goals", original, undefined, "/cwd");
		assert.equal(wrapped, original, "no wrapping when settings undefined");
	});

	it("returns original when enabled is false (default)", () => {
		const log: string[] = [];
		const original = fakeHandler("goals", log);
		const settings = { commandHooks: { enabled: false } } as GoalSettings;
		const wrapped = wrapHandler("goals", original, settings, "/cwd");
		assert.equal(wrapped, original);
	});
});

describe("wrapHandler — append mode", () => {
	it("runs pre → builtin → post in append mode", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {
			pre: async (args: string) => { log.push(`pre(${args})`); return { transformArgs: args + "-pre" }; },
			post: async (args: string) => { log.push(`post(${args})`); },
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		await wrapped("ARG", {} as never);
		assert.deepEqual(log, ["pre(ARG)", "builtin:goals(ARG-pre)", "post(ARG)"]);
	});

	it("builtin receives transformed args from pre", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {
			pre: async () => ({ transformArgs: "TRANSFORMED" }),
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		await wrapped("orig", {} as never);
		assert.equal(log[0], "builtin:goals(TRANSFORMED)");
	});

	it("works without pre/post (just builtin)", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {};
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		await wrapped("A", {} as never);
		assert.deepEqual(log, ["builtin:goals(A)"]);
	});
});

describe("wrapHandler — override mode", () => {
	it("runs ONLY the hook handler, builtin not called", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {
			handler: async (args: string, _ctx: unknown, builtin: CommandHandler) => {
				log.push(`override(${args})`);
				return "override-result";
			},
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "override" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		const result = await wrapped("ARG", {} as never);
		assert.equal(result, "override-result");
		assert.deepEqual(log, ["override(ARG)"], "builtin must NOT run in override mode");
	});

	it("override handler can delegate to builtin (3rd arg)", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {
			handler: async (args: string, _ctx: unknown, builtin: CommandHandler) => {
				log.push("before");
				await builtin(args, _ctx);
				log.push("after");
			},
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "override" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		await wrapped("X", {} as never);
		assert.deepEqual(log, ["before", "builtin:goals(X)", "after"]);
	});
});

describe("wrapHandler — error isolation", () => {
	it("pre-hook throwing falls back to builtin with original args", async () => {
		const log: string[] = [];
		const hook: LoadedHook = {
			pre: async () => { throw new Error("pre-boom"); },
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", log), settings, "/cwd", hook);
		await wrapped("ARG", { ui: { notify: () => {} } } as never);
		assert.ok(log.some((l) => l.startsWith("builtin:goals(ARG)")), "builtin ran with original args");
	});

	it("handler throwing in override propagates (not swallowed)", async () => {
		const hook: LoadedHook = {
			handler: async () => { throw new Error("override-boom"); },
		};
		const settings = { commandHooks: { enabled: true, goals: { mode: "override" } } } as unknown as GoalSettings;
		const wrapped = wrapHandler("goals", fakeHandler("goals", []), settings, "/cwd", hook);
		await assert.rejects(() => wrapped("A", { ui: { notify: () => {} } } as never), /override-boom/);
	});
});

describe("loadHook — enabled gate", () => {
	it("returns undefined when commandHooks.enabled is false", async () => {
		const settings = { commandHooks: { enabled: false } } as GoalSettings;
		const h = await loadHook("goals", "/cwd", settings, { importer: async () => ({}) });
		assert.equal(h, undefined);
	});

	it("returns undefined when no config for the command", async () => {
		const settings = { commandHooks: { enabled: true, "other-cmd": { mode: "append" } } } as GoalSettings;
		const h = await loadHook("goals", "/cwd", settings, { importer: async () => ({}) });
		assert.equal(h, undefined);
	});

	it("returns undefined when importer throws (error isolation)", async () => {
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as GoalSettings;
		const h = await loadHook("goals", "/cwd", settings, {
			importer: async () => { throw new Error("syntax error in hook"); },
		});
		assert.equal(h, undefined, "import error must be isolated → undefined");
	});

	it("returns the loaded hook module when enabled + configured", async () => {
		const settings = { commandHooks: { enabled: true, goals: { mode: "append" } } } as GoalSettings;
		const fakeModule = { pre: async () => {} };
		const h = await loadHook("goals", "/cwd", settings, { importer: async () => fakeModule });
		assert.ok(h);
		assert.equal(typeof h.pre, "function");
	});
});
