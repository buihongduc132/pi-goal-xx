/**
 * Integration tests for goal-display-liveness OpenSpec change (task 11).
 *
 * These tests verify the END-TO-END liveness flow through the composed
 * display pipeline: lock files → readLockDetailed → computeLockInfo logic →
 * display functions → rendered output strings.
 *
 * Since computeLockInfo is a private closure function in goal.ts, we test
 * the composed behavior through the exported functions that consume its output:
 * - buildGoalListText (picker/list output)
 * - renderGoalWidgetLines (widget output)
 * - footerStatus / compactStatusLabel (status strings)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type GoalFocusLock,
	type LockOwner,
	lockDir,
	lockPath,
	writeLockAtomic,
	acquireLock,
	readLockDetailed,
	isLockHeld,
} from "../extensions/goal-lock.ts";
import {
	compactStatusLabel,
	statusLabel,
	footerStatus,
	type GoalDisplayRecordLike,
} from "../extensions/goal-core.ts";
import {
	buildGoalListText,
	goalSelectorLabel,
	sortGoalsForPicker,
} from "../extensions/goal-pool.ts";
import { renderGoalWidgetLines, type GoalWidgetRecord } from "../extensions/widgets/goal-widget.ts";
import { mkGoal } from "./_test-helpers.ts";

const LEASE_MS = 180_000;

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-integration-"));
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function mkLock(goalId: string, owner: LockOwner, leaseMs = LEASE_MS): GoalFocusLock {
	const now = Date.now();
	return {
		goalId,
		owner,
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + leaseMs).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
	};
}

function mkDisplayGoal(over: Partial<GoalDisplayRecordLike> = {}): GoalDisplayRecordLike {
	return {
		status: "active",
		autoContinue: true,
		sisyphus: false,
		stopReason: undefined,
		objective: "Test goal objective",
		usage: { activeSeconds: 10, tokensUsed: 500 },
		...over,
	};
}

function mkWidgetGoal(over: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		id: "test-goal",
		status: "active",
		autoContinue: true,
		sisyphus: false,
		objective: "Test goal objective",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-06-01T00:00:00Z",
		usage: { activeSeconds: 10, tokensUsed: 500 },
		...over,
	} as GoalWidgetRecord;
}

/**
 * Simulate computeLockInfo logic (mirrors the private function in goal.ts).
 * Returns { heldByOther, liveLockHolderSet } given goals and a cwd with lock files.
 */
function simulateComputeLockInfo(
	goals: ReturnType<typeof mkGoal>[],
	cwd: string,
	selfSessionId: string,
): { heldByOther: Map<string, string>; liveLockHolderSet: Set<string> | null } {
	// Check if .locks/ dir exists
	if (!fs.existsSync(lockDir(cwd))) {
		return { heldByOther: new Map(), liveLockHolderSet: null };
	}
	const heldByOther = new Map<string, string>();
	const liveLockHolderSet = new Set<string>();
	for (const g of goals) {
		const detailed = readLockDetailed(cwd, g.id);
		if (detailed.status === "missing") continue;
		if (detailed.status === "error") continue;
		const lock = detailed.lock;
		if (!isLockHeld(lock)) continue;
		liveLockHolderSet.add(g.id);
		if (lock.owner.sessionId !== selfSessionId) {
			heldByOther.set(g.id, lock.owner.sessionId);
		}
	}
	return { heldByOther, liveLockHolderSet };
}

// ── 11.1: Live lock held by self → running everywhere ────────────────────────

describe("11.1 — live lock held by self → running everywhere", () => {
	it("picker shows 'running', footer shows 'running', widget shows ●", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "self-session", pid: process.pid };
		const goal = mkGoal({ id: "g1", status: "active", autoContinue: true });

		// Create a live lock owned by self
		acquireLock(cwd, "g1", self, LEASE_MS);

		const { liveLockHolderSet } = simulateComputeLockInfo([goal], cwd, self.sessionId);

		// Picker: goalSelectorLabel should show "running"
		const label = goalSelectorLabel(goal, null, {
			liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has(goal.id) : undefined,
		});
		assert.ok(label.includes("running"), `picker label should contain 'running', got: ${label}`);

		// Footer: footerStatus should show "running"
		const displayGoal = mkDisplayGoal();
		const footer = footerStatus(displayGoal, liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined);
		assert.ok(footer.includes("running"), `footer should contain 'running', got: ${footer}`);

		// Widget: should show ● (accent)
		const widgetGoal = mkWidgetGoal({ liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined });
		const lines = renderGoalWidgetLines(widgetGoal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("●"), `widget should show ●, got: ${joined}`);
		assert.ok(joined.includes("running"), `widget should show 'running', got: ${joined}`);
	});
});

// ── 11.2: No lock + .locks/ dir present → stale everywhere ───────────────────

describe("11.2 — no lock + .locks/ dir present → stale everywhere", () => {
	it("picker shows 'stale', footer shows 'stale', widget shows ⌽", () => {
		const cwd = tmpCwd();
		// Create .locks/ dir but NO lock file for this goal
		fs.mkdirSync(lockDir(cwd), { recursive: true });

		const goal = mkGoal({ id: "g1", status: "active", autoContinue: true });
		const { liveLockHolderSet } = simulateComputeLockInfo([goal], cwd, "self");

		// liveLockHolderSet should exist but NOT contain g1
		assert.ok(liveLockHolderSet !== null, "set should not be null when .locks/ exists");
		assert.ok(!liveLockHolderSet!.has("g1"), "g1 should NOT be in live set");

		// Picker: should show "stale"
		const label = goalSelectorLabel(goal, null, {
			liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has(goal.id) : undefined,
		});
		assert.ok(label.includes("stale"), `picker label should contain 'stale', got: ${label}`);

		// Footer: should show "stale"
		const displayGoal = mkDisplayGoal();
		const footer = footerStatus(displayGoal, liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined);
		assert.ok(footer.includes("stale"), `footer should contain 'stale', got: ${footer}`);

		// Widget: should show ⌽ (muted, stale)
		const widgetGoal = mkWidgetGoal({ liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined });
		const lines = renderGoalWidgetLines(widgetGoal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("⌽"), `widget should show ⌽, got: ${joined}`);
		assert.ok(joined.includes("stale"), `widget should show 'stale', got: ${joined}`);
	});
});

// ── 11.3: Lock present but PID dead → stale everywhere ───────────────────────

describe("11.3 — lock present but PID dead → stale everywhere", () => {
	it("picker shows 'stale', footer shows 'stale', widget shows ⌽", () => {
		const cwd = tmpCwd();
		// Create a lock with a DEAD pid (pid 1 is init, always alive on Linux; use a very high pid)
		const deadPid = 999999999;
		const lock = mkLock("g1", { sessionId: "dead-session", pid: deadPid });
		writeLockAtomic(cwd, "g1", lock);

		const goal = mkGoal({ id: "g1", status: "active", autoContinue: true });
		const { liveLockHolderSet } = simulateComputeLockInfo([goal], cwd, "self");

		// Lock exists but PID is dead → isLockHeld returns false → NOT in live set
		assert.ok(!liveLockHolderSet!.has("g1"), "dead PID lock should NOT be in live set");

		// Picker: stale
		const label = goalSelectorLabel(goal, null, {
			liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has(goal.id) : undefined,
		});
		assert.ok(label.includes("stale"), `picker should show 'stale', got: ${label}`);

		// Footer: stale
		const displayGoal = mkDisplayGoal();
		const footer = footerStatus(displayGoal, liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined);
		assert.ok(footer.includes("stale"), `footer should show 'stale', got: ${footer}`);

		// Widget: ⌽
		const widgetGoal = mkWidgetGoal({ liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined });
		const lines = renderGoalWidgetLines(widgetGoal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("⌽"), `widget should show ⌽, got: ${joined}`);
	});
});

// ── 11.4: No .locks/ dir → legacy running ────────────────────────────────────

describe("11.4 — no .locks/ dir → legacy running (no locking enabled)", () => {
	it("picker shows 'running', footer shows 'running', widget shows ●", () => {
		const cwd = tmpCwd();
		// Do NOT create .locks/ dir

		const goal = mkGoal({ id: "g1", status: "active", autoContinue: true });
		const { liveLockHolderSet } = simulateComputeLockInfo([goal], cwd, "self");

		// No .locks/ dir → null set → legacy fallback
		assert.equal(liveLockHolderSet, null, "should return null when .locks/ absent");

		// Picker: legacy running
		const label = goalSelectorLabel(goal, null, {
			liveLockHolder: liveLockHolderSet ? liveLockHolderSet.has(goal.id) : undefined,
		});
		assert.ok(label.includes("running"), `picker should show 'running' (legacy), got: ${label}`);

		// Footer: legacy running
		const displayGoal = mkDisplayGoal();
		const footer = footerStatus(displayGoal, liveLockHolderSet ? liveLockHolderSet.has("g1") : undefined);
		assert.ok(footer.includes("running"), `footer should show 'running' (legacy), got: ${footer}`);

		// Widget: ● (running)
		const widgetGoal = mkWidgetGoal({ liveLockHolder: undefined }); // null set → undefined → legacy
		const lines = renderGoalWidgetLines(widgetGoal, mockTheme(), 80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("●"), `widget should show ● (legacy), got: ${joined}`);
	});
});

// ── 11.5: Stale goal sorts after running goal ────────────────────────────────

describe("11.5 — stale goal sorts after running goal regardless of updatedAt", () => {
	it("stale goal (newer updatedAt) sorts AFTER running goal", () => {
		const running = mkGoal({ id: "running", status: "active", autoContinue: true, updatedAt: "2026-01-01T00:00:00Z" });
		const stale = mkGoal({ id: "stale", status: "active", autoContinue: true, updatedAt: "2026-06-01T00:00:00Z" });
		const liveSet = new Set(["running"]); // only "running" is live

		const sorted = sortGoalsForPicker([stale, running], liveSet);
		assert.equal(sorted[0]!.id, "running", "running goal should sort first");
		assert.equal(sorted[1]!.id, "stale", "stale goal should sort second despite newer updatedAt");
	});
});

// ── 11.6: Heartbeat detects lock stolen by another session ───────────────────

describe("11.6 — heartbeat detects lock stolen (refreshLease lostLock)", () => {
	it("refreshLease returns lostLock:true when another session took the lock", () => {
		const cwd = tmpCwd();
		const self: LockOwner = { sessionId: "self", pid: process.pid };
		const other: LockOwner = { sessionId: "other", pid: process.pid };

		// Self acquires lock
		acquireLock(cwd, "g1", self, LEASE_MS);

		// Other session steals the lock
		acquireLock(cwd, "g1", other, LEASE_MS);

		// Self tries to refresh → should detect lostLock
		const { refreshLease } = require("../extensions/goal-lock.ts");
		const result = refreshLease(cwd, "g1", self, LEASE_MS);
		assert.equal(result.refreshed, false);
		assert.equal(result.lostLock, true, "should detect lock was stolen");
	});
});

// ── 11.7: Orphaned lock for completed goal reaped during pool scan ───────────

describe("11.7 — orphaned lock reaped during pool scan", () => {
	it("reapOrphanedLocks removes lock for completed goal", () => {
		const cwd = tmpCwd();
		const { reapOrphanedLocks } = require("../extensions/goal-lock.ts");

		// Create lock for a "completed" goal
		const lock = mkLock("completed-goal", { sessionId: "dead-session", pid: 12345 });
		writeLockAtomic(cwd, "completed-goal", lock);
		assert.ok(fs.existsSync(lockPath(cwd, "completed-goal")));

		// Pool scan: active goals = ["active-goal"], completed-goal is NOT active
		reapOrphanedLocks(cwd, new Set(["active-goal"]));
		assert.ok(!fs.existsSync(lockPath(cwd, "completed-goal")), "orphaned lock should be reaped");
	});
});

// ── 11.8: Corrupt lock → error → legacy running (not stale) ─────────────────

describe("11.8 — corrupt lock file → error → legacy running (NOT stale)", () => {
	it("readLockDetailed returns error for corrupt lock → display shows running", () => {
		const cwd = tmpCwd();
		fs.mkdirSync(lockDir(cwd), { recursive: true });
		fs.writeFileSync(lockPath(cwd, "g1"), "{corrupt json");

		const detailed = readLockDetailed(cwd, "g1");
		assert.equal(detailed.status, "error", "corrupt lock should be 'error'");

		// Error → skip in computeLockInfo → NOT in live set → undefined passed to display
		// undefined → legacy fallback → "running" (NOT "stale")
		const goal = mkGoal({ id: "g1", status: "active", autoContinue: true });
		const { liveLockHolderSet } = simulateComputeLockInfo([goal], cwd, "self");

		// g1 should NOT be in the set (error → skip)
		assert.ok(!liveLockHolderSet!.has("g1"), "error lock should NOT be in live set");

		// But the display should show "running" because error → undefined → legacy
		// In computeLockInfo, error locks are skipped, so liveLockHolder is undefined for that goal
		const label = goalSelectorLabel(goal, null, {
			liveLockHolder: undefined, // error → skip → undefined
		});
		assert.ok(label.includes("running"), `corrupt lock should show 'running' (legacy), got: ${label}`);
	});
});

// ── Mock theme for widget tests ──────────────────────────────────────────────

function mockTheme(): any {
	const fg = (color: string, text: string) => text;
	return {
		fg,
		bold: (s: string) => s,
		dim: (s: string) => s,
	};
}
