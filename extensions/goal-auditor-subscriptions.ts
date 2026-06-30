/**
 * Auditor event subscriptions — async, non-blocking forwarding.
 *
 * When a subscribed lifecycle/task/contract event fires, this module appends
 * an `audit_subscription_emitted` ledger entry and emits a UI notification.
 * It does NOT invoke the synchronous completion auditor (that path stays
 * exclusively on `complete_goal`). The "forward" is purely informational:
 * the auditor processes queued events later, off the critical path.
 *
 * Invariants:
 *  - Non-blocking. Failures are swallowed and logged; they never break the
 *    calling tool (e.g. pause_goal, skip_task).
 *  - Unmatched event names in config are silently skipped.
 *  - `mode` is restricted to "async" — sync invocation is not supported yet.
 */

import type { GoalLedgerContext } from "./goal-ledger.ts";
import { appendGoalEvent } from "./goal-ledger.ts";
import type { AuditorSubscription, GoalSettings } from "./goal-settings.ts";

export interface AuditorEventPayload {
	goalId?: string;
	taskId?: string;
	/** Free-form details (reason, contract text, error message, etc.). */
	details?: Record<string, unknown>;
}

/**
 * Returns true if `settings.auditorSubscriptions` contains an entry whose
 * `event` matches `eventName` with `mode: "async"`. Unknown event names in
 * config are silently skipped (no match).
 */
export function isAuditorSubscribed(
	settings: GoalSettings | undefined,
	eventName: string,
): boolean {
	if (!settings?.auditorSubscriptions) return false;
	return settings.auditorSubscriptions.some(
		(s: AuditorSubscription) => s.event === eventName && s.mode === "async",
	);
}

/**
 * Asynchronously forward `eventName` to the auditor channel if subscribed.
 *
 * This function is deliberately fire-and-forget: it schedules the ledger
 * append + UI notify on the microtask queue and never throws to the caller.
 * Call it at lifecycle/task/contract boundaries (pause, abort, contract
 * violation, task skip, complete_task failure, audit_started).
 */
export function emitAuditorSubscription(
	ctx: GoalLedgerContext,
	settings: GoalSettings | undefined,
	eventName: string,
	payload: AuditorEventPayload,
	nowIso: () => string,
	notify?: (msg: string, kind?: "info" | "warning" | "error") => void,
): void {
	if (!isAuditorSubscribed(settings, eventName)) return;
	// Defer to microtask so the caller's tool return is not delayed.
	queueMicrotask(() => {
		try {
			appendGoalEvent(ctx, {
				type: "audit_subscription_emitted",
				event: eventName,
				goalId: payload.goalId,
				taskId: payload.taskId,
				details: payload.details,
				at: nowIso(),
			});
		} catch {
			// Ledger failure must not propagate.
		}
		try {
			notify?.(
				`Auditor subscription: ${eventName}` +
					(payload.goalId ? ` (goal=${payload.goalId})` : "") +
					(payload.taskId ? ` task=${payload.taskId}` : ""),
				"info",
			);
		} catch {
			// UI notify failure must not propagate.
		}
	});
}
