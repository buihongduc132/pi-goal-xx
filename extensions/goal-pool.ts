import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import { cloneGoal, type GoalFocusEntry, type GoalRecord } from "./goal-record.ts";
import { isLockHeld, readLock } from "./goal-lock.ts";

export function goalPoolFromGoals(goals: Iterable<GoalRecord>): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of goals) {
		if (goal.status !== "complete") pool.set(goal.id, cloneGoal(goal));
	}
	return pool;
}

export function openGoalsFromPool(pool: Map<string, GoalRecord>): GoalRecord[] {
	return Array.from(pool.values())
		.filter((goal) => goal.status !== "complete")
		.sort((a, b) => {
			const byCreated = a.createdAt.localeCompare(b.createdAt);
			return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
		});
}

export function focusedGoalFromPool(pool: Map<string, GoalRecord>, focusedGoalId: string | null): GoalRecord | null {
	if (!focusedGoalId) return null;
	const goal = pool.get(focusedGoalId) ?? null;
	return goal;
}

export function otherOpenGoalCount(pool: Map<string, GoalRecord>, focusedGoalId: string | null): number {
	return openGoalsFromPool(pool).filter((goal) => goal.id !== focusedGoalId).length;
}

/**
 * Resolve which goal (if any) this session should auto-focus on startup/tree-nav.
 *
 * Explicit intent paths (focusEntry, legacyGoal) ALWAYS win — they are
 * user/branch choices and are NOT gated by reason or by lock state. Only the
 * single-open-goal AUTO-FOCUS fallback at the end is gated, per LD3 (resume
 * only) and the advisory lock (don't steal from another live session).
 */
export function resolveSessionFocus(args: {
	pool: Map<string, GoalRecord>;
	focusEntry?: GoalFocusEntry | null;
	legacyGoal?: GoalRecord | null;
	autoFocusReason: string | null;
	cwd?: string;
	selfSessionId?: string;
}): string | null {
	const focusedGoalId = args.focusEntry?.focusedGoalId ?? null;
	const focused = focusedGoalId ? focusedGoalFromPool(args.pool, focusedGoalId) : null;
	if (focused && focused.status !== "complete") {
		return focusedGoalId;
	}
	if (args.focusEntry) {
		return null;
	}
	if (args.legacyGoal && args.legacyGoal.status !== "complete") {
		if (args.pool.has(args.legacyGoal.id)) return args.legacyGoal.id;
		args.pool.set(args.legacyGoal.id, cloneGoal(args.legacyGoal));
		return args.legacyGoal.id;
	}
	const open = openGoalsFromPool(args.pool);
	if (open.length !== 1) return null;
	const candidate = open[0]?.id ?? null;
	if (!candidate) return null;
	// --- auto-focus gate (LD3 + advisory lock) ---
	// Every caller MUST pass autoFocusReason explicitly (string or null). There
	// is NO `undefined` legacy-bypass: omitting the reason silently re-enabling
	// auto-focus on any reason would violate LD3 ("resume only") and re-open
	// the goal-stealing bug (F5). The only opt-out is PI_GOAL_AUTO_FOCUS=all.
	// PI_GOAL_AUTO_FOCUS=all opts into legacy auto-focus on any reason.
	const autoFocusMode = (typeof process !== "undefined" && process.env?.PI_GOAL_AUTO_FOCUS) || "resume";
	if (autoFocusMode !== "all" && args.autoFocusReason !== "resume") {
		// Non-resume reasons (new/startup/fork/reload/null) do NOT auto-focus.
		return null;
	}
	// Don't auto-focus a goal another live session is actively working on.
	if (args.cwd && args.selfSessionId) {
		const lock = readLock(args.cwd, candidate);
		if (lock && lock.owner.sessionId !== args.selfSessionId && isLockHeld(lock)) {
			return null;
			}
	}
	return candidate;
}

export function goalSelectorLabel(goal: GoalRecord, focusedGoalId: string | null): string {
	const marker = goal.id === focusedGoalId ? "*" : " ";
	const mode = goal.sisyphus ? "sisyphus" : "goal";
	const path = goal.activePath ? ` ${goal.activePath}` : "";
	return `${marker} ${goal.id} | ${statusLabel(goal)} | ${mode} | ${truncateText(displayObjectiveTitle(goal.objective), 72)}${path}`;
}

export function buildGoalListText(pool: Map<string, GoalRecord>, focusedGoalId: string | null): string {
	const open = openGoalsFromPool(pool);
	if (open.length === 0) return "No open goals. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const lines = [`Open goals: ${open.length}`, ""];
	for (const goal of open) {
		const focused = goal.id === focusedGoalId ? "*" : " ";
		const mode = goal.sisyphus ? "sisyphus" : "goal";
		const usage = goal.usage.tokensUsed > 0 || goal.usage.activeSeconds > 0
			? ` · ${formatDuration(goal.usage.activeSeconds)} · ${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}`
			: "";
		lines.push(`${focused} ${goal.id} — ${statusLabel(goal)} · ${mode}${usage}`);
		lines.push(`  ${displayObjectiveTitle(goal.objective)}`);
		if (goal.activePath) lines.push(`  ${goal.activePath}`);
	}
	return lines.join("\n");
}

export function buildUnfocusedOpenGoalsSummary(openGoalCount: number): string {
	return `No goal is focused in this session. ${openGoalCount} open goal${openGoalCount === 1 ? "" : "s"} exist in .pi/goals. Use /goal-focus to choose the session focus before doing goal work.`;
}

export function mergeFocusedGoalWithDisk(args: { memoryGoal: GoalRecord; diskGoal: GoalRecord }): GoalRecord {
	const tokensUsed = Math.max(args.memoryGoal.usage.tokensUsed, args.diskGoal.usage.tokensUsed);
	const activeSeconds = Math.max(args.memoryGoal.usage.activeSeconds, args.diskGoal.usage.activeSeconds);
	return {
		...args.diskGoal,
		usage: { tokensUsed, activeSeconds },
	};
}
