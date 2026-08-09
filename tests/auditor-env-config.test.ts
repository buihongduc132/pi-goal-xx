import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	PI_GOAL_AUDITOR_TIMEOUT_MS_ENV,
	PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV,
	type GoalSettings,
} from "../extensions/goal-settings.ts";
import { isolatedSettingsEnv } from "./_test-helpers.ts";

/** Make a fresh temp cwd with the optional settings object written to disk. */
function makeCwd(settings?: Record<string, unknown>): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-audenv-"));
	if (settings && Object.keys(settings).length > 0) {
		fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi", "pi-goal-xx-settings.json"),
			JSON.stringify(settings),
		);
	}
	return tmp;
}

/** Cleanly remove a temp cwd (best-effort; never fail the test on cleanup). */
function cleanup(tmp: string): void {
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

describe("auditor env config — PI_GOAL_AUDITOR_TIMEOUT_MS (Zone 4: env override precedence)", () => {
	it("env var overrides file config", () => {
		const tmp = makeCwd({ auditorTimeoutMs: 300_000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]: "600000" });
			assert.equal(s.auditorTimeoutMs, 600_000, "env var must win over file config");
		} finally {
			cleanup(tmp);
		}
	});
});

describe("auditor env config — PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS (Zone 4: env override precedence)", () => {
	it("env var overrides file config", () => {
		const tmp = makeCwd({ auditorTimeoutFloorMs: 2000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV]: "5000" });
			assert.equal(s.auditorTimeoutFloorMs, 5000, "env var must win over file config");
		} finally {
			cleanup(tmp);
		}
	});
});

describe("auditor env config — Zone 1: env not set falls back to file config", () => {
	it("both settings fall back to file config when env unset", () => {
		const tmp = makeCwd({ auditorTimeoutMs: 300_000, auditorTimeoutFloorMs: 2000 });
		try {
			const s = loadGoalSettings(tmp, {});
			assert.equal(s.auditorTimeoutMs, 300_000, "file value used when env unset");
			assert.equal(s.auditorTimeoutFloorMs, 2000, "file value used when env unset");
		} finally {
			cleanup(tmp);
		}
	});
});

describe("auditor env config — Zone 2: invalid env value ignored", () => {
	it("negative env value falls back to file config", () => {
		const tmp = makeCwd({ auditorTimeoutMs: 300_000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]: "-1" });
			assert.equal(s.auditorTimeoutMs, 300_000, "negative env must be ignored");
		} finally {
			cleanup(tmp);
		}
	});

	it("zero env value falls back to file config (asPositiveInt rejects 0)", () => {
		const tmp = makeCwd({ auditorTimeoutMs: 300_000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]: "0" });
			assert.equal(s.auditorTimeoutMs, 300_000, "zero env must be ignored (floor of 1 in asPositiveInt)");
		} finally {
			cleanup(tmp);
		}
	});

	it("non-numeric env value falls back to file config", () => {
		const tmp = makeCwd({ auditorTimeoutMs: 300_000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_MS_ENV]: "abc" });
			assert.equal(s.auditorTimeoutMs, 300_000, "non-numeric env must be ignored");
		} finally {
			cleanup(tmp);
		}
	});

	it("negative floor env value falls back to file config", () => {
		const tmp = makeCwd({ auditorTimeoutFloorMs: 2000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV]: "-1" });
			assert.equal(s.auditorTimeoutFloorMs, 2000, "negative floor env must be ignored");
		} finally {
			cleanup(tmp);
		}
	});

	it("zero floor env value falls back to file config (asPositiveInt rejects 0)", () => {
		const tmp = makeCwd({ auditorTimeoutFloorMs: 2000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV]: "0" });
			assert.equal(s.auditorTimeoutFloorMs, 2000, "zero floor env must be ignored (floor of 1 in asPositiveInt)");
		} finally {
			cleanup(tmp);
		}
	});

	it("non-numeric floor env value falls back to file config", () => {
		const tmp = makeCwd({ auditorTimeoutFloorMs: 2000 });
		try {
			const s = loadGoalSettings(tmp, { [PI_GOAL_AUDITOR_TIMEOUT_FLOOR_MS_ENV]: "abc" });
			assert.equal(s.auditorTimeoutFloorMs, 2000, "non-numeric floor env must be ignored");
		} finally {
			cleanup(tmp);
		}
	});
});

describe("auditor env config — Zone 5: round-trip persistence", () => {
	it("saveGoalSettingsFileConfig round-trips auditorTimeoutFloorMs", () => {
		const tmp = makeCwd();
		try {
			const original: GoalSettings = { auditorTimeoutFloorMs: 5000 };
			saveGoalSettingsFileConfig(tmp, original);
			const loaded = loadGoalSettingsFileConfig(tmp, {});
			assert.equal(loaded.auditorTimeoutFloorMs, 5000, "auditorTimeoutFloorMs must survive a save→load round-trip");
			// Also confirm it landed in the JSON file (not just the clean object).
			const raw = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"));
			assert.equal(raw.auditorTimeoutFloorMs, 5000, "auditorTimeoutFloorMs must be persisted to the settings file");
		} finally {
			cleanup(tmp);
		}
	});

	it("saveGoalSettingsFileConfig round-trips auditorTimeoutMs (regression guard)", () => {
		const tmp = makeCwd();
		try {
			const original: GoalSettings = { auditorTimeoutMs: 77_000 };
			saveGoalSettingsFileConfig(tmp, original);
			const loaded = loadGoalSettingsFileConfig(tmp, {});
			assert.equal(loaded.auditorTimeoutMs, 77_000, "auditorTimeoutMs must survive a save→load round-trip");
			const raw = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"));
			assert.equal(raw.auditorTimeoutMs, 77_000, "auditorTimeoutMs must be persisted to the settings file");
		} finally {
			cleanup(tmp);
		}
	});
});

describe("auditor env config — Zone 1: defaults when nothing configured", () => {
	it("both undefined when no file config and no env", () => {
		const tmp = makeCwd();
		try {
			const s = loadGoalSettings(tmp, isolatedSettingsEnv());
			// Defaults are applied in goal-auditor.ts (15min / 1s), NOT in
			// loadGoalSettings — settings stays undefined here so the auditor
			// layer can supply its own documented defaults.
			assert.equal(s.auditorTimeoutMs, undefined, "no config → undefined (default applied in goal-auditor.ts)");
			assert.equal(s.auditorTimeoutFloorMs, undefined, "no config → undefined (default applied in goal-auditor.ts)");
		} finally {
			cleanup(tmp);
		}
	});
});
