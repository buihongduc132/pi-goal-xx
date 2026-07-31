/**
 * RED phase — Pre-audit hooks settings schema (LD2, LD5, LD8).
 *
 * These tests FAIL because the implementation does not exist yet:
 *   - `preAuditHooks` is not in ALLOWED_SETTINGS_KEYS → parseGoalSettings throws
 *     "Unknown pi-goal-xx-settings.json key(s): preAuditHooks" (additionalProperties:false).
 *   - The `PreAuditHooksConfig` / `PreAuditHookPassCriteria` interfaces do not exist.
 *   - `parseGoalSettings` / `saveGoalSettingsFileConfig` do not round-trip preAuditHooks.
 *
 * Spec:
 *   - flow/findings/2026-07-31-auditor-capabilities-gaps/2026-07-31-locked-decisions.yaml (LD2, LD5, LD8)
 *   - flow/plans/2026-07-31_pre-audit-hooks-and-early-disapprove.md
 *
 * Schema (LD8):
 *   preAuditHooks:
 *     enabled: true                          # MUST be true to load
 *     globalScript: "/abs/path/check.sh"     # optional absolute
 *     localScript: "./.pi/hooks/pre-audit.sh" # optional cwd-relative
 *     passCriteria:
 *       status: 0                            # default 0
 *       regex: "PASS|SUCCESS"                # default "" = skip
 *       stream: "both"                       # stdout | stderr | both (default both)
 *       combinator: "AND"                    # AND | OR (default AND)
 *       negate: false                        # default false
 *     injectOutput: true                     # default true
 *     maxOutputChars: 5000                   # default 5000
 *     timeoutMs: 30000                       # default 30000
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseGoalSettings,
	saveGoalSettingsFileConfig,
	loadGoalSettingsFileConfig,
	type GoalSettings,
	type PreAuditHooksConfig,
	type PreAuditHookPassCriteria,
} from "../extensions/goal-settings.ts";
import { isolatedSettingsEnv } from "./_test-helpers.ts";

describe("preAuditHooks — block parses with defaults (LD8)", () => {
	it("parses a fully-specified preAuditHooks block with nested passCriteria", () => {
		const s = parseGoalSettings({
			preAuditHooks: {
				enabled: true,
				globalScript: "/abs/check.sh",
				localScript: "./.pi/hooks/pre-audit.sh",
				passCriteria: {
					status: 0,
					regex: "PASS|SUCCESS",
					stream: "both",
					combinator: "AND",
					negate: false,
				},
				injectOutput: true,
				maxOutputChars: 5000,
				timeoutMs: 30000,
			},
		});
		assert.ok(s.preAuditHooks, "preAuditHooks block must parse");
		assert.equal(s.preAuditHooks.enabled, true);
		assert.equal(s.preAuditHooks.globalScript, "/abs/check.sh");
		assert.equal(s.preAuditHooks.localScript, "./.pi/hooks/pre-audit.sh");
		assert.ok(s.preAuditHooks.passCriteria, "passCriteria must parse");
		assert.equal(s.preAuditHooks.passCriteria.status, 0);
		assert.equal(s.preAuditHooks.passCriteria.regex, "PASS|SUCCESS");
		assert.equal(s.preAuditHooks.passCriteria.stream, "both");
		assert.equal(s.preAuditHooks.passCriteria.combinator, "AND");
		assert.equal(s.preAuditHooks.passCriteria.negate, false);
		assert.equal(s.preAuditHooks.injectOutput, true);
		assert.equal(s.preAuditHooks.maxOutputChars, 5000);
		assert.equal(s.preAuditHooks.timeoutMs, 30000);
	});

	it("enabled defaults to false when block present but enabled omitted", () => {
		const s = parseGoalSettings({ preAuditHooks: {} });
		assert.ok(s.preAuditHooks, "block present must parse");
		assert.equal(s.preAuditHooks.enabled, false, "enabled must default to false");
	});

	it("enabled MUST be true to load (false/absent means gate inactive)", () => {
		assert.equal(parseGoalSettings({ preAuditHooks: { enabled: false } }).preAuditHooks?.enabled, false);
		assert.equal(parseGoalSettings({ preAuditHooks: { enabled: true } }).preAuditHooks?.enabled, true);
	});

	it("preAuditHooks is undefined when the key is absent entirely", () => {
		assert.equal(parseGoalSettings({}).preAuditHooks, undefined);
	});
});

describe("preAuditHooks — passCriteria defaults (LD8)", () => {
	it("passCriteria.status defaults to 0", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: {} } });
		assert.equal(s.preAuditHooks?.passCriteria?.status, 0);
	});

	it("passCriteria.regex defaults to '' (skip)", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: {} } });
		assert.equal(s.preAuditHooks?.passCriteria?.regex, "");
	});

	it("passCriteria.stream defaults to 'both'", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: {} } });
		assert.equal(s.preAuditHooks?.passCriteria?.stream, "both");
	});

	it("passCriteria.stream accepts stdout / stderr / both", () => {
		for (const stream of ["stdout", "stderr", "both"] as const) {
			const s = parseGoalSettings({
				preAuditHooks: { enabled: true, passCriteria: { stream } },
			});
			assert.equal(s.preAuditHooks?.passCriteria?.stream, stream);
		}
	});

	it("passCriteria.stream rejects invalid values (falls back to default 'both')", () => {
		const s = parseGoalSettings({
			preAuditHooks: { enabled: true, passCriteria: { stream: "bogus" } },
		});
		assert.equal(s.preAuditHooks?.passCriteria?.stream, "both");
	});

	it("passCriteria.combinator defaults to 'AND'", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: {} } });
		assert.equal(s.preAuditHooks?.passCriteria?.combinator, "AND");
	});

	it("passCriteria.combinator accepts AND / OR", () => {
		for (const combinator of ["AND", "OR"] as const) {
			const s = parseGoalSettings({
				preAuditHooks: { enabled: true, passCriteria: { combinator } },
			});
			assert.equal(s.preAuditHooks?.passCriteria?.combinator, combinator);
		}
	});

	it("passCriteria.combinator rejects invalid values (falls back to 'AND')", () => {
		const s = parseGoalSettings({
			preAuditHooks: { enabled: true, passCriteria: { combinator: "XOR" } },
		});
		assert.equal(s.preAuditHooks?.passCriteria?.combinator, "AND");
	});

	it("passCriteria.negate defaults to false", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: {} } });
		assert.equal(s.preAuditHooks?.passCriteria?.negate, false);
	});

	it("passCriteria.negate coerces true/false/string forms", () => {
		assert.equal(
			parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: { negate: true } } }).preAuditHooks?.passCriteria?.negate,
			true,
		);
		assert.equal(
			parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: { negate: "true" } } }).preAuditHooks?.passCriteria?.negate,
			true,
		);
		assert.equal(
			parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: { negate: false } } }).preAuditHooks?.passCriteria?.negate,
			false,
		);
	});
});

describe("preAuditHooks — top-level block defaults (LD8)", () => {
	it("injectOutput defaults to true", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true } });
		assert.equal(s.preAuditHooks?.injectOutput, true);
	});

	it("maxOutputChars defaults to 5000", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true } });
		assert.equal(s.preAuditHooks?.maxOutputChars, 5000);
	});

	it("timeoutMs defaults to 30000", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true } });
		assert.equal(s.preAuditHooks?.timeoutMs, 30000);
	});

	it("globalScript / localScript default to undefined (both optional)", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true } });
		assert.equal(s.preAuditHooks?.globalScript, undefined);
		assert.equal(s.preAuditHooks?.localScript, undefined);
	});
});

describe("preAuditHooks — additionalProperties:false (LD8)", () => {
	it("rejects unknown TOP-LEVEL settings key still", () => {
		assert.throws(() => parseGoalSettings({ preAuditHooks: { enabled: true }, bogusTopLevel: 1 }), /Unknown/);
	});

	it("rejects unknown nested keys in preAuditHooks block", () => {
		assert.throws(
			() => parseGoalSettings({ preAuditHooks: { enabled: true, bogusHookKey: 1 } }),
			/Unknown preAuditHooks nested key/,
		);
	});

	it("rejects unknown nested keys in passCriteria block", () => {
		assert.throws(
			() => parseGoalSettings({ preAuditHooks: { enabled: true, passCriteria: { bogusCrit: 1 } } }),
			/Unknown preAuditHooks\.passCriteria nested key|Unknown.*passCriteria nested key/,
		);
	});
});

describe("preAuditHooks — script resolution / chaining config (LD7, LD8)", () => {
	it("parses globalScript-only config", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, globalScript: "/g.sh" } });
		assert.equal(s.preAuditHooks?.globalScript, "/g.sh");
		assert.equal(s.preAuditHooks?.localScript, undefined);
	});

	it("parses localScript-only config", () => {
		const s = parseGoalSettings({ preAuditHooks: { enabled: true, localScript: "./l.sh" } });
		assert.equal(s.preAuditHooks?.globalScript, undefined);
		assert.equal(s.preAuditHooks?.localScript, "./l.sh");
	});

	it("parses BOTH globalScript and localScript (chaining, LD7)", () => {
		const s = parseGoalSettings({
			preAuditHooks: { enabled: true, globalScript: "/g.sh", localScript: "./l.sh" },
		});
		assert.equal(s.preAuditHooks?.globalScript, "/g.sh");
		assert.equal(s.preAuditHooks?.localScript, "./l.sh");
	});

	it("parses a block with neither script (silent-skip config is still valid)", () => {
		// Missing globalScript + localScript → no hooks run at evaluation time
		// (executor concern), but the config itself must parse without throwing.
		const s = parseGoalSettings({ preAuditHooks: { enabled: true } });
		assert.ok(s.preAuditHooks);
		assert.equal(s.preAuditHooks.globalScript, undefined);
		assert.equal(s.preAuditHooks.localScript, undefined);
	});
});

describe("preAuditHooks — save→load round-trip (LD2, LD8)", () => {
	it("round-trips a fully-specified preAuditHooks block", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-pre-"));
		try {
			const original: GoalSettings = {
				preAuditHooks: {
					enabled: true,
					globalScript: "/abs/global-check.sh",
					localScript: "./.pi/hooks/pre.sh",
					passCriteria: {
						status: 0,
						regex: "PASS|SUCCESS",
						stream: "stderr",
						combinator: "OR",
						negate: true,
					},
					injectOutput: false,
					maxOutputChars: 1234,
					timeoutMs: 7000,
				} as PreAuditHooksConfig,
			};
			saveGoalSettingsFileConfig(tmp, original);
			const loaded = loadGoalSettingsFileConfig(tmp, isolatedSettingsEnv());
			assert.ok(loaded.preAuditHooks, "preAuditHooks must survive round-trip");
			assert.equal(loaded.preAuditHooks.enabled, true);
			assert.equal(loaded.preAuditHooks.globalScript, "/abs/global-check.sh");
			assert.equal(loaded.preAuditHooks.localScript, "./.pi/hooks/pre.sh");
			assert.equal(loaded.preAuditHooks.passCriteria?.status, 0);
			assert.equal(loaded.preAuditHooks.passCriteria?.regex, "PASS|SUCCESS");
			assert.equal(loaded.preAuditHooks.passCriteria?.stream, "stderr");
			assert.equal(loaded.preAuditHooks.passCriteria?.combinator, "OR");
			assert.equal(loaded.preAuditHooks.passCriteria?.negate, true);
			assert.equal(loaded.preAuditHooks.injectOutput, false);
			assert.equal(loaded.preAuditHooks.maxOutputChars, 1234);
			assert.equal(loaded.preAuditHooks.timeoutMs, 7000);
			// Also confirm it landed in the JSON file.
			const raw = JSON.parse(
				fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"),
			);
			assert.equal(raw.preAuditHooks?.enabled, true);
			assert.equal(raw.preAuditHooks?.passCriteria?.combinator, "OR");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("round-trips defaults-only block (enabled:false, default passCriteria)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-pre-"));
		try {
			saveGoalSettingsFileConfig(tmp, {
				preAuditHooks: { enabled: false } as PreAuditHooksConfig,
			});
			const loaded = loadGoalSettingsFileConfig(tmp, isolatedSettingsEnv());
			assert.ok(loaded.preAuditHooks);
			assert.equal(loaded.preAuditHooks.enabled, false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("omits preAuditHooks key from disk when not configured", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-pre-"));
		try {
			saveGoalSettingsFileConfig(tmp, {});
			const raw = JSON.parse(
				fs.readFileSync(path.join(tmp, ".pi", "pi-goal-xx-settings.json"), "utf8"),
			);
			assert.equal(raw.preAuditHooks, undefined);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("preAuditHooks — interface types compile", () => {
	it("PreAuditHooksConfig and PreAuditHookPassCriteria are usable as types", () => {
		// Compile-time contract: the interfaces must exist and be shaped per LD8.
		const crit: PreAuditHookPassCriteria = {
			status: 0,
			regex: "",
			stream: "both",
			combinator: "AND",
			negate: false,
		};
		const cfg: PreAuditHooksConfig = {
			enabled: true,
			passCriteria: crit,
			injectOutput: true,
			maxOutputChars: 5000,
			timeoutMs: 30000,
		};
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.passCriteria.status, 0);
	});
});
