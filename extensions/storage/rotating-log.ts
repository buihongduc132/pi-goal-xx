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
import * as path from "node:path";

/** Default cap per rotating log file (10 MB). */
export const DEFAULT_ROTATING_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Default number of rotated archives to keep (`.1`, `.2`, `.3`). */
export const DEFAULT_ROTATING_LOG_KEEP = 3;

/**
 * Rotate `filePath` if its current size is at or over `maxBytes`.
 * Renames `filePath`→`filePath.1`, `filePath.1`→`filePath.2`, …, and unlinks
 * the oldest (`.<keepCount>`). Best-effort: any error is swallowed so the
 * caller's append still runs.
 */
export function rotateIfNeeded(
	filePath: string,
	maxBytes = DEFAULT_ROTATING_LOG_MAX_BYTES,
	keepCount = DEFAULT_ROTATING_LOG_KEEP,
): void {
	if (keepCount < 1) return;
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		// File may not exist yet; nothing to rotate.
		return;
	}
	if (size < maxBytes) return;
	try {
		// Drop the oldest rotation, then shift each older rotation down by one.
		const oldest = `${filePath}.${keepCount}`;
		try { fs.unlinkSync(oldest); } catch { /* may not exist */ }
		for (let i = keepCount - 1; i >= 1; i--) {
			const from = `${filePath}.${i}`;
			const to = `${filePath}.${i + 1}`;
			try { fs.renameSync(from, to); } catch { /* may not exist */ }
		}
		// Finally rotate the live file to .1.
		fs.renameSync(filePath, `${filePath}.1`);
	} catch {
		// Rotation failure must not block the append. The caller writes next.
	}
}

/**
 * Resolve the rotation parameters for a log path. Exposed for tests that want
 * to assert the resolved cap without hardcoding the default.
 */
export function rotationParams(
	maxBytes?: number,
	keepCount?: number,
): { maxBytes: number; keepCount: number } {
	return {
		maxBytes: maxBytes ?? DEFAULT_ROTATING_LOG_MAX_BYTES,
		keepCount: keepCount ?? DEFAULT_ROTATING_LOG_KEEP,
	};
}

/** Build the `.N` rotation path for a base file (test helper). */
export function rotatedPath(filePath: string, index: number): string {
	return path.format({ ...path.parse(filePath), base: `${path.parse(filePath).base}.${index}` });
}
