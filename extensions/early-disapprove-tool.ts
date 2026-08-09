/**
 * early_disapprove tool — auditor early-disapproval signal (LD1 + LD9, OT8).
 *
 * Spec: flow/findings/2026-07-31-auditor-capabilities-gaps/
 *   - 2026-07-31-locked-decisions.yaml → LD1 (auditor must be able to abort
 *     mid-stream when it finds a disqualifying issue), LD9 (signal mechanism
 *     is a dedicated tool call `early_disapprove(reason)`, NOT a raw
 *     text_delta marker).
 *   - 2026-07-31-open-threads.yaml → OT8 (Rank 1 CRITICAL: the auditor host
 *     watches the `tool_execution_start` event for toolName ===
 *     "early_disapprove"; watching text_delta for <disapproved/> mid-stream
 *     false-positives on quoted markers and is REJECTED).
 *
 * This module exports the tool definition only. The detection + abort wiring
 * lives in goal-auditor.ts (the session.subscribe handler). When the auditor
 * model calls this tool, the host observes the tool_execution_start event,
 * captures `args.reason`, aborts the session, and marks the result
 * early-disapproved — see runGoalCompletionAuditor.
 */
import type { Static } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

/** Canonical tool name. The host matches tool_execution_start.toolName against this. */
export const EARLY_DISAPPROVE_TOOL_NAME = "early_disapprove";

/**
 * Parameters for early_disapprove. `reason` is REQUIRED so the auditor host
 * always has a structured, attributable explanation for the early abort
 * (surfaced in GoalAuditorResult.earlyDisapprovalReason — LD9).
 */
export const earlyDisapproveParams = Type.Object({
	reason: Type.String({
		description:
			"Concise explanation of the disqualifying issue that makes early disapproval appropriate (e.g. 'objective artifact missing — only a scaffold exists'). Surfaced verbatim in the audit result.",
	}),
});

/**
 * The early_disapprove tool.
 *
 * Calling this tool ABORTS the audit session IMMEDIATELY and marks the goal as
 * disapproved with the provided reason, WITHOUT running further checks. The
 * auditor model should call it early — the moment it finds a disqualifying
 * issue that cannot be recovered from (e.g. the goal output is missing, a
 * critical file does not exist, a hard contract is unmet). It must NOT be used
 * for borderline cases — those still end in a normal <approved/> / <disapproved/>
 * verdict after the full audit.
 *
 * The execute() body is a no-op fallback that echoes the reason. In production
 * the host aborts the session on tool_execution_start BEFORE execute() runs, so
 * the body is only reached in isolated unit tests / if the host wiring is
 * absent. It still returns the reason in its content so the structured reason
 * is recoverable from the tool call record either way.
 */
export const earlyDisapproveTool = defineTool({
	name: EARLY_DISAPPROVE_TOOL_NAME,
	label: "Early Disapprove (abort audit immediately)",
	description:
		"Abort the audit session IMMEDIATELY and mark the goal as disapproved early, without running further checks. Call this as soon as you find a disqualifying issue that cannot be recovered from (the goal output is missing, a critical file does not exist, a hard contract is unmet). Do NOT use this for borderline cases — those still end in a normal <approved/> or <disapproved/> verdict after the full audit. The provided reason is surfaced verbatim in the audit result.",
	promptSnippet:
		"early_disapprove(reason): abort the audit immediately and mark the goal disapproved early (use only for clear, unrecoverable disqualifications found early).",
	promptGuidelines: [
		"Call early_disapprove(reason) IMMEDIATELY when you find a disqualifying issue that cannot be recovered from — for example the goal's primary artifact is missing, a critical file does not exist, or a hard requirement is provably unmet.",
		"Calling early_disapprove aborts the audit session at once and marks the goal disapproved without running further checks.",
		"Do NOT use early_disapprove for borderline cases or minor gaps — those still end in a normal <approved/> or <disapproved/> verdict after the full audit.",
		"The `reason` you pass is surfaced verbatim to the user, so make it specific and attributable (name the missing artifact, the unmet contract, or the failed check).",
	],
	parameters: earlyDisapproveParams,
	executionMode: "sequential",
	async execute(_toolCallId, params) {
		const { reason } = params as Static<typeof earlyDisapproveParams>;
		return {
			content: [
				{
					type: "text",
					text: `Early disapproval triggered — audit aborted immediately.\n\nReason: ${reason}`,
				},
			],
			details: { earlyDisapproved: true, reason },
		};
	},
});
