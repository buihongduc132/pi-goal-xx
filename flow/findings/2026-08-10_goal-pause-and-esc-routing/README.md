# Goal Pause and Esc Routing

> Date range: 2026-08-10 → 2026-08-10
> Status: done

## Topics

### goal-pause-and-esc-routing (2026-08-10)
Explored why pi-goal-xx goals silently paused between turns ("Queued checkpoint is stale"). Root cause: 3 abort-detection sites in `extensions/goal.ts` conflated runtime aborts with user Esc → pauseActiveGoal fired with hardcoded reason "user". Fixed by: (1) removing abort-pause path entirely (commit 07a6487), (2) adding configurable per-reason pause with distinct logging (commit 8c2de8c), (3) fixing Esc routing so escape=false lets pi handle Esc natively instead of swallowing it (commit d7fd46a). All deployed to dev/staging/prod. Open: infinite-loop risk if runtime hard-aborts every turn (no backoff added per user request).

## Pick up next time
1. `2026-08-10-turn1-symptom-stale-checkpoint.md` — symptom + Mode A troubleshoot
2. `2026-08-10-turn3-abort-tolerant-fix.md` — the core fix (abort-pause removal)
3. `2026-08-10-turn12-esc-routing-bug.md` — Esc swallow bug discovery + fix
4. `2026-08-10-locked-decisions.yaml` — what user locked
5. `2026-08-10-open-threads.yaml` — what remains open (infinite-loop risk)
