import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	GOALS_DIR,
	ARCHIVED_GOALS_DIR,
	timestampForFile,
	isSafeRelativeUnder,
	isSafeActivePath,
	isSafeArchivedPath,
	sanitizeGoalPaths,
	ensureDirectory,
	resolveGoalPath,
	atomicWriteGoalFile,
	safeUnlinkGoalFile,
	makeActiveGoalPath,
	makeArchivedGoalPath,
	activePathForGoal,
	archivedPathForGoal,
	serializeGoalFile,
	findJsonObjectEnd,
	extractObjectiveFromBody,
	parseGoalFile,
	writeActiveGoalFile,
	archiveGoalFile,
	mergeGoalPromptFromDisk,
	readActiveGoalFiles,
	readActiveGoalPool,
	type GoalFileContext,
} from "../extensions/storage/goal-files.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";

function tmpCtx(): GoalFileContext & { _dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-files-"));
	return { cwd: dir, _dir: dir };
}
function makeGoal(id = "g1"): GoalRecord {
	const g = createGoal({ objective: "obj", autoContinue: true, sisyphus: false }, 1719792000000);
	g.id = id;
	return g;
}

describe("constants", () => {
	it("GOALS_DIR and ARCHIVED_GOALS_DIR", () => {
		assert.equal(GOALS_DIR, ".pi/goals");
		assert.equal(ARCHIVED_GOALS_DIR, ".pi/goals/archived");
	});
});

describe("timestampForFile", () => {
	it("converts ISO to filename-safe timestamp", () => {
		const ts = timestampForFile("2026-07-01T00:00:00.000Z");
		assert.ok(!ts.includes(":"));
		assert.ok(ts.length > 0);
	});
	it("uses current time if no arg", () => {
		const ts = timestampForFile();
		assert.ok(ts.length > 0);
	});
});

describe("path safety", () => {
	const ctx = tmpCtx();
	it("isSafeRelativeUnder rejects traversal", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, ".pi/goals/../../../etc/passwd"), false);
	});
	it("isSafeRelativeUnder accepts path directly under root", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, ".pi/goals/goal1.json"), true);
	});
	it("isSafeRelativeUnder rejects path NOT directly under root (different parent)", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, "goal1.json"), false);
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, ".pi/goals/sub/file.json"), false);
	});
	it("isSafeActivePath rejects archived path", () => {
		assert.equal(isSafeActivePath(ctx, ".pi/goals/archived/foo.json"), false);
	});
	it("isSafeArchivedPath accepts goal_*.md under archived", () => {
		assert.equal(isSafeArchivedPath(ctx, ".pi/goals/archived/goal_abc.md"), true);
	});
	it("isSafeArchivedPath rejects wrong filename pattern", () => {
		assert.equal(isSafeArchivedPath(ctx, ".pi/goals/archived/foo.json"), false);
	});
	it("rejects undefined", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, undefined), false);
	});
	it("rejects absolute", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, "/etc/passwd"), false);
	});
	it("rejects null bytes", () => {
		assert.equal(isSafeRelativeUnder(ctx, GOALS_DIR, ".pi/goals/foo\u0000bar"), false);
	});
});

describe("path builders", () => {
	it("makeActiveGoalPath", () => {
		const g = makeGoal("my-id");
		const p = makeActiveGoalPath(g);
		assert.ok(p.includes("my-id"));
		assert.ok(!p.includes("archived"));
	});
	it("makeArchivedGoalPath", () => {
		const g = makeGoal("my-id");
		const p = makeArchivedGoalPath(g);
		assert.ok(p.includes("archived"));
		assert.ok(p.includes("my-id"));
	});
	it("activePathForGoal falls back to makeActiveGoalPath when unsafe", () => {
		const ctx = tmpCtx();
		const g = makeGoal("x");
		const p = activePathForGoal(ctx, g);
		assert.ok(p.includes("x"));
	});
	it("activePathForGoal uses goal.activePath when safe", () => {
		const ctx = tmpCtx();
		const g = makeGoal("x");
		g.activePath = ".pi/goals/active_goal_123_x.md";
		const p = activePathForGoal(ctx, g);
		assert.equal(p, ".pi/goals/active_goal_123_x.md");
	});
	it("archivedPathForGoal resolves under cwd/archived", () => {
		const ctx = tmpCtx();
		const p = archivedPathForGoal(ctx, makeGoal("x"));
		assert.ok(p.includes("archived"));
	});
	it("resolveGoalPath joins cwd + relPath (relPath must include full rel)", () => {
		const ctx = tmpCtx();
		const p = resolveGoalPath(ctx, GOALS_DIR, ".pi/goals/foo.json");
		assert.equal(p, path.resolve(ctx.cwd, ".pi/goals/foo.json"));
	});
	it("resolveGoalPath throws on escape", () => {
		const ctx = tmpCtx();
		assert.throws(() => resolveGoalPath(ctx, GOALS_DIR, "../escape.json"), /escapes/);
	});
});

describe("ensureDirectory", () => {
	it("creates nested dirs", () => {
		const ctx = tmpCtx();
		ensureDirectory(ctx, GOALS_DIR);
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR)));
	});
});

describe("atomicWriteGoalFile / safeUnlinkGoalFile", () => {
	it("writes then reads content", () => {
		const ctx = tmpCtx();
		atomicWriteGoalFile(ctx, GOALS_DIR, ".pi/goals/test.txt", "hello");
		assert.equal(fs.readFileSync(path.join(ctx.cwd, ".pi", "goals", "test.txt"), "utf8"), "hello");
	});
	it("safeUnlinkGoalFile removes file", () => {
		const ctx = tmpCtx();
		atomicWriteGoalFile(ctx, GOALS_DIR, ".pi/goals/rm.txt", "x");
		safeUnlinkGoalFile(ctx, GOALS_DIR, ".pi/goals/rm.txt");
		assert.equal(fs.existsSync(path.join(ctx.cwd, ".pi", "goals", "rm.txt")), false);
	});
	it("safeUnlinkGoalFile no-throw on missing", () => {
		const ctx = tmpCtx();
		safeUnlinkGoalFile(ctx, GOALS_DIR, ".pi/goals/never-existed");
		assert.ok(true);
	});
});

describe("serializeGoalFile / parseGoalFile", () => {
	it("serialize produces JSON with objective", () => {
		const g = makeGoal();
		const s = serializeGoalFile(g);
		assert.match(s, /"objective"/);
	});
	it("parseGoalFile round-trips", () => {
		const g = makeGoal();
		const s = serializeGoalFile(g);
		const tmp = path.join(os.tmpdir(), `pgxx-${Date.now()}.json`);
		fs.writeFileSync(tmp, s);
		const parsed = parseGoalFile(tmp);
		assert.ok(parsed);
		assert.equal(parsed!.id, g.id);
		fs.unlinkSync(tmp);
	});
	it("parseGoalFile returns null for missing", () => {
		assert.equal(parseGoalFile("/nonexistent/path.json"), null);
	});
	it("parseGoalFile returns null for invalid JSON", () => {
		const tmp = path.join(os.tmpdir(), `pgxx-bad-${Date.now()}.json`);
		fs.writeFileSync(tmp, "{ not json");
		assert.equal(parseGoalFile(tmp), null);
		fs.unlinkSync(tmp);
	});
});

describe("findJsonObjectEnd", () => {
	it("finds index of closing brace", () => {
		assert.equal(findJsonObjectEnd('{"a":1}'), 6);
	});
	it("handles nested objects", () => {
		assert.equal(findJsonObjectEnd('{"a":{"b":2}}'), 12);
	});
	it("handles braces inside strings", () => {
		const content = '{"x":"}"}';
		assert.ok(findJsonObjectEnd(content) > 0);
	});
	it("returns -1 for unbalanced", () => {
		assert.equal(findJsonObjectEnd('{"a":'), -1);
	});
	it("returns -1 for empty", () => {
		assert.equal(findJsonObjectEnd(''), -1);
	});
});

describe("extractObjectiveFromBody", () => {
	it("returns trimmed body when no # Goal Prompt marker", () => {
		assert.equal(extractObjectiveFromBody('{"other":"x"}'), '{"other":"x"}');
	});
	it("returns undefined for whitespace-only body", () => {
		assert.equal(extractObjectiveFromBody("   "), undefined);
	});
	it("extracts section between # Goal Prompt and ## Progress", () => {
		const body = "# Goal Prompt\ndo the thing\n## Progress\nother";
		assert.equal(extractObjectiveFromBody(body), "do the thing");
	});
	it("extracts to end when no ## Progress", () => {
		const body = "# Goal Prompt\njust this";
		assert.equal(extractObjectiveFromBody(body), "just this");
	});
});

describe("writeActiveGoalFile / readActiveGoalFiles / readActiveGoalPool", () => {
	it("write creates file under GOALS_DIR", () => {
		const ctx = tmpCtx();
		const g = makeGoal("w1");
		const written = writeActiveGoalFile(ctx, g);
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR)));
		assert.equal(written.id, "w1");
	});
	it("readActiveGoalFiles returns written goals", () => {
		const ctx = tmpCtx();
		writeActiveGoalFile(ctx, makeGoal("r1"));
		writeActiveGoalFile(ctx, makeGoal("r2"));
		const goals = readActiveGoalFiles(ctx);
		assert.ok(goals.length >= 2);
	});
	it("readActiveGoalPool returns map keyed by id", () => {
		const ctx = tmpCtx();
		writeActiveGoalFile(ctx, makeGoal("p1"));
		const pool = readActiveGoalPool(ctx);
		assert.ok(pool.has("p1"));
	});
});

describe("archiveGoalFile", () => {
	it("moves goal to archived dir", () => {
		const ctx = tmpCtx();
		const g = makeGoal("a1");
		writeActiveGoalFile(ctx, g);
		const archived = archiveGoalFile(ctx, g);
		assert.ok(archived);
		assert.ok(fs.existsSync(path.join(ctx.cwd, ARCHIVED_GOALS_DIR)));
	});
});

describe("sanitizeGoalPaths", () => {
	it("returns goal with clean paths", () => {
		const ctx = tmpCtx();
		const g = makeGoal();
		const clean = sanitizeGoalPaths(ctx, g);
		assert.ok(clean);
	});
});

describe("mergeGoalPromptFromDisk", () => {
	it("returns goal unchanged when no disk file", () => {
		const ctx = tmpCtx();
		const g = makeGoal("m1");
		const merged = mergeGoalPromptFromDisk(ctx, g);
		assert.equal(merged.id, "m1");
	});
});
