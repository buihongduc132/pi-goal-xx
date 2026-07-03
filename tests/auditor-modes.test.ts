import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveAuditorMode,
	resolveAuditorTools,
	resolveAuditorMcp,
	resolveAuditorSkills,
	resolveAuditorExtensions,
	resolveAuditorResources,
	AUDITOR_BASELINE_TOOLS,
} from "../extensions/auditor-modes.ts";
import { AuditorPatternCache } from "../extensions/auditor-patterns.ts";
import type { GoalSettings } from "../extensions/goal-settings.ts";

describe("resolveAuditorMode", () => {
	it("defaults to inherit when unset", () => {
		assert.equal(resolveAuditorMode(undefined), "inherit");
		assert.equal(resolveAuditorMode({}), "inherit");
	});
	it("returns minimal when explicitly set", () => {
		assert.equal(resolveAuditorMode({ auditorMode: "minimal" }), "minimal");
	});
	it("returns inherit when explicitly set", () => {
		assert.equal(resolveAuditorMode({ auditorMode: "inherit" }), "inherit");
	});
});

describe("resolveAuditorTools — inherit mode", () => {
	const mainTools = ["read", "write", "edit", "bash", "gitnexus_query", "gitnexus_context"];
	it("returns all main tools by default (plus progress)", () => {
		const out = resolveAuditorTools(mainTools, {});
		assert.ok(out.includes("write"));
		assert.ok(out.includes("gitnexus_query"));
		assert.ok(out.includes("report_auditor_progress"));
	});
	it("excludes explicit tool names", () => {
		const out = resolveAuditorTools(mainTools, { auditorExclude: { tools: ["write", "edit"] } });
		assert.equal(out.includes("write"), false);
		assert.equal(out.includes("edit"), false);
		assert.ok(out.includes("bash"));
	});
	it("excludes via wildcard", () => {
		const out = resolveAuditorTools(mainTools, { auditorExclude: { tools: ["gitnexus*"] } });
		assert.equal(out.includes("gitnexus_query"), false);
		assert.equal(out.includes("gitnexus_context"), false);
		assert.ok(out.includes("write"));
	});
	it("always keeps report_auditor_progress even if excluded", () => {
		const out = resolveAuditorTools(mainTools, { auditorExclude: { tools: ["*"] } });
		assert.deepEqual(out, ["report_auditor_progress"]);
	});
	it("falls back to baseline when mainTools is empty", () => {
		const out = resolveAuditorTools([], {});
		assert.deepEqual(out, Array.from(AUDITOR_BASELINE_TOOLS));
	});
});

describe("resolveAuditorTools — minimal mode", () => {
	const mainTools = ["read", "write", "edit", "bash", "gitnexus_query", "gitnexus_context"];
	it("returns baseline only when no includes", () => {
		const out = resolveAuditorTools(mainTools, { auditorMode: "minimal" });
		assert.deepEqual(out.sort(), Array.from(AUDITOR_BASELINE_TOOLS).sort());
	});
	it("adds included exact tool from main", () => {
		const out = resolveAuditorTools(mainTools, {
			auditorMode: "minimal",
			auditorInclude: { tools: ["gitnexus_query"] },
		});
		assert.ok(out.includes("gitnexus_query"));
		assert.ok(out.includes("read"));
	});
	it("adds included wildcard tools from main", () => {
		const out = resolveAuditorTools(mainTools, {
			auditorMode: "minimal",
			auditorInclude: { tools: ["gitnexus*"] },
		});
		assert.ok(out.includes("gitnexus_query"));
		assert.ok(out.includes("gitnexus_context"));
	});
	it("does not add included tools that are not in main", () => {
		const out = resolveAuditorTools(mainTools, {
			auditorMode: "minimal",
			auditorInclude: { tools: ["nonexistent"] },
		});
		assert.equal(out.includes("nonexistent"), false);
	});
});

describe("resolveAuditorMcp", () => {
	const mainMcp = ["gitnexus", "gitnexus-query", "hindsight"];
	it("inherit returns all by default", () => {
		assert.deepEqual(resolveAuditorMcp(mainMcp, {}), mainMcp);
	});
	it("inherit excludes by name", () => {
		assert.deepEqual(resolveAuditorMcp(mainMcp, { auditorExclude: { mcp: ["hindsight"] } }), [
			"gitnexus",
			"gitnexus-query",
		]);
	});
	it("inherit excludes by wildcard", () => {
		assert.deepEqual(resolveAuditorMcp(mainMcp, { auditorExclude: { mcp: ["gitnexus*"] } }), [
			"hindsight",
		]);
	});
	it("minimal with include wildcard", () => {
		assert.deepEqual(
			resolveAuditorMcp(mainMcp, { auditorMode: "minimal", auditorInclude: { mcp: ["gitnexus*"] } }),
			["gitnexus", "gitnexus-query"],
		);
	});
	it("minimal with no includes returns empty", () => {
		assert.deepEqual(resolveAuditorMcp(mainMcp, { auditorMode: "minimal" }), []);
	});
});

describe("resolveAuditorSkills", () => {
	const mainSkills = ["project-testing", "deploy-skill", "audit-helper"];
	it("inherit returns all by default", () => {
		assert.deepEqual(resolveAuditorSkills(mainSkills, {}), mainSkills);
	});
	it("minimal includes from main", () => {
		assert.deepEqual(
			resolveAuditorSkills(mainSkills, {
				auditorMode: "minimal",
				auditorInclude: { skills: ["project-testing"] },
			}),
			["project-testing"],
		);
	});
});

describe("resolveAuditorExtensions", () => {
	const mainExt = ["cc-safety-net", "goal", "gitnexus"];
	it("inherit returns all by default", () => {
		assert.deepEqual(resolveAuditorExtensions(mainExt, {}), mainExt);
	});
	it("inherit excludes by wildcard", () => {
		assert.deepEqual(
			resolveAuditorExtensions(mainExt, { auditorExclude: { extensions: ["cc-safety-net*"] } }),
			["goal", "gitnexus"],
		);
	});
});

describe("resolveAuditorResources", () => {
	const main = {
		tools: ["read", "write", "bash"],
		mcp: ["gitnexus", "hindsight"],
		skills: ["deploy"],
		extensions: ["cc-safety-net", "goal"],
	};
	it("inherit with no filters returns main as-is (plus progress tool)", () => {
		const r = resolveAuditorResources(main, {});
		assert.equal(r.mode, "inherit");
		assert.ok(r.tools.includes("write"));
		assert.ok(r.tools.includes("report_auditor_progress"));
		assert.deepEqual(r.mcp, main.mcp);
		assert.deepEqual(r.skills, main.skills);
		assert.deepEqual(r.extensions, main.extensions);
	});
	it("minimal with no includes returns baseline", () => {
		const r = resolveAuditorResources(main, { auditorMode: "minimal" });
		assert.equal(r.mode, "minimal");
		assert.deepEqual(r.mcp, []);
		assert.deepEqual(r.skills, []);
		assert.deepEqual(r.extensions, []);
	});
	it("uses cache for repeated calls", () => {
		const cache = new AuditorPatternCache();
		resolveAuditorResources(main, { auditorExclude: { tools: ["write"] } }, cache);
		const sizeBefore = cache.size;
		resolveAuditorResources(main, { auditorExclude: { tools: ["write"] } }, cache);
		assert.equal(cache.size, sizeBefore); // no new cache entries
	});
	it("treats empty main arrays correctly", () => {
		const r = resolveAuditorResources({}, {});
		assert.ok(r.tools.includes("report_auditor_progress"));
		assert.deepEqual(r.mcp, []);
	});
});

// Type-only sanity check: the GoalSettings import is used.
((): GoalSettings => ({}))();
