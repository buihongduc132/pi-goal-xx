## ADDED Requirements

### Requirement: Process-identity verification for PID liveness
The system SHALL record the owning process's start time (`startTimeMs`) in the lock file at acquisition time. On liveness check, the system SHALL verify that the process currently occupying the recorded PID has a matching start time. If the start time does not match (the original process died and the PID was recycled to an unrelated process), the process is NOT the lock owner, regardless of `process.kill(pid, 0)` succeeding.

#### Scenario: PID recycled to unrelated process
- **WHEN** a lock's recorded PID is now held by a different process (start time mismatch) but `process.kill(pid, 0)` succeeds
- **THEN** the liveness check returns DEAD (the original owner is gone) and the lock is STALE

#### Scenario: Start time matches
- **WHEN** the process at the recorded PID has a start time equal to the recorded `startTimeMs`
- **THEN** the liveness check returns ALIVE (the original owner still runs)

#### Scenario: Lock written without startTimeMs (legacy)
- **WHEN** a lock file lacks `startTimeMs` (written by an older session before this change)
- **THEN** the system falls back to PID-existence-only check (current behavior) — no false-negative for in-flight legacy locks, no breaking change

### Requirement: Cross-platform start-time resolution
The system SHALL resolve process start time via the platform-appropriate mechanism: on Linux, read `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot, converted to ms via `CLK_TCK` and boot time); on macOS, invoke `ps -p <pid> -o lstart` and parse the timestamp; on unsupported platforms or when resolution fails, return `null` and fall back to PID-existence-only check (fail-open, never crash the host on a liveness probe).

#### Scenario: Linux start-time via /proc
- **WHEN** the platform is Linux and `/proc/<pid>/stat` is readable
- **THEN** the system reads field 22, converts to epoch ms, and returns it for comparison

#### Scenario: Resolution failure is non-fatal
- **WHEN** start-time resolution throws (permission denied, unsupported platform, malformed /proc)
- **THEN** the liveness check returns `null` for start time and falls back to PID-existence check, logging a warning — the host MUST NOT crash
