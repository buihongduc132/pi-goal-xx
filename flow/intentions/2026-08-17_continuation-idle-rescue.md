# Continuation idle rescue — user intention

## User words (verbatim)

> --- problem: - agent usually answer premature and stop working on the goal; previously we keep injecting the message every turn , but we have the feature that to dedup / debounce it ; But seems like that feature mostly / completely disable the injecting to make new turn while the agent not yet completed; --- could we: - check message send , then if it session_idle (goal !completed) , if it 30s passed by and no new turn , then send the injected message to keep it running ? - injected message will be configurable , using jinja template , could be rotate in the pool of message instead of fixed ?

> - last send < 10 mins -> put to queue. setTimeout (next to be rescue time , check: currentTime - lastMessageTime = 30s && idling => send);
> - 1 in queue , drop the rest; Also , either it is 30s or 10 mins , the amount of send is 1 message ;
>
> ---
>
> Discard the rotation for now , we will do it later ;

---

## Elaboration (5-line intention summary, user-approved)

1. Goal must run itself to completion — no human babysitting stalled sessions.
2. Agent answers prematurely → injection was added to force continuation.
3. Injecting every turn = spam → throttle bounded it to 1 per 10 min.
4. Throttle killed the only turn-driver (deadlock) → need idle rescue: 30s stall → send.
5. Essence: **liveness always guaranteed + send rate always ≤1 per window** — neither sacrificed for the other.

## Design shape agreed (exploration session 2026-08-17)

- Single-slot continuation queue; drop rest when slot occupied.
- On cooldown drop: KEEP slot armed, one timer `fireAt = min(lastAgentActivity + 30s, lastSendAt + 10min)`.
- Fire → send 1 message; BOTH paths stamp `lastSendAt` → 1-send invariant.
- Rescue fires only when idle + no pending msgs; else re-arm.
- Surface: `goalContinuation.idleRescueMs` (default 30000, 0 = disable) + env `PI_GOAL_CONTINUATION_IDLE_RESCUE_MS`.
- Root cause of current deadlock: `sendQueuedContinuation` cooldown-drop path returns without rescheduling (one-shot pipeline, continuation IS the turn driver).
- Message rotation pool: DEFERRED by user — later work.
