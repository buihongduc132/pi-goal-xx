#!/bin/bash
# tests/pi-goal-wrapper.test.sh — passthrough guarantees for pi-goal wrapper
#
# Verifies pi-goal is a clean passthrough of pi with only 3 env vars added.
#
# Tests:
#   1. stdout passthrough (--version) — byte-identical to `pi`
#   2. stderr passthrough (invalid flag) — byte-identical to `pi`
#   3. exit code passthrough — same exit code as `pi`
#   4. arg passthrough (--help) — identical first lines
#   5. env vars propagate — PI_GOAL_ENABLE* reach child process
#   6. no output swallowing (-V) — byte-for-byte comparison
#   7. stdin passthrough — wrapper uses exec (preserves stdin)
#   8. wrapper uses exec — no fork/subshell
#
# Usage: ./tests/pi-goal-wrapper.test.sh
# Exit: 0 if all pass, 1 if any fail

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_GOAL_SRC="$REPO_ROOT/bin/pi-goal"

# Use deployed pi-goal if it exists, otherwise use the repo source
if [[ -x "$HOME/.local/bin/pi-goal" ]]; then
  PI_GOAL="$HOME/.local/bin/pi-goal"
else
  PI_GOAL="$PI_GOAL_SRC"
fi

# Find pi binary (same resolution as pi-goal)
PI_BIN="$(command -v pi)"
if [[ -z "$PI_BIN" ]]; then
  echo "ERROR: pi not found in PATH"
  exit 1
fi

TESTS_PASSED=0
TESTS_FAILED=0
FAILURES=()

run_test() {
  local test_name="$1"
  local test_fn="$2"
  
  echo -n "  $test_name ... "
  if "$test_fn"; then
    echo "✓ PASS"
    ((TESTS_PASSED++))
  else
    echo "✗ FAIL"
    ((TESTS_FAILED++))
    FAILURES+=("$test_name")
  fi
}

# ---- Tests ----

test_stdout_passthrough() {
  local pi_out pigoal_out
  pi_out=$("$PI_BIN" --version 2>&1)
  pigoal_out=$("$PI_GOAL" --version 2>&1)
  [[ "$pi_out" == "$pigoal_out" ]]
}

test_stderr_passthrough() {
  local pi_err pigoal_err
  pi_err=$("$PI_BIN" --invalid-flag-xyz-12345 2>&1 || true)
  pigoal_err=$("$PI_GOAL" --invalid-flag-xyz-12345 2>&1 || true)
  [[ "$pi_err" == "$pigoal_err" ]]
}

test_exit_code_passthrough() {
  local pi_exit pigoal_exit
  "$PI_BIN" --version > /dev/null 2>&1
  pi_exit=$?
  "$PI_GOAL" --version > /dev/null 2>&1
  pigoal_exit=$?
  [[ "$pi_exit" == "$pigoal_exit" ]]
}

test_arg_passthrough() {
  local pi_help pigoal_help
  pi_help=$("$PI_BIN" --help 2>&1 | head -5)
  pigoal_help=$("$PI_GOAL" --help 2>&1 | head -5)
  [[ "$pi_help" == "$pigoal_help" ]]
}

test_env_vars_propagate() {
  # Spawn a fake "pi" that prints the env vars, put it first in PATH,
  # then run pi-goal which will exec our fake pi.
  local fake_pi_dir fake_pi
  fake_pi_dir=$(mktemp -d)
  fake_pi="$fake_pi_dir/pi"
  cat > "$fake_pi" << 'EOF'
#!/bin/bash
echo "ENABLE=$PI_GOAL_ENABLE"
echo "START_GOAL=$PI_GOAL_ENABLE_START_GOAL"
echo "CREATE_GOAL=$PI_GOAL_ENABLE_CREATE_GOAL"
EOF
  chmod +x "$fake_pi"
  
  local output
  output=$(PATH="$fake_pi_dir:$PATH" "$PI_GOAL" --version 2>&1)
  rm -rf "$fake_pi_dir"
  
  [[ "$output" == *"ENABLE=true"* ]] && \
  [[ "$output" == *"START_GOAL=true"* ]] && \
  [[ "$output" == *"CREATE_GOAL=true"* ]]
}

test_no_output_swallowing() {
  local pi_out pigoal_out
  pi_out=$("$PI_BIN" -V 2>&1)
  pigoal_out=$("$PI_GOAL" -V 2>&1)
  [[ "$pi_out" == "$pigoal_out" ]]
}

test_stdin_passthrough() {
  # Hard to test piped input non-interactively, but we verify the wrapper
  # uses exec (which preserves stdin fd 0). Grep for exec + "$@".
  grep -Eq '^exec[[:space:]]+pi[[:space:]]+"\$@"' "$PI_GOAL"
}

test_uses_exec_no_fork() {
  # Wrapper must use exec to replace the shell process, NOT run pi as a child
  # and NOT capture/redirect output
  grep -Eq '^exec[[:space:]]+pi' "$PI_GOAL" && \
  ! grep -Eq 'pi[[:space:]]+.*2>&1' "$PI_GOAL" && \
  ! grep -Eq 'pi[[:space:]]+.*>\s' "$PI_GOAL" && \
  ! grep -Eq 'pi[[:space:]]+.*<\s' "$PI_GOAL" && \
  ! grep -Eq 'pi[[:space:]]+.*\|' "$PI_GOAL"
}

test_no_extra_env_mutation() {
  # Verify the wrapper ONLY exports the 3 PI_GOAL_* vars — no PATH, no OMNIROUTE, no other env tampering
  local exports
  exports=$(grep -E '^export ' "$PI_GOAL" || true)
  local export_count
  export_count=$(echo "$exports" | grep -cE '^export ' || true)
  [[ "$export_count" == "3" ]] && \
  echo "$exports" | grep -q 'export PI_GOAL_ENABLE=' && \
  echo "$exports" | grep -q 'export PI_GOAL_ENABLE_START_GOAL=' && \
  echo "$exports" | grep -q 'export PI_GOAL_ENABLE_CREATE_GOAL='
}

# ---- Run ----

echo "=== pi-goal wrapper passthrough tests ==="
echo "  pi-goal: $PI_GOAL"
echo "  pi:      $PI_BIN"
echo

run_test "stdout passthrough (--version)"            test_stdout_passthrough
run_test "stderr passthrough (invalid flag)"         test_stderr_passthrough
run_test "exit code passthrough"                     test_exit_code_passthrough
run_test "arg passthrough (--help)"                  test_arg_passthrough
run_test "env vars propagate to child"               test_env_vars_propagate
run_test "no output swallowing (-V)"                 test_no_output_swallowing
run_test "stdin passthrough (exec preserves fd0)"    test_stdin_passthrough
run_test "wrapper uses exec (no fork/subshell)"      test_uses_exec_no_fork
run_test "no extra env mutation"                     test_no_extra_env_mutation

echo
echo "=== Summary ==="
echo "  Passed: $TESTS_PASSED"
echo "  Failed: $TESTS_FAILED"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
fi

if [[ $TESTS_FAILED -eq 0 ]]; then
  echo
  echo "✓ ALL PASSED"
  exit 0
else
  echo
  echo "✗ SOME FAILED"
  exit 1
fi
