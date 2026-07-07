/**
 * Lease-based advisory focus lock for goals (add-goal-focus-locking, Unit A).
 *
 * One JSON sidecar per locked goal at `<cwd>/.pi/goals/.locks/<goalId>.lock`.
 * Lock is HELD iff owning PID is alive (identity-checked via start time, D1) AND
 * lease is fresh (three-signal liveness: PID-existence + process-identity + lease).
 * All fs operations are FAIL-OPEN: locking is an optimization, not a security boundary.
 *
 * LOCKED design: D1 (format/location + start-time identity), D2 (liveness + EPERM
 * correctness), D3 (lease window — caller-supplied via leaseMs), D5 (advisory —
 * caller prompts on override). PID-recycle hardening (D1–D4): owner.startTimeMs is
 * recorded at acquisition and cross-checked by isPidAlive to defeat PID recycling
 * within the lease window. Reap-on-read (D5/D6): computeHeldByOther and
 * confirmFocusOverride reap STALE locks on sight, never HELD ones.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface GoalFocusLock {
	goalId: string;
	owner: { sessionId: string; pid: number; startTimeMs?: number | null };
	acquiredAt: string;
	expiresAt: string;
	heartbeatAt: string;
}

export interface LockOwner {
	sessionId: string;
	pid: number;
	startTimeMs?: number | null;
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
		// D4: normalize legacy locks — a missing startTimeMs becomes null (not
		// undefined) so isPidAlive deterministically falls back to PID-existence-only.
		if (parsed.owner.startTimeMs === undefined) {
			parsed.owner.startTimeMs = null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Read the host boot time (epoch ms) from /proc/stat `btime` (Linux).
 * Cached per-process-lifetime (constant within a boot — R2).
 * Returns null on error / non-Linux (fail-open).
 */
let cachedBootTimeMs: number | null | undefined;
export function readBootTimeMs(): number | null {
	if (cachedBootTimeMs !== undefined) return cachedBootTimeMs;
	if (process.platform !== "linux") {
		cachedBootTimeMs = null;
		return null;
	}
	try {
		const stat = fs.readFileSync("/proc/stat", "utf8");
		const line = stat.split("\n").find((l) => l.startsWith("btime"));
		if (!line) {
			cachedBootTimeMs = null;
			return null;
		}
		const seconds = Number(line.trim().split(/\s+/)[1]);
		if (!Number.isFinite(seconds)) {
			cachedBootTimeMs = null;
			return null;
		}
		cachedBootTimeMs = seconds * 1000;
		return cachedBootTimeMs;
	} catch {
		cachedBootTimeMs = null;
		return null;
	}
}

/**
 * Resolve a process's real start time (epoch ms) for identity checking (D1/D2/D3).
 *
 * - Linux: /proc/<pid>/stat field 22 (clock ticks since boot) → bootMs + (ticks/100)*1000.
 *   CLK_TCK is virtually always 100 on Linux (hardcoded; field is stable).
 * - macOS: `ps -p <pid> -o lstart=` → parse the timestamp to epoch ms.
 * - Other platforms / unreadable /proc: null (fail-open, no throw).
 *
 * Returns null on any error (ENOENT, EACCES, parse failure) — the caller
 * (isPidAlive) then falls back to PID-existence-only.
 */
export function getProcessStartTime(pid: number): number | null {
	try {
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 2 "(comm)" may contain spaces/parens; split AFTER the last ')'.
			// Fields after comm are 1-indexed from field 3; starttime is field 22 → index 19.
			const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			const ticks = Number(afterComm[19]);
			if (!Number.isFinite(ticks)) return null;
			const bootMs = readBootTimeMs();
			if (bootMs === null) return null;
			const CLK_TCK = 100;
			return bootMs + (ticks / CLK_TCK) * 1000;
		}
		if (process.platform === "darwin") {
			const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();
			const ms = Date.parse(out);
			return Number.isFinite(ms) ? ms : null;
		}
		return null;
	} catch {
		// ENOENT (dead pid), EACCES (hidepid), exec failure, etc. → fail-open.
		return null;
	}
}

/**
 * PID liveness check (D2 EPERM correctness + D1 process-identity).
 *
 * `process.kill(pid, 0)` throws:
 * - `ESRCH` when the PID does not exist → dead → false.
 * - `EPERM` when the process exists but is owned by another user → ALIVE → true.
 *   A naive `return false on throw` would mark a live cross-user process dead,
 *   causing false-positive stale locks and lock stealing.
 * - Any other error → treat as dead (fail-safe toward staleness, not false-held).
 *
 * Identity check (D1): when `startTimeMs` is provided (a number), cross-check
 * the live process's REAL start time. A mismatch means the PID was recycled to
 * a different process → return false (defeats PID-recycle false-held). When
 * `startTimeMs` is null/undefined (legacy lock), fall back to PID-existence-only.
 */
export function isPidAlive(pid: number, startTimeMs?: number | null): boolean {
	try {
		process.kill(pid, 0);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		return code === "EPERM";
	}
	// PID exists. If we have an identity signal, cross-check it.
	if (startTimeMs != null) {
		const real = getProcessStartTime(pid);
		// If we can't read the real start time (hidepid/permission), be
		// conservative: treat as alive (don't steal a possibly-live lock — D6).
		if (real === null) return true;
		return Math.abs(real - startTimeMs) <= 10;
	}
	return true;
}

export function isLockHeld(lock: GoalFocusLock): boolean {
	if (!isPidAlive(lock.owner.pid, lock.owner.startTimeMs)) return false;
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
		owner: { ...self, startTimeMs: getProcessStartTime(self.pid) },
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
			// TOCTOU guard: re-read right before unlink. Another session may have
			// acquired a fresh lock (after ours went stale and was reaped) between
			// an earlier read and this unlink. Verify identity is still ours.
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
		if (!isLockStale(existing)) return;
		// TOCTOU guard: re-read right before unlink. Between the stale read above
		// and the unlink below, another session may have acquired a fresh lock
		// (reaping the stale one and writing its own). Unlinking blindly would
		// delete the newcomer's fresh lock → transient split-brain. Verify the
		// on-disk lock is STILL the same stale one before unlinking.
		const current = readLock(cwd, goalId);
		if (
			!current ||
			current.owner.sessionId !== existing.owner.sessionId ||
			current.acquiredAt !== existing.acquiredAt ||
			!isLockStale(current)
		) {
			return;
		}
		fs.unlinkSync(lockPath(cwd, goalId));
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
			owner: { ...existing.owner, startTimeMs: getProcessStartTime(self.pid) },
			expiresAt: new Date(now + leaseMs).toISOString(),
			heartbeatAt: new Date(now).toISOString(),
		};
		writeLockAtomic(cwd, goalId, updated);
	} catch (err) {
		console.warn(`[goal-lock] failed to refresh lease ${lockPath(cwd, goalId)}:`, err);
	}
}
