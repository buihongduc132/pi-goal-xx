# 5: Design published on wrong stack — no fact-lock before architecture artifacts

## Context
Session designed a full Go BE architecture (posted to ticket as design v2) for a system explicitly "based on jewilo, not reimplementing". jewilo (../verifier-loop) had ALREADY been verified Rust earlier in the same session (Cargo.toml read, turn 1). The contradiction (new Go BE vs extend Rust jewilo) was never surfaced; user caught it one turn later → full v3 redesign, 2 superseded artifacts in ticket.

Failure mode: user-stated constraint accepted as design input WITHOUT reconciling against already-established facts in session context.

## Solutions
FACT-LOCK ritual before publishing ANY architecture/design artifact:
1. List every dependency the design touches.
2. For each: re-verify language/runtime/interface from session evidence or repo (1 `head Cargo.toml | package.json` each).
3. List user constraints QUOTED verbatim.
4. Any contradiction between (2) and (3) → surface to user BEFORE designing, not after.

Cost ≈ 2 min. Kills the "designed on wrong assumption, user catches it" flipflop class.

## Ref
BHD-283 comments v2 (Go, superseded) vs v3 (Rust-extends-jewilo).
