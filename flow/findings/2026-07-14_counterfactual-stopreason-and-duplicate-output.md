# Counterfactual — stopReason state machine & duplicate audit-output anomaly

Date: 2026-07-14
Task: #3 (state-counterfactual)
Repo: `/home/bhd/Documents/Projects/bhd/pi-goal-xx`
Scope: **evidence-only. No code edits. No `complete_goal` calls.**

---

## Thread A — stopReason state machine counterfactual

### Question

> "If the approved path set `stopReason` to `undefined` (or a dedicated `completed`
> value) instead of `\"agent\"`, what would break?"

### Type definition

- `extensions/goal-record.ts:2` — `export type StopReason = "user" | "agent";`
- `extensions/goal-core.ts:12` — display-record mirror: `stopReason?: "user" | "agent"`
- `extensions/goal-record.ts:248` — **normalizer is the only coercion gate**:
  `stopReason: raw.stopReason === "agent" || raw.stopReason === "user" ? raw.stopReason : undefined`
  → any other value (e.g. a hypothetical `"completed"`) is silently coerced to
  `undefined` on load. A dedicated `"completed"` value would require touching this line.

### Every SET site

| File:line | Value | Context |
|---|---|---|
| `extensions/goal-policy.ts:92` | `"agent"` | `buildPausedByAgentGoal` — pauses goal |
| `extensions/goal-policy.ts:107` | `"agent"` | `buildAbortedByAgentGoal` — aborts goal |
| `extensions/goal.ts:2147` | `undefined` | new goal created |
| `extensions/goal.ts:3259` | `"agent"` | **complete path — auditor disabled per-goal** |
| `extensions/goal.ts:3342` | `"agent"` | **complete path — auditor disabled in settings** |
| `extensions/goal.ts:3519` | `"agent"` | **complete path — user-bypassed auditor** |
| `extensions/goal.ts:3635` | `"agent"` | **complete path — auditor APPROVED** |
| `extensions/goal.ts:1321` | `reason` (param) | `archiveCurrentGoal` passthrough |
| `extensions/goal.ts:1328` | `reason` (param) | `stopActiveGoal` passthrough |
| `extensions/goal.ts:4446` | `undefined` | resume — clears stop/pause state |

**Observation**: the four complete-path sites (3259/3342/3519/3635) reuse the
literal `"agent"` that the paused/aborted paths (policy.ts:92/107) also use. The
**same value encodes two different facts** — "agent paused/aborted this" vs
"agent completed this" — disambiguated only by the separate `status` field.

### Every READ site (consumers)

| File:line | Check | Guarded by `status === "paused"`? |
|---|---|---|
| `extensions/goal-core.ts:111` | `stopReason === "agent"` (compactStatusLabel → "paused·agent") | ✅ yes |
| `extensions/goal-core.ts:171` | `stopReason === "agent"` (statusLabel → "paused (agent)") | ✅ yes |
| `extensions/widgets/goal-widget.ts:81` | `stopReason === "agent"` (icon ⊘/blocked) | ✅ yes (`if paused`) |
| `extensions/widgets/goal-widget.ts:270` | `stopReason === "agent"` (blocker line) | ✅ yes (`if paused &&`) |
| `extensions/goal.ts:4564` | `stopReason === "agent"` (paused system-prompt extras) | ✅ yes — only inside the `status === "paused"` branch; complete goals early-return at `goal.ts:4562` |
| `extensions/widgets/goal-widget.ts:338` | truthy `goal.stopReason` (display line) | ❌ no — fires for ANY status |
| `extensions/goal.ts:299` | truthy `goal.stopReason` ("Stop reason: X") | ❌ no — fires for ANY status |

### ⚠️ Distinguish two unrelated `stopReason` fields

`extensions/goal.ts:426` and `:431` read `raw.stopReason` but on
`AssistantMessageLike` (`goal-record.ts:89`), values `"aborted"` / `"toolUse"`.
These are **assistant-message stream stop reasons**, NOT goal stop reasons.
The `"agent"` literal never appears here. Do not conflate when auditing.

### Counterfactual analysis

**Consumers keyed on `=== "agent"` (5 sites)** — every one is gated behind
`status === "paused"`. A goal that transitioned to `complete` never reaches
them. Setting stopReason to `undefined` on the complete path → **zero behavioral
change** for these.

**Consumers keyed on truthy stopReason (2 sites)** —
- `goal-widget.ts:338` would simply not print the `stopReason: agent` line for a
  completed goal.
- `goal.ts:299` would not append `Stop reason: agent` to goal details.

Both effects are **cosmetic only**, and arguably *more correct*: today a
completed goal shows "Stop reason: agent", which carries no information (the
goal isn't stopped, it's done). Removing it declutters output.

**Verdict — Thread A**: NOTHING breaks if the four complete-path SET sites use
`undefined` instead of `"agent"`. The current reuse is a latent semantic
overload: the same enum value means "paused-by-agent" *and* "completed-by-agent",
kept consistent only because every reader is status-guarded. A dedicated
`"completed"` value (or `undefined`) is safe; the **only required code change**
for a dedicated value would be the normalizer at `goal-record.ts:248` (else it
silently coerces to `undefined` on reload — which, ironically, is exactly the
counterfactual outcome and is harmless).

No HIGH-risk coupling found. Refactor is low-risk but not urgent — it is a
hygiene improvement, not a bug fix.

---

## Thread B — Duplicate audit-output anomaly

### Evidence (`.pi/goals/auditor-trace.jsonl`, last line — goal `mrk8g5ta-e7x8os`)

The final `"phase":"end"` entry's `outputPreview` contains the **entire audit
report twice**, including the `<approved/>` marker appearing **two times**.

- `outputBytes: 5936` (≈ 2× a normal report).
- First copy ends `…verification list).\n\n<approved/>`, then a blank line, then
  the **same** report verbatim ending again with `<approved/>`.
- Model: `bhd-litellm/role-smart`.

### Control evidence — duplication is NOT universal

Inspecting `.pi/goals/goal_events.jsonl` `"type":"audit_result"` entries:

- Line 4 — goal `mr509kw5-byveuz`, verdict `approved` → report appears **once**,
  single `<approved/>`.
- Line 22 — goal `mr5cf6ch-akrg4u`, verdict `disapproved` → report **once**,
  single `<disapproved/>`.
- Line 68 — goal `mrk8g5ta-e7x8os`, verdict `approved` → report **TWICE**, two
  `<approved/>`.

So the duplication is **conditional on provider/streaming behavior**, not a
deterministic logic error.

### Root cause — double-capture in the stream handler

`extensions/goal-auditor.ts` accumulates auditor text into `outputParts: string[]`
(`:466`) and joins once at the end (`:1118` → `outputParts.join("\n\n").trim()`).
There are **two** `outputParts.push` sites that can both fire for the same text:

1. **`:896`** — inside `message_update` handler, on `streamEvent?.type === "text_end"`:
   ```ts
   const textContent = streamEvent.content ?? streamEvent?.partial?.content?.[0]?.text;
   if (typeof textContent === "string" && textContent.trim()) {
       outputParts.push(textContent);
   }
   ```
   The inline comment at `:890-893` explains why this exists:
   *"pi-core can drop text content from the finalized message at message_end"*.

2. **`:918`** — inside `message_end` handler, final assistant message:
   ```ts
   for (const part of message.content ?? []) {
       if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
   }
   ```

When the provider **emits a streaming `text_end` event AND keeps the text in the
finalized `message_end` payload**, both sites push the **same** text → the
`"\n\n"`-joined `output` contains the report twice. This is exactly the
`bhd-litellm/role-smart` behavior. For providers where pi-core *does* drop the
text at `message_end` (the case the `:890` comment anticipates), only site 1
fires → single copy (as seen for `mr509kw5` / `mr5cf6ch`).

**The exact join**: `extensions/goal-auditor.ts:1118` —
`const output = outputParts.join("\n\n").trim();`

### Counterfactual: "If the parser concatenated output + verdict twice…"

The `<approved/>` parser does **not** duplicate:

`extensions/goal-auditor.ts:121-125`
```ts
export function parseAuditorDecision(output: string) {
  const approved = /<approved\s*\/>/.test(output);
  const disapproved = /<disapproved\s*\/>/.test(output);
  return { approved: approved && !disapproved, disapproved };
}
```

It is a boolean regex `.test()` — invariant under marker count. Two
`<approved/>` markers produce the same `approved:true` as one. **The parser is
not the source of duplication.** The duplication is upstream, in `outputParts`
double-accumulation, before the parser ever sees the string.

### Does the duplication leak to user-facing text? — YES, not cosmetic

`auditor.output` (the duplicated string) is consumed in **five** places in
`complete_goal.execute`, none of which deduplicate:

| File:line | Use | User-visible? | Persisted? |
|---|---|---|---|
| `extensions/goal.ts:3561-3562` | `auditProgress.recentOutput` (first 8 lines, transient widget) | yes (transient) | no |
| `extensions/goal.ts:3578` | `appendGoalEvent({type:"audit_result", report: auditor.output})` | no | **yes — `.pi/goals/goal_events.jsonl`** |
| `extensions/goal.ts:3596` | `rejectionText` → `pi.sendMessage(GOAL_AUDIT_ENTRY, display:true)` + tool `content` | **yes** | via sendMessage log |
| `extensions/goal.ts:3615` | `approvalText` → `pi.sendMessage(GOAL_AUDIT_ENTRY, phase:"approved", display:true)` | **yes (this goal's path)** | via sendMessage log |
| `extensions/goal.ts:3660` | `buildCompletionReport({auditorReport: auditor.output})` → tool `content`, `terminate:true` | **yes — final tool result** | in session log |

**Confirmed on disk**: `.pi/goals/goal_events.jsonl:68` (the `audit_result` for
`mrk8g5ta-e7x8os`) `report` field contains the duplicated text with two
`<approved/>` markers. So the duplication **has leaked into the durable ledger**.
The `approvalText` (goal.ts:3611) for this goal would have shown the duplicated
report to the user, and `buildCompletionReport` (3660) would have emitted the
duplicated report as the terminating tool result.

### Severity

- **Functional**: LOW. `parseAuditorDecision` is count-invariant, so the verdict
  is correct. The duplication does not flip approve↔disapprove.
- **Cosmetic / data-quality**: MEDIUM-HIGH. It (a) doubles the displayed auditor
  report in the TUI and final tool result, (b) doubles the persisted ledger
  entry (audit_result.report), inflating token usage on any downstream read
  (e.g. the paused-goal `[AUDITOR REJECTION]` injection at `goal.ts:4570-4574`
  slices `report.slice(0,300)` so it's bounded there, but `buildCompletionReport`
  emits the full thing).
- **Trigger**: provider-dependent — fires whenever a provider streams `text_end`
  *and* retains text in `message_end`. The defensive `text_end` capture was
  added precisely because *some* providers drop text at `message_end`; the bug
  is the missing guard against the *opposite* case (both present).

### Suggested fix locus (NOT applied — evidence-only)

One of, at `extensions/goal-auditor.ts`:
1. Track a flag when `text_end` has already captured text for the current
   assistant turn; skip the `message_end` text capture (`:918`) if the flag is
   set. (Matches the `:890` comment's intent — `text_end` is authoritative when
   present.)
2. Or, prefer whichever source produced content: if `outputParts` is non-empty
   *after* the streaming phase, ignore `message_end` text parts entirely.
3. Or, deduplicate adjacent-equal entries before the `:1118` join.

Option 1 is the most surgical and preserves the existing fallback semantics
(when `text_end` never fires, `message_end` is still the source of truth).

---

## Summary

| Thread | Verdict |
|---|---|
| A — stopReason counterfactual | **Nothing breaks.** All `=== "agent"` readers are `status==="paused"`-guarded. Only `goal-record.ts:248` normalizer would need updating for a dedicated `"completed"` value (else coerced to `undefined`, which is itself the harmless counterfactual). Current code is a latent semantic overload, not a bug. |
| B — duplicate audit output | **Real bug, provider-conditional.** Root cause is double-capture at `goal-auditor.ts:896` (`text_end`) + `:918` (`message_end`), joined at `:1118`. The `<approved/>` parser is NOT the cause (count-invariant regex). Duplication **does** leak to user-facing `approvalText` (`goal.ts:3615`), the final completion report (`goal.ts:3660`), and the durable ledger (`goal_events.jsonl:68` has two `<approved/>`). Functional verdict unaffected; data quality degraded. |
