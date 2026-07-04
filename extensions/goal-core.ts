export interface GoalUsageLike {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalDisplayRecordLike {
	objective: string;
	status: "active" | "paused" | "complete";
	autoContinue: boolean;
	usage: GoalUsageLike;
	sisyphus: boolean;
	stopReason?: "user" | "agent";
}

export { isQuestionLikeToolName } from "./goal-tool-names.ts";


export function truncateText(value: string, max = 120): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/**
 * Sanitize a display title line by stripping leading markdown noise:
 * code fences (``` or ````), blockquote markers (>), and surrounding
 * single/double quotes. Repeats until stable so combined prefixes like
 * `> ``` "text"` collapse to `text`. Operates on the already-extracted
 * title line only; never mutates persisted objective text.
 */
function sanitizeTitleLine(line: string): string {
	let out = line;
	for (let i = 0; i < 8; i++) {
		const before = out;
		// Leading blockquote marker.
		out = out.replace(/^>\s*/, "");
		// Leading code fence (3+ backticks, optional language tag).
		out = out.replace(/^`{3,}[a-zA-Z0-9_+-]*\s*/, "");
		// Trailing code fence.
		out = out.replace(/\s*`{3,}$/, "");
		if (out === before) break;
	}
	// Strip a single pair of surrounding quotes (single or double).
	if (out.length >= 2) {
		const first = out[0];
		const last = out[out.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			out = out.slice(1, -1);
		}
	}
	return out.trim();
}

export function displayObjectiveTitle(objective: string): string {
	const lines = objective.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
	const sectionHeader = /^(success criteria|boundaries|constraints|steps|order rules|don'ts|if blocked|if blocked \/ unclear \/ failing|sisyphus reminder)\s*[:：]/i;
	// When a candidate title line sanitizes to empty (e.g. a standalone code
	// fence), skip it and continue to the next line rather than returning "".
	for (const line of lines) {
		if (/^=+\s*(?:sisyphus\s+)?goal\s*=+$/i.test(line)) continue;
		const objectiveMatch = line.match(/^(?:objective|目标)\s*[:：]\s*(.+)$/i);
		if (objectiveMatch?.[1]) {
			const candidate = sanitizeTitleLine(objectiveMatch[1].trim());
			if (candidate) return candidate;
			continue;
		}
		if (sectionHeader.test(line)) continue;
		const candidate = sanitizeTitleLine(line);
		if (candidate) return candidate;
	}
	const fallback = sanitizeTitleLine(truncateText(objective));
	return fallback;
}

export function formatTokenValue(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	const compact =
		safe >= 1_000_000_000
			? `${(safe / 1_000_000_000).toFixed(safe >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`
			: safe >= 1_000_000
				? `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
				: safe >= 10_000
					? `${(safe / 1_000).toFixed(0)}K`
					: safe >= 1_000
						? `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}K`
						: String(safe);
	const exact = safe.toLocaleString("en-US");
	if (compact === exact) return `${exact} tokens`;
	return `${compact} (${exact}) tokens`;
}

export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${secs.toString().padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m${secs.toString().padStart(2, "0")}s`;
	return `${secs}s`;
}

/**
 * Compact status pill for picker/list rows. NEVER duplicates the sisyphus
 * marker (that is shown as a leading glyph on the row itself). Verbose
 * consumers (footer widget, auditor) keep using statusLabel().
 */
export function compactStatusLabel(goal: Pick<GoalDisplayRecordLike, "status" | "autoContinue" | "stopReason">): string {
	if (goal.status === "active" && goal.autoContinue) return "running";
	if (goal.status === "paused" && goal.stopReason === "agent") return "paused·agent";
	if (goal.status === "paused") return "paused";
	return goal.status;
}

/**
 * Short human id: substring after the final '-'. Falls back to the whole id
 * when there is no dash.
 */
export function shortGoalId(id: string): string {
	const idx = id.lastIndexOf("-");
	return idx >= 0 ? id.slice(idx + 1) : id;
}

/**
 * Short session id: last 6 chars (or whole id if shorter). Used for the
 * lock-owner pill.
 */
export function shortSessionId(sessionId: string): string {
	return sessionId.length > 6 ? sessionId.slice(-6) : sessionId;
}

/**
 * Relative time from an ISO timestamp. Future timestamps clamp to 'just now'
 * (clock skew tolerance). Invalid/empty timestamps return '—'.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
	if (!iso) return "—";
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "—";
	const diffMs = now - ts;
	if (diffMs < 0) return "just now"; // future → clamp
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return "just now";
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Short absolute local time: 'MM-DD HH:mm'. Invalid/empty → '—'.
 */
export function formatAbsoluteShort(iso: string): string {
	if (!iso) return "—";
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "—";
	const d = new Date(ts);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mi = String(d.getMinutes()).padStart(2, "0");
	return `${mm}-${dd} ${hh}:${mi}`;
}

export function statusLabel(goal: Pick<GoalDisplayRecordLike, "sisyphus" | "status" | "autoContinue" | "stopReason">): string {
	const prefix = goal.sisyphus ? "sisyphus " : "";
	if (goal.status === "active" && goal.autoContinue) return `${prefix}running`;
	if (goal.status === "paused" && goal.stopReason === "agent") return `${prefix}paused (agent)`;
	return `${prefix}${goal.status}`;
}

export function footerStatus(goal: GoalDisplayRecordLike): string {
	const usageBits: string[] = [];
	if (goal.usage.activeSeconds > 0) usageBits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) usageBits.push(formatTokenValue(goal.usage.tokensUsed).split(" ")[0]);
	const usage = usageBits.length > 0 ? ` [${usageBits.join(" ")}]` : "";
	const prefix = goal.sisyphus ? "goal✊" : "goal";
	return `${prefix}: ${statusLabel(goal)}${usage} - ${truncateText(goal.objective, 60)}`;
}
