/**
 * RED→GREEN tests for contract-templating (group 7, D6).
 *
 * Spec: openspec/changes/unified-prompt-config/specs/contract-templating/spec.md
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	expandContractTemplates,
} from "../extensions/contract-templating.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

interface SB {
	cwd: string;
	home: string;
	writeLocal(name: string, body: string): void;
	writeGlobal(name: string, body: string): void;
}
function makeSb(contractsDir = ".pi/pi-goal-xx/contracts/"): SB {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ct-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-ct-home-"));
	fs.mkdirSync(path.join(home, contractsDir), { recursive: true });
	fs.mkdirSync(path.join(cwd, contractsDir), { recursive: true });
	return {
		cwd,
		home,
		writeLocal(name, body) {
			fs.writeFileSync(path.join(cwd, contractsDir, `${name}.md`), body, "utf8");
		},
		writeGlobal(name, body) {
			fs.writeFileSync(path.join(home, contractsDir, `${name}.md`), body, "utf8");
		},
	};
}

let sb: SB;
beforeEach(() => { sb = makeSb(); });
afterEach(() => {
	try { fs.rmSync(sb.cwd, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(sb.home, { recursive: true, force: true }); } catch {}
});

describe("expandContractTemplates — snippet expansion", () => {
	it("expands a single snippet", () => {
		sb.writeLocal("verifier-loop", "Run verifier-loop and require <approved/>");
		const r = expandContractTemplates("{{verifier-loop}}", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "Run verifier-loop and require <approved/>");
		assert.equal(r.warnings.length, 0);
	});

	it("composes multiple snippets", () => {
		sb.writeLocal("verifier-loop", "VL");
		sb.writeLocal("e2e-required", "E2E");
		const r = expandContractTemplates("{{verifier-loop}} + {{e2e-required}}", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "VL + E2E");
	});

	it("preserves literal + warns on unknown snippet", () => {
		const r = expandContractTemplates("pre {{does-not-exist}} post", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "pre {{does-not-exist}} post");
		assert.ok(r.warnings.some((w) => w.includes("does-not-exist")));
	});

	it("local snippet overrides global of same name", () => {
		sb.writeGlobal("shared", "GLOBAL-BODY");
		sb.writeLocal("shared", "LOCAL-BODY");
		const r = expandContractTemplates("{{shared}}", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "LOCAL-BODY");
	});

	it("falls back to global when no local", () => {
		sb.writeGlobal("gonly", "GLOBAL-ONLY");
		const r = expandContractTemplates("{{gonly}}", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "GLOBAL-ONLY");
	});

	it("honors custom contractsDir", () => {
		const custom = ".pi/legal/contracts/";
		const sb2 = makeSb(custom);
		try {
			sb2.writeLocal("x", "CUSTOM-DIR");
			const r = expandContractTemplates("{{x}}", sb2.cwd, { contractsDir: custom, home: sb2.home } as GoalSettings);
			assert.equal(r.expanded, "CUSTOM-DIR");
		} finally {
			fs.rmSync(sb2.cwd, { recursive: true, force: true });
			fs.rmSync(sb2.home, { recursive: true, force: true });
		}
	});

	it("contractTemplates=false disables expansion (leaves literal)", () => {
		sb.writeLocal("on", "SHOULD-NOT-APPEAR");
		const r = expandContractTemplates("{{on}}", sb.cwd, { contractTemplates: false, home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "{{on}}");
		assert.equal(r.warnings.length, 0);
	});

	it("leaves non-snippet text untouched", () => {
		const r = expandContractTemplates("plain text no snippets", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "plain text no snippets");
	});

	it("handles adjacent snippets with no separator", () => {
		sb.writeLocal("a", "AA");
		sb.writeLocal("b", "BB");
		const r = expandContractTemplates("{{a}}{{b}}", sb.cwd, { home: sb.home } as GoalSettings);
		assert.equal(r.expanded, "AABB");
	});

	it("no settings → no expansion (returns input verbatim)", () => {
		sb.writeLocal("x", "BODY");
		const r = expandContractTemplates("{{x}}", sb.cwd, undefined);
		// When settings undefined, contractTemplates defaults true → still expands.
		// (Disabled only via explicit false or env.) Adjust if design differs.
		assert.equal(r.expanded, "BODY");
	});
});
