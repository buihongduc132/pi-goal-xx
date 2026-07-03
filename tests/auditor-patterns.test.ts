import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	globToRegex,
	matchPattern,
	resolvePattern,
	applyPatterns,
	excludePatterns,
	AuditorPatternCache,
} from "../extensions/auditor-patterns.ts";

describe("globToRegex", () => {
	it("escapes literal metacharacters", () => {
		assert.equal(globToRegex("a.b+c").test("a.b+c"), true);
		assert.equal(globToRegex("a.b+c").test("axbxc"), false);
	});
	it("anchors fully (no partial match)", () => {
		assert.equal(globToRegex("foo").test("foobar"), false);
	});
});

describe("matchPattern — exact", () => {
	it("exact match returns true", () => {
		assert.equal(matchPattern("write", "write"), true);
	});
	it("non-equal without wildcards returns false", () => {
		assert.equal(matchPattern("write", "read"), false);
	});
	it("case-sensitive", () => {
		assert.equal(matchPattern("Write", "write"), false);
	});
});

describe("matchPattern — wildcards", () => {
	it("suffix wildcard `edit_*`", () => {
		assert.equal(matchPattern("edit_*", "edit_file"), true);
		assert.equal(matchPattern("edit_*", "edit_config"), true);
		assert.equal(matchPattern("edit_*", "edit_"), true); // * matches empty after the underscore
		assert.equal(matchPattern("edit_*", "edit"), false); // underscore is required
		assert.equal(matchPattern("edit_*", "read"), false);
	});
	it("prefix wildcard `gitnexus*`", () => {
		assert.equal(matchPattern("gitnexus*", "gitnexus"), true);
		assert.equal(matchPattern("gitnexus*", "gitnexus-query"), true);
		assert.equal(matchPattern("gitnexus*", "hindsight"), false);
	});
	it("middle wildcard `*deploy*`", () => {
		assert.equal(matchPattern("*deploy*", "deploy"), true);
		assert.equal(matchPattern("*deploy*", "pre-deploy"), true);
		assert.equal(matchPattern("*deploy*", "my-deploy-skill"), true);
		assert.equal(matchPattern("*deploy*", "git"), false);
	});
	it("single char `?`", () => {
		assert.equal(matchPattern("test_??", "test_01"), true);
		assert.equal(matchPattern("test_??", "test_ab"), true);
		assert.equal(matchPattern("test_??", "test_1"), false);
		assert.equal(matchPattern("test_??", "test_abc"), false);
	});
	it("`*` matches all candidates", () => {
		assert.equal(matchPattern("*", "anything"), true);
		assert.equal(matchPattern("*", ""), true);
	});
});

describe("resolvePattern", () => {
	const tools = ["read", "write", "edit_file", "edit_config", "bash"];
	it("returns matching candidates for suffix wildcard", () => {
		assert.deepEqual(resolvePattern("edit_*", tools), ["edit_file", "edit_config"]);
	});
	it("exact returns single", () => {
		assert.deepEqual(resolvePattern("write", tools), ["write"]);
	});
	it("no match returns empty", () => {
		assert.deepEqual(resolvePattern("delete", tools), []);
	});
	it("preserves candidate order in output", () => {
		assert.deepEqual(resolvePattern("*", tools), tools);
	});
});

describe("AuditorPatternCache", () => {
	it("starts empty", () => {
		const c = new AuditorPatternCache();
		assert.equal(c.size, 0);
	});
	it("populates on first resolve and hits on second", () => {
		const c = new AuditorPatternCache();
		const tools = ["a", "b", "ab"];
		const first = resolvePattern("a*", tools, c);
		assert.deepEqual(first, ["a", "ab"]);
		assert.equal(c.size, 1);
		const second = resolvePattern("a*", tools, c);
		assert.deepEqual(second, ["a", "ab"]);
		assert.equal(c.size, 1); // no new entry
	});
	it("different candidates produce different cache keys", () => {
		const c = new AuditorPatternCache();
		resolvePattern("a*", ["a", "ab"], c);
		resolvePattern("a*", ["a", "b", "c"], c);
		assert.equal(c.size, 2);
	});
	it("does not collide when candidate strings contain commas", () => {
		// ["a,b", "c"] and ["a", "b", "c"] must NOT share a cache entry.
		const c = new AuditorPatternCache();
		const r1 = resolvePattern("*", ["a,b", "c"], c);
		assert.deepEqual(r1, ["a,b", "c"]);
		const r2 = resolvePattern("*", ["a", "b", "c"], c);
		assert.deepEqual(r2, ["a", "b", "c"]);
		assert.equal(c.size, 2);
	});
	it("clear empties the cache", () => {
		const c = new AuditorPatternCache();
		resolvePattern("a*", ["a"], c);
		c.clear();
		assert.equal(c.size, 0);
	});
});

describe("applyPatterns", () => {
	it("ORs multiple patterns, preserves order, dedupes", () => {
		const tools = ["read", "write", "edit_file", "edit_config", "bash"];
		assert.deepEqual(applyPatterns(["write", "edit_*"], tools), ["write", "edit_file", "edit_config"]);
	});
	it("empty patterns returns empty", () => {
		assert.deepEqual(applyPatterns([], ["a", "b"]), []);
	});
});

describe("excludePatterns", () => {
	it("removes matches, preserves order", () => {
		const tools = ["read", "write", "edit_file", "edit_config", "bash"];
		assert.deepEqual(excludePatterns(["write", "edit_*"], tools), ["read", "bash"]);
	});
	it("no patterns returns the full list", () => {
		assert.deepEqual(excludePatterns([], ["a", "b"]), ["a", "b"]);
	});
});
