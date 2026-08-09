# Finding — WebUI pi runs RPC mode; `ctx.ui.custom()` is a no-op (goal-xx tools degrade to headless by design)

- date: 2026-07-16
- status: confirmed, not-actioned (deferred)
- scope: pi-goal-xx tools in WebUI (RPC mode)

## TL;DR

WebUI pi runs pi in **RPC mode** (`mode: "rpc"`). RPC has a REAL uiContext → `ctx.hasUI === true`. BUT `ctx.ui.custom()` returns `undefined` ("Custom UI not supported in RPC mode"). pi-goal-xx adapted via `isInteractiveTui(ctx)` so all `ctx.ui.custom()`-based tools (questionnaire, draft, task-list, escape dialog) degrade to **headless** in WebUI. This is by design, not breakage. The 9 raw-`ctx.hasUI` gates are audited safe (only call RPC-supported methods).

## Evidence

### 1. WebUI = RPC mode

`~/.local/share/mise/installs/node/.../pi-coding-agent/dist/modes/rpc/rpc-mode.js`:

- L231: `mode: "rpc"` passed to `session.bindExtensions(...)`.
- L82 `createExtensionUIContext()` returns a REAL object (not noOp) → `runner.hasUI()` returns `true` (runner.js:245 `return this.uiContext !== noOpUIContext`).

### 2. RPC uiContext capabilities

RPC mode bridges (WORK in WebUI via JSON-RPC):
- `select`, `confirm`, `input`, `notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`.

RPC mode does NOT support (no-op or undefined):
- `custom()` → returns `undefined` (rpc-mode.js ~L134: "Custom UI not supported in RPC mode").
- `onTerminalInput()` → returns empty unsubscribe.
- `setWorkingMessage`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setFooter`, `setHeader` → no-op.
- Component factories in `setWidget` → ignored (only string arrays passed through).

### 3. pi-goal-xx adaptation: `isInteractiveTui(ctx)`

`extensions/goal-questionnaire.ts:63-75`:

```typescript
// Check if the extension context is running in interactive TUI mode.
// Uses ctx.mode when available (forward-compatible), falls back to ctx.hasUI.
// In RPC mode, ctx.hasUI lies true but ctx.ui.custom() is a no-op returning undefined.
// Unknown modes fail-safe to non-interactive (never toward ctx.ui.custom).
export function isInteractiveTui(ctx: { hasUI: boolean; mode?: string }): boolean {
  if (ctx.mode !== undefined) return ctx.mode === "interactive";
  // Fallback: when mode is not available, use hasUI (legacy behavior)
  return ctx.hasUI;
}
```

- RPC (`mode: "rpc"`) → `isInteractiveTui` returns `false`.
- Interactive TUI (`mode: "interactive"`) → `true`.

`shouldAutoConfirmProposal` (goal-questionnaire.ts:77-85) follows same logic → proposals auto-confirm in RPC/headless.

## Effect — tool behavior in WebUI (RPC)

| Gate | RPC/WebUI | Affected tools |
|---|---|---|
| `isInteractiveTui(ctx)` → false → **HEADLESS branch** | degrades | `goal_question`, `goal_questionnaire`, `propose_goal_draft`, `propose_task_list`, escape dialog (`widgets/goal-escape-dialog.ts`), task-list overlay (`widgets/task-list-overlay.ts`) |
| raw `ctx.hasUI` → true, calls only RPC-supported methods | **WORKS** | status refresh, widget updates, lock-held notify, goal-list notify, settings menu, resume confirm, focus picker (single-open fast-path) |

Symptom observed 2026-07-16: `goal_question` returned `"Headless mode: the question was recorded, but no interactive UI answer was collected. If the original request is already fully specified, proceed with the documented/default assumption; otherwise ask the user in final text and stop."` — this is the headless branch firing in WebUI. Working as designed.

## Audit — raw `ctx.hasUI` gates in goal.ts (9 sites)

All audited SAFE: each only calls RPC-supported methods (notify / select / confirm / setWidget). No `ctx.ui.custom()` call behind a raw `hasUI` gate.

| line | gate | calls (all RPC-safe) | verdict |
|---|---|---|---|
| 767 | `syncStatusRefresh` `!ctx.hasUI \|\| ...` → stop | stopStatusRefresh | safe |
| 1187 | `updateUI` `!ctx.hasUI` → return | (early return) | safe |
| 1386 | `syncTerminalInputPause` `!ctx.hasUI` → return | terminalInputUnsubscribe | safe (onTerminalInput no-op in RPC anyway) |
| 1920 | lock-held prompt gate | `ctx.ui.notify` | safe |
| 2013 | lock-held headless refuse | `ctx.ui.notify` | safe |
| 2051 | `focusGoalCommand` no-UI fallback | `ctx.ui.notify` | safe |
| 2290 | `handleSettingsMenu` no-UI fallback | `ctx.ui.notify` | safe |
| 4466 | resume single-focus picker | `focusGoalCommand` (uses confirm/select) | safe |
| 4470 | resume-paused confirm | `ctx.ui.confirm` | safe (confirm IS RPC-supported) |

L4470 is the interesting one: uses `ctx.ui.confirm` which RPC bridges → resume-paused dialog is **interactive in WebUI**, unlike the `custom()`-based questionnaire. Confirms the capability split.

## Why this is correct adaptation (not a bug)

- `ctx.ui.custom()` needs a TUI canvas (Ink component). RPC has no canvas — it marshals structured requests over JSON-RPC to a host that renders HTML/canvas, not Ink components.
- There is no way to render an arbitrary Ink render-callback in a browser via RPC. The only RPC-renderable UIs are the primitives the host explicitly bridges (`select`, `confirm`, `input`, `notify`, string-array `setWidget`).
- Falling back to headless auto-confirm / text-based Q&A is the only sound choice. Documented as Lesson-Learned #1 in project AGENTS.md: *"Never gate `ctx.ui.custom()` calls on `ctx.hasUI` — it lies true in RPC mode where `custom()` is a no-op returning undefined."*

## What this means for users (WebUI)

- `/goals`, `/sisyphus` slash intents → still set `confirmationIntent` server-side; work.
- `propose_goal_draft` → auto-confirms in WebUI (no Confirm/Continue dialog rendered). User loses the explicit confirmation gate when driven from WebUI. Mitigation: drive from TUI for human-confirmation flows.
- `goal_question` / `goal_questionnaire` → recorded but no answer collected; agent falls back to documented defaults or asks user in final text.
- `start_goal` (hidden tool, PR #29) → unaffected; pure backend, no UI.
- `/goals-set`, `/sisyphus-set` → unaffected; direct commands.
- confirm/select-based flows (lock-held prompt, resume-paused, single-focus picker) → interactive in WebUI.

## Usage reality (intention shift — 2026-07-16)

goal-xx is **NOT heavily used in TUI anymore**. Observed user patterns:

1. **`/goals-set` directly** — skip `/goals` interview + Confirm dialog. Immediate creation. No questionnaire/draft UI exercised.
2. **Manual goal file creation** — user writes `.pi/goals/active_goal_*.md` JSON by hand (or via agent), then pi-goal-xx picks it up via `loadActiveGoals` + focus policy. Bypasses all goal-creation tools.

Implication: the `custom()`-based interactive flows (`propose_goal_draft`, `goal_questionnaire`, task-list overlay) were already low-traffic. WebUI headless-degradation cost is therefore LOW — these paths weren't the primary user route to begin with.

This weakens the case for any of the open-work options below. The ROI of making questionnaire/draft interactive in WebUI is marginal when users rarely pass through `/goals` interview.

## Open question / future work (NOT actioned now)

If WebUI interactivity for questionnaire/draft/task-list is wanted, options (none implemented). NOTE: see "Usage reality" above — given `/goals-set` + manual-file patterns dominate, ROI of all three is LOW:
1. Re-implement those dialogs using only RPC-bridged primitives (`select` / `confirm` / `input`) — replaces Ink custom components with RPC-native equivalents. Largest effort, biggest UX gain. **Low ROI per usage reality.**
2. Add a WebUI-side `custom()` bridge that renders structured JSON-RPC dialog requests in the browser — requires host-side work in pi-coding-agent or the WebUI frontend, not pi-goal-xx.
3. Accept headless auto-confirm in WebUI as the documented contract; steer users to TUI for confirmation-sensitive flows. **Current de-facto state — aligns with actual usage.**

## References (remote)

- pi-coding-agent RPC mode: https://github.com/earendil-works/pi-coding-agent (see `src/modes/rpc/rpc-mode.ts`)
- pi-goal-xx questionnaire: https://github.com/buihongduc132/pi-goal-xx/blob/main/extensions/goal-questionnaire.ts
- Lesson-Learned #1 (this finding's source): project AGENTS.md

## Lesson-Learned #1 (already in AGENTS.md — recapped)

Never gate `ctx.ui.custom()` calls on `ctx.hasUI` — it lies true in RPC mode (WebUI) where `custom()` is a no-op returning `undefined`. Gate on `isInteractiveTui(ctx)` (checks `ctx.mode === "interactive"`), not `ctx.hasUI`. Add safety net for undefined return from `ctx.ui.custom()`.

Context: `propose_goal_draft` and all custom-dialog tools crashed in Web UI/RPC mode with TypeError on `undefined.cancelled`.
Solution: `isInteractiveTui(ctx)` + safety net.
Ref: `flow/bugs/2026-07-07_propose-goal-draft-rpc-crash.md`
