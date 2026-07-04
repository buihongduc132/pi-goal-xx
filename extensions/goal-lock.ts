/**
 * Lease-based advisory focus lock for goals (add-goal-focus-locking, Unit A).
 *
 * One JSON sidecar per locked goal at `<cwd>/.pi/goals/.locks/<goalId>.lock`.
 * Lock is HELD iff owning PID is alive AND lease is fresh (two-signal liveness, D2).
 * All fs operations are FAIL-OPEN: locking is an optimization, not a security boundary.
 *
 * LOCKED design: D1 (format/location), D2 (two-signal liveness + EPERM correctness),
 * D3 (lease window — caller-supplied via leaseMs), D5 (advisory — caller prompts on override).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface GoalFocusLock {
	goalId: string;
	owner: { sessionId: string; pid: number };
	acquiredAt: string;
	expiresAt: string;
	heartbeatAt: string;
}

export interface LockOwner {
	sessionId: string;
	pid: number;
}

export function lockDir(cwd: string): string {
	return path.join(cwd, ".pi", "goals", ".locks");
}

export function lockPath(cwd: string, goalId: string): string {
	return path.join(lockDir(cwd), `${goalId}.lock`);
}

function ensureLockDir(cwd: string): void {
	try {
		fs.mkdirSync(lockDir(cwd), { recursive: true });
	} catch (err) {
		console.warn(`[goal-lock] failed to ensure lock dir ${lockDir(cwd)}:`, err);
	}
}

function isValidLockShape(parsed: unknown): parsed is GoalFocusLock {
	if (typeof parsed !== "object" || parsed === null) return false;
	const p = parsed as Record<string, unknown>;
	return (
		typeof p.goalId === "string" &&
		typeof p.owner === "object" && p.owner !== null &&
		typeof (p.owner as Record<string, unknown>).sessionId === "string" &&
		typeof (p.owner as Record<string, unknown>).pid === "number" &&
		typeof p.acquiredAt === "string" &&
		typeof p.expiresAt === "string" &&
		typeof p.heartbeatAt === "string"
	);
}

export function readLock(cwd: string, goalId: string): GoalFocusLock | null {
	try {
		const data = fs.readFileSync(lockPath(cwd, goalId), "utf8");
		const parsed: unknown = JSON.parse(data);
		if (!isValidLockShape(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * PID liveness check (D2 EPERM correctness).
 *
 * `process.kill(pid, 0)` throws:
 * - `ESRCH` when the PID does not exist → dead → false.
 * - `EPERM` when the process exists but is owned by another user → ALIVE → true.
 *   A naive `return false on throw` would mark a live cross-user process dead,
 *   causing false-positive stale locks and lock stealing.
 * - Any other error → treat as dead (fail-safe toward staleness, not false-held).
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		return code === "EPERM";
	}
}

export function isLockHeld(lock: GoalFocusLock): boolean {
	if (!isPidAlive(lock.owner.pid)) return false;
	const expiresAt = new Date(lock.expiresAt).getTime();
	if (Number.isNaN(expiresAt)) return false;
	return Date.now() < expiresAt;
}

export function isLockStale(lock: GoalFocusLock): boolean {
	return !isLockHeld(lock);
}

/**
 * Atomic write: tmp file then rename (POSIX-atomic).
 * FAIL-OPEN: fs errors are logged, never thrown.
 */
export function writeLockAtomic(cwd: string, goalId: string, lock: GoalFocusLock): void {
	ensureLockDir(cwd);
	const dir = lockDir(cwd);
	const final = lockPath(cwd, goalId);
	const tmp = path.join(dir, `.${lock.owner.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(tmp, JSON.stringify(lock));
		fs.renameSync(tmp, final);
	} catch (err) {
		console.warn(`[goal-lock] failed to write lock ${final}:`, err);
		try {
			fs.unlinkSync(tmp);
		} catch {
			// tmp may not exist; ignore
		}
	}
}

/**
 * Acquire flow (D5): read → if held by OTHER (different sessionId AND held),
 * fail with heldByOther → reap stale → write atomic → RE-READ to verify
 * ownership (boot-race loser backs off if verify mismatches).
 *
 * FAIL-OPEN: fs errors during write/verify result in { ok: false }, not throws.
 */
export function acquireLock(
	cwd: string,
	goalId: string,
	self: LockOwner,
	leaseMs: number,
): { ok: boolean; heldByOther?: GoalFocusLock } {
	ensureLockDir(cwd);
	const existing = readLock(cwd, goalId);
	if (existing) {
		if (existing.owner.sessionId !== self.sessionId && isLockHeld(existing)) {
			return { ok: false, heldByOther: existing };
		}
		if (isLockStale(existing)) {
			reapStaleLock(cwd, goalId);
		}
	}
	const now = Date.now();
	const lock: GoalFocusLock = {
		goalId,
		owner: self,
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + leaseMs).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
	};
	writeLockAtomic(cwd, goalId, lock);
	// Verify ownership — boot-race loser backs off if another session wrote
	// between our reap and our write (or if our write silently failed).
	const verified = readLock(cwd, goalId);
	if (!verified || verified.owner.sessionId !== self.sessionId) {
		return { ok: false };
	}
	return { ok: true };
}

/**
 * Release the lock. When `self` is provided, only deletes if the lock is
 * owned by self (don't touch others' locks). Without `self`, deletes
 * unconditionally (forced release / shutdown cleanup). FAIL-OPEN.
 */
export function releaseLock(cwd: string, goalId: string, self?: LockOwner): void {
	try {
		if (self) {
			const existing = readLock(cwd, goalId);
			if (!existing || existing.owner.sessionId !== self.sessionId) {
				return;
			}
		}
		fs.unlinkSync(lockPath(cwd, goalId));
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return;
		console.warn(`[goal-lock] failed to release lock ${lockPath(cwd, goalId)}:`, err);
	}
}

/**
 * Reap a stale lock if one exists. No-op if the lock is held or missing.
 */
export function reapStaleLock(cwd: string, goalId: string): void {
	try {
		const existing = readLock(cwd, goalId);
		if (!existing) return;
		if (isLockStale(existing)) {
			fs.unlinkSync(lockPath(cwd, goalId));
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return;
		console.warn(`[goal-lock] failed to reap stale lock ${lockPath(cwd, goalId)}:`, err);
	}
}

/**
 * Refresh the lease on a lock owned by self: re-write expiresAt and heartbeatAt.
 * FAIL-OPEN: fs errors are logged, never thrown (heartbeat must not crash the host).
 */
export function refreshLease(
	cwd: string,
	goalId: string,
	self: LockOwner,
	leaseMs: number,
): void {
	try {
		const existing = readLock(cwd, goalId);
		if (!existing || existing.owner.sessionId !== self.sessionId) {
			return;
		}
		const now = Date.now();
		const updated: GoalFocusLock = {
			...existing,
			expiresAt: new Date(now + leaseMs).toISOString(),
			heartbeatAt: new Date(now).toISOString(),
		};
		writeLockAtomic(cwd, goalId, updated);
	} catch (err) {
		console.warn(`[goal-lock] failed to refresh lease ${lockPath(cwd, goalId)}:`, err);
	}
}
