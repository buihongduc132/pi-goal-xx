## Context

The goal focus lock (`extensions/goal-lock.ts`) uses two-signal liveness: PID existence (`process.kill(pid, 0)`) + lease freshness (`now < expiresAt`, 3min default, 1min heartbeat). This is documented in `openspec/specs/goal-focus-locking/` and the design history in `flow/findings/goal-focus-collision/`.

**The gap:** `process.kill(pid, 0)` reports PID *existence*, not *identity*. When the owning pi dies and the OS recycles that PID (common under systemd/pm2/shell job churn) within the 3-min lease, both signals falsely agree "held" → `isLockHeld` returns true → the lock sits on disk. Worse, `reapStaleLock` only runs from `acquireLock` (the acquisition path), so when no other session attempts acquisition, the stale lock persists indefinitely and `computeHeldByOther` keeps reporting "held by session X" in the picker/list. In the pi-web UI, this surfaces as a persistent blocking "take over" popup on every auto-focus/resume attempt (bug cascade).

Full investigation: `flow/findings/2026-07-07_stale-lock-and-web-popup-bugs.md`.

## Goals / Non-Goals

**Goals:**
- Close the false-held window: a recycled PID must NOT keep a lock held, even within the lease window.
- Clear stale locks without requiring an acquisition attempt (reap-on-read).
- Backward compatibility with legacy lock files lacking the new identity field.
- No host crashes from the new platform-specific start-time probe (fail-open).

**Non-Goals:**
- Reducing the lease window or heartbeat interval (3min/1min unchanged).
- Fixing the pi-web frontend popup RPC behavior directly (bug #2 H3) — the popup path (`confirmFocusOverride`) is already correct; it was firing because the lock was falsely held. Fixing bug #1 resolves the cascade.
- Distributed/cluster-wide lock ownership (single-host PID checks remain).
- PID-based liveness for non-goal locks (scope: goal focus lock only).

## Decisions

**D1 — Start-time as the identity signal (not a nonce file or cmdline match).**
Start time is derivable cross-platform without holding open file descriptors or matching cmdlines (fragile — pi cmdlines vary). Start time uniquely identifies a process incarnation on a host within practical timeframes. Stored as `startTimeMs: number | null` on `GoalFocusLock.owner`.

**D2 — Linux: `/proc/<pid>/stat` field 22; macOS: `ps -p <pid> -o lstart`; else `null`.**
Linux `/proc` is a direct read (no subprocess). macOS lacks `/proc`; `ps -o lstart` is the stable POSIX-ish path. Unsupported platforms (Windows/BSD) return `null` → fallback to PID-only (current behavior), no regression.

**D3 — Conversion: starttime ticks → epoch ms via boot time + `CLK_TCK`.**
Linux `/proc/<pid>/stat` field 22 is clock ticks since boot. Convert: `bootMs + (ticks / CLK_TCK) * 1000`. Boot time read once from `/proc/stat` `btime` line (cached; refreshed on cache miss). `CLK_TCK` = `100` on virtually all Linux (from `sysconf(_SC_CLK_TCK)`, but Node has no direct API — hardcode 100 with a note; field is stable).

**D4 — Legacy fallback: `startTimeMs` absent → PID-existence only.**
Locks written by pre-change sessions lack the field. The check: `if (lock.owner.startTimeMs == null) return pidAlive(pid);` — identical to current behavior. No false-negative for in-flight locks during rollout. New acquisitions always write `startTimeMs`.

**D5 — Reap-on-read added to `computeHeldByOther` and `confirmFocusOverride`.**
Both currently read-but-not-reap (by design — `computeHeldByOther` comment at goal.ts:1760 says "pure read; does not reap or release"). This decision REVERSES that for stale locks only: reap STALE locks on read, never reap HELD ones. The TOCTOU guard in `reapStaleLock` (re-read before unlink) already protects against the race where another session acquired between read and unlink.

**D6 — Keep reap fail-open and non-throwing.**
All reap/identity operations wrap in try/catch; errors log a warning and fall back to the most conservative behavior (treat as held if unsure — never crash the host, never steal a live lock).

## Risks / Trade-offs

**R1 — `/proc` read permission.** On hardened systems, `/proc/<pid>/stat` may be restricted (hidepid). Mitigation: ENOENT/EACCES → return `null` → fallback to PID-only (D4). Acceptable: a hardened host keeps current behavior, no regression.

**R2 — Boot-time cache staleness across host reboot.** If boot time is cached and the host reboots, start times reset. Mitigation: boot time is re-read from `/proc/stat` each call (cheap, ~1 syscall) or cached with a short TTL. Since locks don't survive host reboot anyway (PID space resets), a stale boot cache only matters within a single boot — and `/proc/stat` `btime` is constant within a boot, so caching per-process-lifetime is safe.

**R3 — Clock skew between lock-write and liveness-read.** Negligible — both use the same host clock, same epoch base. No NTP jump affects `startTimeMs` comparison (it's a process-relative value, not wall-clock arithmetic on `now`).

**R4 — macOS `ps` subprocess cost.** ~5-10ms per probe, called on picker/list render. Mitigation: only probe on read paths that already iterate locks (no new hot-path probes); acceptable latency for a UI-facing operation.

**R5 — Reap-on-read changes `computeHeldByOther`'s "pure read" contract.** Existing callers/tests may assume no side effects. Mitigation: the side effect (unlinking a STALE lock) is idempotent and desirable; update tests to assert reap happens. Documented in the MODIFIED spec requirement.
