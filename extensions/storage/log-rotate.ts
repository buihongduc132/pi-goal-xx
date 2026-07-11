/**
 * G5 fix — size-capped JSONL rotation.
 *
 * Long-running pi sessions can write unbounded bytes to append-only logs
 * (auditor trace, goal ledger). This helper caps the active file at `capBytes`
 * and rotates to `file.1`, `file.2`, … keeping `keep` rotations. It is
 * best-effort: any rotation failure falls back to the existing append.
 */
import * as fs from "node:fs";

export interface RotateLogArgs {
	filePath: string;
	capBytes: number;
	keep: number;
}

/**
 * Ensure the active log file is under the cap by rotating old files away.
 * Must be called BEFORE appending a new line. Synchronous: callers already
 * do synchronous fs writes for the actual append.
 */
export function rotateLogIfNeeded(args: RotateLogArgs): void {
	const { filePath, capBytes, keep } = args;
	try {
		if (!fs.existsSync(filePath)) return;
		const stat = fs.statSync(filePath);
		if (stat.size < capBytes) return;

		// Shift existing rotations: keep-1 -> keep, keep-2 -> keep-1, ... 1 -> 2
		for (let i = keep - 1; i >= 1; i--) {
			const src = `${filePath}.${i}`;
			if (fs.existsSync(src)) {
				const dest = `${filePath}.${i + 1}`;
				fs.renameSync(src, dest);
			}
		}
		// Active file becomes rotation 1
		fs.renameSync(filePath, `${filePath}.1`);
	} catch {
		// Rotation is best-effort. If anything fails (concurrent rename, perms),
		// the caller will still append to the existing file; unbounded growth is
		// still better than a crash.
	}
}
