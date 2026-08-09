/**
 * RED PHASE — auditor global settings drift regression guard.
 *
 * Contract under test (see flow/bugs/2026-07-17_auditor-timeout-global-settings-drift.md):
 * pi-goal-xx-settings.json must be loadable from a GLOBAL location
 * (dirname(PI_CODING_AGENT_DIR) / "pi-goal-xx-settings.json") as the BASE
 * layer, with project-local overlay and env override on top.
 *
 * Precedence:  env  >  project-local  >  global  >  defaults.
 *
 * This file is expected to FAIL against current code:
 *   - `globalGoalSettingsPath` is not yet exported → import error (whole file).
 *   - even after the export exists, R1/R2 must hold once the global file is
 *     actually merged into loadGoalSettingsFileConfig.
 *
 * Do NOT implement the fix here. RED only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadGoalSettings,
	globalGoalSettingsPath,
	PI_GOAL_AUDITOR_TIMEOUT_MS_ENV,
} from "../extensions/goal-settings.ts";

const SETTINGS_FILE = "pi-goal-xx-settings.json";

/** Make a fresh temp project cwd with the optional project-local settings written to disk. */
function makeCwd(settings?: Record<string, unknown>): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-glob-project-"));
	if (settings && Object.keys(settings).length > 0) {
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tmp, ".pi", SETTINGS_FILE), JSON.stringify(settings));
	}
	return tmp;
}

/**
 * Make a fresh temp "pi home" layout mirroring the real ~/.pi structure:
 *   <base>/agent                      ← PI_CODING_AGENT_DIR
 *   <base>/pi-goal-xx-settings.json   ← global settings (optional)
 * Returns the base dir (for cleanup), the agent dir (for PI_CODING_AGENT_DIR),
 * and the resolved global settings path.
 */
function makePiHome(global?: Record<string, unknown>): {
	base: string;
	agentDir: string;
	globalPath: string;
} {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-glob-pihome-"));
	const agentDir = path.join(base, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const globalPath = path.join(base, SETTINGS_FILE);
	if (global && Object.keys(global).length > 0) {
		fs.writeFileSync(globalPath, JSON.stringify(global));
	}
	return { base, agentDir, globalPath };
}

/** Cleanly remove a temp dir (best-effort; never fail the test on cleanup). */
function cleanup(tmp: string): void {
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

describe("auditor global settings — R6: globalGoalSettingsPath resolution", () => {
	it("resolves via PI_CODING_AGENT_DIR (dirname of the agent dir)", () => {
		const env = { PI_CODING_AGENT_DIR: "/tmp/x/agent" };
		const resolved = globalGoalSettingsPath(env);
		// dirname("/tmp/x/agent") === "/tmp/x"  →  global file lives one level above agent dir
		assert.equal(resolved, path.join("/tmp/x", SETTINGS_FILE));
	});

	it("falls back to ~/.pi parent when PI_CODING_AGENT_DIR unset", () => {
		const env = {};
		const resolved = globalGoalSettingsPath(env);
		assert.equal(resolved, path.join(os.homedir(), ".pi", SETTINGS_FILE));
	});
});

describe("auditor global settings — R1: global loaded when project-local absent", () => {
	it("global auditorTimeoutMs applies with no project-local file", () => {
		const pi = makePiHome({ auditorTimeoutMs: 777 });
		const project = makeCwd(); // no project-local file
		try {
			const env = { PI_CODING_AGENT_DIR: pi.agentDir };
			const s = loadGoalSettings(project, env);
			assert.equal(s.auditorTimeoutMs, 777, "global file must supply auditorTimeoutMs");
		} finally {
			cleanup(pi.base);
			cleanup(project);
		}
	});
});

describe("auditor global settings — R2: project-local overrides global per-key", () => {
	it("project-local auditorTimeoutMs wins over global", () => {
		const pi = makePiHome({ auditorTimeoutMs: 777 });
		const project = makeCwd({ auditorTimeoutMs: 999 });
		try {
			const env = { PI_CODING_AGENT_DIR: pi.agentDir };
			const s = loadGoalSettings(project, env);
			assert.equal(s.auditorTimeoutMs, 999, "project-local must win per-key over global");
		} finally {
			cleanup(pi.base);
			cleanup(project);
		}
	});
});

describe("auditor global settings — R3: env overrides global + project-local", () => {
	it("PI_GOAL_AUDITOR_TIMEOUT_MS wins over both global and project-local", () => {
		const pi = makePiHome({ auditorTimeoutMs: 777 });
		const project = makeCwd({ auditorTimeoutMs: 999 });
		try {
			const env = {
				PI_CODING_AGENT_DIR: pi.agentDir,
				[PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]: "12345",
			};
			const s = loadGoalSettings(project, env);
			assert.equal(s.auditorTimeoutMs, 12_345, "env must win over both global and project-local");
		} finally {
			cleanup(pi.base);
			cleanup(project);
		}
	});
});

describe("auditor global settings — R4: both global + local absent → undefined", () => {
	it("no global file + no project-local → auditorTimeoutMs undefined (default applied later in goal-auditor.ts)", () => {
		const pi = makePiHome(); // no global file
		const project = makeCwd(); // no project-local file
		try {
			const env = { PI_CODING_AGENT_DIR: pi.agentDir };
			const s = loadGoalSettings(project, env);
			assert.equal(
				s.auditorTimeoutMs,
				undefined,
				"undefined preserved so goal-auditor.ts applies its documented default",
			);
		} finally {
			cleanup(pi.base);
			cleanup(project);
		}
	});
});

describe("auditor global settings — R5: malformed global file does not throw", () => {
	it("malformed global JSON is swallowed silently (matches existing loadGoalSettingsFileConfig semantics)", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-glob-bad-"));
		const agentDir = path.join(base, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(base, SETTINGS_FILE), "{ not valid json");
		const project = makeCwd(); // no project-local file
		try {
			const env = { PI_CODING_AGENT_DIR: agentDir };
			// must not throw — mirrors the silent-swallow catch in loadGoalSettingsFileConfig
			const s = loadGoalSettings(project, env);
			assert.equal(s.auditorTimeoutMs, undefined, "malformed global must be silently ignored");
		} finally {
			cleanup(base);
			cleanup(project);
		}
	});
});
