/**
 * G5 — size-capped rotating log appender.
 *
 * Append-only JSONL (or any text) logs under `<cwd>/.pi/goals/` can grow
 * unbounded and fill the disk. This helper caps each log file at `maxBytes`;
 * when the next append would push it over the cap it rotates the file to `.1`,
 * shifts prior rotations down (`.1`→`.2`, `.2`→`.3`), and drops anything past
 * `keepCount`. The next line then starts a fresh file.
 *
 * Used by:
 *   - auditor-log.ts → auditor-trace.jsonl
 *   - goal-ledger.ts → goal_events.jsonl
 *
 * Invariants:
 *   - NEVER throws — disk failures are swallowed (the caller's append is the
 *     source of truth; rotation is best-effort).
 *   - The size check is stat-based and runs BEFORE the append.
 */

import * as fs from "node:fs";

/** Default cap per rotating log file (10 MB). */
export const DEFAULT_ROTATING_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Default number of rotated archives to keep (`.1`, `.2`, `.3`). */
export const DEFAULT_ROTATING_LOG_KEEP = 3;

/**
 * Rotate `filePath` if appending `appendBytes` more would push it over
 * `maxBytes`. Accounts for the incoming line length so a single oversized
 * record can't silently blow past the cap (review P2). Renames
 * `filePath`→`filePath.1`, `filePath.1`→`filePath.2`, …, and unlinks the
 * oldest (`.<keepCount>`). Best-effort: any error is swallowed so the
 * caller's append still runs.
 *
 * Single-writer assumption (cubic-dev P2): the stat-then-return design leaves
 * a race window between this helper returning and the caller appending. This
 * is safe under pi-goal's single-writer-per-cwd model (the goal lock serializes
 * complete_goal; auditor-trace writes are sync and single-threaded). Concurrent
 * writers to the same path would need an advisory lock.
 */
export function rotateIfNeeded(
	filePath: string,
	maxBytes = DEFAULT_ROTATING_LOG_MAX_BYTES,
	keepCount = DEFAULT_ROTATING_LOG_KEEP,
	appendBytes = 0,
): void {
	if (keepCount < 1) return;
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		// File may not exist yet; nothing to rotate.
		return;
	}
	// Rotate when the EXISTING size already meets the cap, OR when appending
	// the next record would push it over. This bounds growth even for a single
	// large incoming line.
	if (size < maxBytes && size + appendBytes <= maxBytes) return;
	try {
		// Drop the oldest rotation, then shift each older rotation down by one.
		const oldest = `${filePath}.${keepCount}`;
		try { fs.unlinkSync(oldest); } catch (e) {
			// ENOENT = file doesn't exist yet (expected); re-throw anything else
			// so a transient I/O error aborts the partial rotation before a
			// later successful shift overwrites retained archives (cubic-dev P1).
			if (!isENOENT(e)) throw e;
		}
		for (let i = keepCount - 1; i >= 1; i--) {
			const from = `${filePath}.${i}`;
			const to = `${filePath}.${i + 1}`;
			try { fs.renameSync(from, to); } catch (e) {
				// Only swallow "file doesn't exist" — a real I/O error must abort
				// the rotation to avoid cascading overwrites of retained archives.
				if (!isENOENT(e)) throw e;
			}
		}
		// Finally rotate the live file to .1.
		fs.renameSync(filePath, `${filePath}.1`);
	} catch {
		// Rotation failure must not block the append. The caller writes next.
		// The next append will retry rotation on the following call.
	}
}

/** True only for "file not found" errors (expected during rotation). */
function isENOENT(e: unknown): boolean {
	return e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT";
}
