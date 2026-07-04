{
  "version": 3,
  "id": "mr6bxkgt-u59zka",
  "objective": "Implement the `goal-focus-picker-ux` openspec change: rewrite the `/goal-focus` picker and `/goal-list` text view so each row shows a short human ID (collision-guarded), a single compact status pill, absolute + relative timestamps, a sanitized objective title, a lock-owner pill, and deterministic ordering — with no duplicated columns and no per-row filename noise.\n\nSuccess criteria:\n- All 24 checkboxes in `openspec/changes/goal-focus-picker-ux/tasks.md` complete.\n- `openspec validate goal-focus-picker-ux` passes.\n- `npm run build` clean (tsc, 0 errors).\n- `npm test` green (0 failures).\n- New + existing picker/label tests green; coverage of touched files (`goal-core.ts`, `goal-pool.ts`, picker path in `goal.ts`) ≥ 80%.\n- Manual verification: 3-goal fixture (1 running, 1 sisyphus paused, 1 held by a second session) renders correctly in `/goal-focus` and `/goal-list`; collision-fallback selection maps to the correct goal.\n\nBoundaries:\n- IN: helpers (1.1–1.5), picker label builder (2.x), lock pill (3.x), picker wiring (4.x), tests (5.x), verification (6.x) per tasks.md.\n- OUT: GoalRecord schema change, focus-lock protocol change, persistence/migration, replacing `ctx.ui.select` with a richer widget, migrating non-picker `statusLabel` consumers (footer widget / auditor) — follow-up only.\n\nConstraints:\n- MUST use team delegation (teams tool) — NOT fork mode, NOT ACP, NOT intercom for the work. contextMode=fresh, workspaceMode=shared.\n- MUST achieve ≥80% test coverage on touched files.\n- MUST NOT call pause_goal / block / ask the user a question mid-work. If a blocker appears, delegate a sub-agent (comrade) to resolve it and continue.\n- MUST obtain an APPROVAL verdict from the verifier loop (jewilo CLI primary; manual orchestrator fallback only if jewilo broken) BEFORE calling complete_goal. No exceptions.\n- Selection correctness preserved: short-ID collision MUST fall back to full id and the `byLabel` map MUST key on the full rendered label.\n\nVerification contract:\nBefore complete_goal, provide evidence: (1) `openspec validate goal-focus-picker-ux` output, (2) `npm run build` log (0 errors), (3) `npm test` summary (0 failures + coverage % for touched files), (4) task list with all 24 boxes checked, (5) verifier-loop APPROVAL verdict, (6) the 3-goal manual fixture screenshot/render output.\n\nIf blocked: do not pause or ask the user — delegate a comrade to investigate and resolve, then continue. Only escalate to the user if delegation also fails (then stop and report).",
  "status": "active",
  "autoContinue": true,
  "usage": {
    "tokensUsed": 156171,
    "activeSeconds": 2183
  },
  "sisyphus": false,
  "createdAt": "2026-07-04T12:19:32.189Z",
  "updatedAt": "2026-07-04T12:56:41.679Z",
  "activePath": ".pi/goals/active_goal_2026070419193218_mr6bxkgt-u59zka.md",
  "taskList": {
    "tasks": [
      {
        "id": "t1-helpers",
        "title": "Helpers: shortGoalId, formatRelativeTime, formatAbsoluteShort, sanitize displayObjectiveTitle, compactStatusLabel",
        "status": "complete",
        "completedAt": "2026-07-04T12:21:43.403Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t1-1",
            "title": "shortGoalId(id): substring after final '-'; pure",
            "status": "pending"
          },
          {
            "id": "t1-2",
            "title": "formatRelativeTime(iso): just now / Xm / Xh / Xd ago / — / future clamp",
            "status": "pending"
          },
          {
            "id": "t1-3",
            "title": "formatAbsoluteShort(iso): local MM-DD HH:mm, — on invalid",
            "status": "pending"
          },
          {
            "id": "t1-4",
            "title": "displayObjectiveTitle: strip leading ``` / > / quotes",
            "status": "pending"
          },
          {
            "id": "t1-5",
            "title": "compactStatusLabel(goal): running | paused·agent | paused | drafting",
            "status": "pending"
          }
        ]
      },
      {
        "id": "t2-label-builder",
        "title": "Picker label builder (goal-pool.ts): collision-guarded short IDs, rewritten goalSelectorLabel, buildGoalListText, sortGoalsForPicker",
        "status": "complete",
        "completedAt": "2026-07-04T12:30:34.759Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t2-1",
            "title": "resolveShortIdsForPool: collision fallback to full id",
            "status": "pending"
          },
          {
            "id": "t2-2",
            "title": "Rewrite goalSelectorLabel: glyph+shortId | compactStatus | abs·rel | title | lockPill; no activePath",
            "status": "pending"
          },
          {
            "id": "t2-3",
            "title": "buildGoalListText: share formatter, keep path sub-line, add legend",
            "status": "pending"
          },
          {
            "id": "t2-4",
            "title": "sortGoalsForPicker: running first, then updatedAt desc (stable)",
            "status": "pending"
          }
        ]
      },
      {
        "id": "t3-lock-pill",
        "title": "Lock-owner pill (goal.ts): precompute heldByOther, shortSessionId, keep confirmFocusOverride unchanged",
        "status": "complete",
        "completedAt": "2026-07-04T12:30:34.768Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t3-1",
            "title": "focusGoalCommand: precompute heldByOther per open goal",
            "status": "pending"
          },
          {
            "id": "t3-2",
            "title": "shortSessionId with collision fallback",
            "status": "pending"
          },
          {
            "id": "t3-3",
            "title": "confirmFocusOverride post-selection flow unchanged",
            "status": "pending"
          }
        ]
      },
      {
        "id": "t4-wiring",
        "title": "Picker wiring (goal.ts): byLabel on full label, title with count, sort applied, single-open + headless share formatter",
        "status": "complete",
        "completedAt": "2026-07-04T12:30:47.317Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t4-1",
            "title": "byLabel map keyed on full rendered label",
            "status": "pending"
          },
          {
            "id": "t4-2",
            "title": "ctx.ui.select title: 'Focus open goal · N open'",
            "status": "pending"
          },
          {
            "id": "t4-3",
            "title": "Apply sortGoalsForPicker before building labels",
            "status": "pending"
          },
          {
            "id": "t4-4",
            "title": "Single-open fast-path + headless path share formatter",
            "status": "pending"
          }
        ]
      },
      {
        "id": "t5-tests",
        "title": "Tests for shortGoalId, formatRelativeTime, displayObjectiveTitle, goalSelectorLabel snapshot, buildGoalListText, sortGoalsForPicker, collision selection-mapping",
        "status": "complete",
        "completedAt": "2026-07-04T12:54:25.801Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t5-1",
            "title": "shortGoalId: typical, no-dash, collision set",
            "status": "pending"
          },
          {
            "id": "t5-2",
            "title": "formatRelativeTime: 30s, 2h, 3d, future clamp, invalid",
            "status": "pending"
          },
          {
            "id": "t5-3",
            "title": "displayObjectiveTitle: fence, blockquote, quote, normal prose",
            "status": "pending"
          },
          {
            "id": "t5-4",
            "title": "goalSelectorLabel snapshot: running, paused·agent, held-by-other, collision fallback",
            "status": "pending"
          },
          {
            "id": "t5-5",
            "title": "buildGoalListText: legend + path sub-line",
            "status": "pending"
          },
          {
            "id": "t5-6",
            "title": "sortGoalsForPicker: running-first + recency",
            "status": "pending"
          },
          {
            "id": "t5-7",
            "title": "Selection-mapping: two colliding-suffix goals resolve to distinct ids via full-label byLabel",
            "status": "pending"
          }
        ]
      },
      {
        "id": "t6-verify",
        "title": "Verification: build clean, tests green, manual 3-goal fixture render, collision selection correct, openspec validate",
        "status": "complete",
        "completedAt": "2026-07-04T12:56:41.429Z",
        "lightweightSubtasks": true,
        "subtasks": [
          {
            "id": "t6-1",
            "title": "npm run build clean (tsc)",
            "status": "complete",
            "completedAt": "2026-07-04T12:56:23.726Z"
          },
          {
            "id": "t6-2",
            "title": "npm test green",
            "status": "complete",
            "completedAt": "2026-07-04T12:56:25.224Z"
          },
          {
            "id": "t6-3",
            "title": "Manual 3-goal fixture: /goal-focus + /goal-list render",
            "status": "complete",
            "completedAt": "2026-07-04T12:56:31.578Z"
          },
          {
            "id": "t6-4",
            "title": "Manual: collision-fallback goal focuses correctly",
            "status": "complete",
            "completedAt": "2026-07-04T12:56:31.620Z"
          }
        ]
      }
    ],
    "blockCompletion": false,
    "proposedAt": "2026-07-04T12:19:32.201Z"
  }
}

# Goal Prompt

Implement the `goal-focus-picker-ux` openspec change: rewrite the `/goal-focus` picker and `/goal-list` text view so each row shows a short human ID (collision-guarded), a single compact status pill, absolute + relative timestamps, a sanitized objective title, a lock-owner pill, and deterministic ordering — with no duplicated columns and no per-row filename noise.

Success criteria:
- All 24 checkboxes in `openspec/changes/goal-focus-picker-ux/tasks.md` complete.
- `openspec validate goal-focus-picker-ux` passes.
- `npm run build` clean (tsc, 0 errors).
- `npm test` green (0 failures).
- New + existing picker/label tests green; coverage of touched files (`goal-core.ts`, `goal-pool.ts`, picker path in `goal.ts`) ≥ 80%.
- Manual verification: 3-goal fixture (1 running, 1 sisyphus paused, 1 held by a second session) renders correctly in `/goal-focus` and `/goal-list`; collision-fallback selection maps to the correct goal.

Boundaries:
- IN: helpers (1.1–1.5), picker label builder (2.x), lock pill (3.x), picker wiring (4.x), tests (5.x), verification (6.x) per tasks.md.
- OUT: GoalRecord schema change, focus-lock protocol change, persistence/migration, replacing `ctx.ui.select` with a richer widget, migrating non-picker `statusLabel` consumers (footer widget / auditor) — follow-up only.

Constraints:
- MUST use team delegation (teams tool) — NOT fork mode, NOT ACP, NOT intercom for the work. contextMode=fresh, workspaceMode=shared.
- MUST achieve ≥80% test coverage on touched files.
- MUST NOT call pause_goal / block / ask the user a question mid-work. If a blocker appears, delegate a sub-agent (comrade) to resolve it and continue.
- MUST obtain an APPROVAL verdict from the verifier loop (jewilo CLI primary; manual orchestrator fallback only if jewilo broken) BEFORE calling complete_goal. No exceptions.
- Selection correctness preserved: short-ID collision MUST fall back to full id and the `byLabel` map MUST key on the full rendered label.

Verification contract:
Before complete_goal, provide evidence: (1) `openspec validate goal-focus-picker-ux` output, (2) `npm run build` log (0 errors), (3) `npm test` summary (0 failures + coverage % for touched files), (4) task list with all 24 boxes checked, (5) verifier-loop APPROVAL verdict, (6) the 3-goal manual fixture screenshot/render output.

If blocked: do not pause or ask the user — delegate a comrade to investigate and resolve, then continue. Only escalate to the user if delegation also fails (then stop and report).

## Progress

- Status: running
- Auto-continue: on
- Sisyphus mode: no
- Time spent: 36m23s
- Tokens used: 156K (156,171) tokens
## Tasks

<!-- blockCompletion: false -->
- [x] t1-helpers: Helpers: shortGoalId, formatRelativeTime, formatAbsoluteShort, sanitize displayObjectiveTitle, compactStatusLabel
- [x] t2-label-builder: Picker label builder (goal-pool.ts): collision-guarded short IDs, rewritten goalSelectorLabel, buildGoalListText, sortGoalsForPicker
- [x] t3-lock-pill: Lock-owner pill (goal.ts): precompute heldByOther, shortSessionId, keep confirmFocusOverride unchanged
- [x] t4-wiring: Picker wiring (goal.ts): byLabel on full label, title with count, sort applied, single-open + headless share formatter
- [x] t5-tests: Tests for shortGoalId, formatRelativeTime, displayObjectiveTitle, goalSelectorLabel snapshot, buildGoalListText, sortGoalsForPicker, collision selection-mapping
- [x] t6-verify: Verification: build clean, tests green, manual 3-goal fixture render, collision selection correct, openspec validate

