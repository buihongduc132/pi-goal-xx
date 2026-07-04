import {
	compactStatusLabel,
	displayObjectiveTitle,
	formatAbsoluteShort,
	formatRelativeTime,
	formatDuration,
	formatTokenValue,
	shortGoalId,
	shortSessionId,
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

export interface GoalSelectorLabelOptions {
	/** Pre-resolved display id (short or full on collision). Defaults to shortGoalId(goal.id). */
	shortId?: string;
	/** Holding session id if another live session holds the focus lock; surfaces a lock pill. */
	heldByOtherSession?: string | null;
}

/**
 * Resolve a stable display id for each goal in the pool. When two+ goals
 * collide on the short suffix (after the final '-'), all colliding entries
 * fall back to their full id so selection remains unambiguous.
 */
export function resolveShortIdsForPool(goals: GoalRecord[]): Map<string, string> {
	const shortById = new Map<string, string>();
	const collisionSuffixes = new Set<string>();
	for (const g of goals) {
		const short = shortGoalId(g.id);
		if (shortById.has(short)) collisionSuffixes.add(short);
		shortById.set(short, g.id);
	}
	const out = new Map<string, string>();
	for (const g of goals) {
		const short = shortGoalId(g.id);
		out.set(g.id, collisionSuffixes.has(short) ? g.id : short);
	}
	return out;
}

export function goalSelectorLabel(goal: GoalRecord, focusedGoalId: string | null, opts?: GoalSelectorLabelOptions): string {
	const marker = goal.id === focusedGoalId ? "*" : " ";
	const glyph = goal.sisyphus ? "✊ " : "";
	const shortId = opts?.shortId ?? shortGoalId(goal.id);
	const status = compactStatusLabel(goal);
	const abs = formatAbsoluteShort(goal.updatedAt);
	const rel = formatRelativeTime(goal.updatedAt);
	const title = truncateText(displayObjectiveTitle(goal.objective), 72);
	const lockPill = opts?.heldByOtherSession ? ` 🔒 ${shortSessionId(opts.heldByOtherSession)}` : "";
	return `${marker} ${glyph}${shortId} · ${status} · ${abs} ${rel} · ${title}${lockPill}`;
}

export interface BuildGoalListTextOptions {
	/** Map of goalId → holding session id for goals held by OTHER live sessions. */
	heldByOther?: Map<string, string> | null;
}

/**
 * Stable ordering for the picker: running goals (active + autoContinue) first,
 * then everything else by updatedAt descending. Does not mutate the input.
 */
export function sortGoalsForPicker(goals: GoalRecord[]): GoalRecord[] {
	const rank = (g: GoalRecord): number => (g.status === "active" && g.autoContinue ? 0 : 1);
	return goals.slice().sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra !== rb) return ra - rb;
		// updatedAt desc; fall back to id for stable tiebreak.
		const byUpdated = (b.updatedAt || "").localeCompare(a.updatedAt || "");
		return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
	});
}

export function buildGoalListText(pool: Map<string, GoalRecord>, focusedGoalId: string | null, opts?: BuildGoalListTextOptions): string {
	const open = openGoalsFromPool(pool);
	if (open.length === 0) return "No open goals. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const shortIds = resolveShortIdsForPool(open);
	const sorted = sortGoalsForPicker(open);
	const heldByOther = opts?.heldByOther ?? null;
	const lines = [
		`Open goals: ${open.length}`,
		"Columns: · short-id · status · updated · objective",
		"",
	];
	for (const goal of sorted) {
		lines.push(goalSelectorLabel(goal, focusedGoalId, {
			shortId: shortIds.get(goal.id),
			heldByOtherSession: heldByOther?.get(goal.id) ?? null,
		}));
		lines.push(`  ${displayObjectiveTitle(goal.objective)}`);
		const usage = goal.usage.tokensUsed > 0 || goal.usage.activeSeconds > 0
			? ` · ${formatDuration(goal.usage.activeSeconds)} · ${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}`
			: "";
		if (usage) lines.push(`  usage${usage}`);
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
