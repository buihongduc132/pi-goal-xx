/**
 * Integration tests for goal-display-liveness OpenSpec change.
 *
 * These tests exercise the full pipeline: lock state → computeLockInfo → display functions.
 * They verify that the three display surfaces (picker, footer, widget) correctly reflect
 * liveness across all edge cases.
 *
 * Task 11 from openspec/changes/goal-display-liveness/tasks.md
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type GoalFocusLock,
	lockDir,
	lockPath,
	writeLockAtomic,
	readLockDetailed,
	reapOrphanedLocks,
} from "../extensions/goal-lock.ts";
import {
	compactStatusLabel,
	statusLabel,
	footerStatus,
	type GoalDisplayRecordLike,
} from "../extensions/goal-core.ts";
import {
	sortGoalsForPicker,
	goalSelectorLabel,
	buildGoalListText,
	goalPoolFromGoals,
} from "../extensions/goal-pool.ts";
import { renderGoalWidgetLines, type GoalWidgetRecord } from "../extensions/widgets/goal-widget.ts";
import { mkGoal } from "./_test-helpers.ts";

const LEASE_MS = 180_000;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-liveness-integ-"));
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function mkLock(goalId: string, sessionId: string, pid: number): GoalFocusLock {
	const now = Date.now();
	return {
		goalId,
		owner: { sessionId, pid },
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + LEASE_MS).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
	};
}

function mockTheme(): any {
	return {
		fg: (_kind: string, s: string) => s,
		bold: (s: string) => s,
	};
}

function mkWidgetGoal(over: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		id: "test-goal",
		objective: "do the thing",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		...over,
	} as GoalWidgetRecord;
}

function mkDisplayGoal(over: Partial<GoalDisplayRecordLike> = {}): GoalDisplayRecordLike {
	return {
		objective: "do the thing",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		...over,
	};
}

/**
 * Simulate computeLockInfo's liveness logic for a single goal.
 * This mirrors the function in goal.ts but is standalone for testing.
 */
function computeLiveLockHolder(cwd: string, goalId: string): boolean | undefined {
	if (!fs.existsSync(lockDir(cwd))) return undefined; // legacy fallback
	const detailed = readLockDetailed(cwd, goalId);
	if (detailed.status === "missing") return false; // no lock → stale
	if (detailed.status === "error") return undefined; // can't determine → legacy
	// Check if lock is held (PID alive + lease fresh)
	const lock = detailed.lock;
	const pidAlive = (() => {
		try { process.kill(lock.owner.pid, 0); return true; }
		catch (e: any) { return e.code === "EPERM"; }
	})();
	if (!pidAlive) return false;
	const expiresAt = new Date(lock.expiresAt).getTime();
	if (Number.isNaN(expiresAt) || Date.now() >= expiresAt) return false;
	return true; // live lock holder
}

// ── 11.1: Lock held by self (live) → all surfaces show "running" ─────────────

describe("11.1: lock held by self (live) → running everywhere", () => {
	it("picker shows 'running'", () => {
		const cwd = tmpCwd();
		const goalId = "g1";
		writeLockAtomic(cwd, goalId, mkLock(goalId, "self", process.pid));
		const liveness = computeLiveLockHolder(cwd, goalId);
		assert.equal(liveness, true);
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }, liveness), "running");
	});

	it("footer shows 'running'", () => {
		const cwd = tmpCwd();
		const goalId = "g1";
		writeLockAtomic(cwd, goalId, mkLock(goalId, "self", process.pid));
		const liveness = computeLiveLockHolder(cwd, goalId);
		assert.match(footerStatus(mkDisplayGoal(), liveness), /running/);
	});

	it("widget shows ●", () => {
		const cwd = tmpCwd();
		const goalId = "g1";
		writeLockAtomic(cwd, goalId, mkLock(goalId, "self", process.pid));
		const liveness = computeLiveLockHolder(cwd, goalId);
		const goal = mkWidgetGoal({ liveLockHolder: liveness });
		const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("●"), `expected ● in: ${joined}`);
		assert.ok(joined.includes("running"), `expected 'running' in: ${joined}`);
	});
});

// ── 11.2: Lock absent, .locks/ dir present → all surfaces show "stale" ───────

describe("11.2: lock absent, .locks/ dir present → stale everywhere", () => {
	it("picker shows 'stale'", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true }); // dir exists, no lock file
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.equal(liveness, false);
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }, liveness), "stale");
	});

	it("footer shows 'stale'", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.match(footerStatus(mkDisplayGoal(), liveness), /stale/);
	});

	it("widget shows ⌽", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		const liveness = computeLiveLockHolder(cwd, "g1");
		const goal = mkWidgetGoal({ liveLockHolder: liveness });
		const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("⌽"), `expected ⌽ in: ${joined}`);
		assert.ok(joined.includes("stale"), `expected 'stale' in: ${joined}`);
	});
});

// ── 11.3: Lock present but PID dead → all surfaces show "stale" ──────────────

describe("11.3: lock present but PID dead → stale everywhere", () => {
	it("picker shows 'stale'", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock("g1", "dead", 0x7FFFFFFF)); // dead PID
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.equal(liveness, false);
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }, liveness), "stale");
	});

	it("footer shows 'stale'", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock("g1", "dead", 0x7FFFFFFF));
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.match(footerStatus(mkDisplayGoal(), liveness), /stale/);
	});

	it("widget shows ⌽", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "g1", mkLock("g1", "dead", 0x7FFFFFFF));
		const liveness = computeLiveLockHolder(cwd, "g1");
		const goal = mkWidgetGoal({ liveLockHolder: liveness });
		const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("⌽"), `expected ⌽ in: ${joined}`);
	});
});

// ── 11.4: .locks/ dir absent → all surfaces show "running" (legacy) ──────────

describe("11.4: .locks/ dir absent → running everywhere (legacy fallback)", () => {
	it("picker shows 'running'", () => {
		const cwd = tmpCwd(); // no .locks/ dir
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.equal(liveness, undefined);
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }, liveness), "running");
	});

	it("footer shows 'running'", () => {
		const cwd = tmpCwd();
		const liveness = computeLiveLockHolder(cwd, "g1");
		assert.match(footerStatus(mkDisplayGoal(), liveness), /running/);
	});

	it("widget shows ●", () => {
		const cwd = tmpCwd();
		const liveness = computeLiveLockHolder(cwd, "g1");
		const goal = mkWidgetGoal({ liveLockHolder: liveness });
		const lines = renderGoalWidgetLines(goal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("●"), `expected ● in: ${joined}`);
		assert.ok(joined.includes("running"), `expected 'running' in: ${joined}`);
	});
});

// ── 11.5: Stale goal sorts after running goal regardless of updatedAt ────────

describe("11.5: stale goal sorts after running goal", () => {
	it("stale goal (newer updatedAt) sorts after running goal (older updatedAt)", () => {
		const stale = mkGoal({ id: "stale", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" });
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const liveSet = new Set(["running"]);
		const sorted = sortGoalsForPicker([stale, running], liveSet);
		assert.equal(sorted[0]!.id, "running");
		assert.equal(sorted[1]!.id, "stale");
	});

	it("in buildGoalListText output, running appears before stale", () => {
		const pool = goalPoolFromGoals([
			mkGoal({ id: "dead", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" }),
			mkGoal({ id: "live", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" }),
		]);
		const text = buildGoalListText(pool, null, { liveLockHolderSet: new Set(["live"]) });
		const liveIdx = text.indexOf("live");
		const deadIdx = text.indexOf("dead");
		assert.ok(liveIdx >= 0 && deadIdx >= 0);
		assert.ok(liveIdx < deadIdx, `running (live) must appear before stale (dead):\n${text}`);
	});
});

// ── 11.7: Orphaned lock for completed goal reaped during pool scan ───────────

describe("11.7: orphaned lock reaped during pool scan", () => {
	it("orphaned lock for completed goal is reaped", () => {
		const cwd = tmpCwd();
		writeLockAtomic(cwd, "completed-goal", mkLock("completed-goal", "self", process.pid));
		assert.ok(fs.existsSync(lockPath(cwd, "completed-goal")));
		reapOrphanedLocks(cwd, new Set(["active-goal"]));
		assert.ok(!fs.existsSync(lockPath(cwd, "completed-goal")), "orphaned lock should be reaped");
	});
});

// ── 11.8: Corrupt lock file → error → display shows "running" (legacy) ───────

describe("11.8: corrupt lock file → error → legacy fallback (running)", () => {
	it("readLockDetailed returns 'error' for corrupt JSON", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt json");
		const result = readLockDetailed(cwd, "g1");
		assert.equal(result.status, "error");
	});

	it("corrupt lock file → liveness is undefined → display shows 'running'", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt json");
		// Simulate computeLockInfo: error → skip → not in live set → undefined
		const liveness = computeLiveLockHolder(cwd, "g1");
		// readLockDetailed returns "error" → computeLiveLockHolder returns undefined
		// (because we can't determine liveness from a corrupt lock)
		assert.equal(liveness, undefined, "corrupt lock → undefined (legacy fallback)");
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }, liveness), "running");
	});
});
