import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const VALIDATOR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scripts",
  "validate-goal-file.js",
);

/**
 * Run the validator on a given goal file path.
 * Returns exit code + stdout + stderr.
 */
function runValidator(
  goalPath: string,
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node ${VALIDATOR} ${goalPath} ${extraArgs.join(" ")}`, {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e: any) {
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

/**
 * Build a goal file that passes all EXISTING validator checks
 * (filename pattern, JSON parse, ID match, timezone, Goal Prompt marker).
 * The `overrides` let tests inject specific M1-M20 violations.
 */
function buildGoalFile(opts: {
  /** Override the objective body text */
  objective?: string;
  /** Override the verificationContract string */
  verificationContract?: string;
  /** Override the taskList */
  taskList?: Record<string, unknown>;
  /** Override the full JSON frontmatter (merged on top of defaults) */
  frontmatterOverrides?: Record<string, unknown>;
}): string {
  const ts = "2026080512000000";
  const id = "test123-ab456";
  const createdAt = "2026-08-05T12:00:00.000Z"; // matches ts in UTC

  const baseFrontmatter = {
    version: 3,
    id,
    objective: opts.objective ?? "Do the thing",
    status: "active",
    autoContinue: true,
    sisyphus: false,
    verificationContract: opts.verificationContract ?? "",
    taskList: opts.taskList ?? {
      tasks: [
        {
          id: "t1",
          title: "Create worktree",
          status: "completed",
          verificationContract: "worktree exists",
          blockCompletion: true,
        },
      ],
      blockCompletion: true,
    },
    createdAt,
    updatedAt: createdAt,
    ...(opts.frontmatterOverrides ?? {}),
  };

  return `${JSON.stringify(baseFrontmatter, null, 2)}

# Goal Prompt

${opts.objective ?? "Do the thing"}

## Progress

- Status: active
`;
}

/** Filename that passes existing validator checks */
const VALID_FILENAME = "active_goal_2026080512000000_test123-ab456.md";

/**
 * A "good" verification contract that contains all required phrases.
 * Used as baseline; tests remove specific phrases to test M5/M6/M7.
 */
const GOOD_CONTRACT = [
  "Ordered workflow (MANDATORY)",
  "AUDITOR HARD-REJECT: any violation = immediate abort",
  "LD-nest-child: verify nesting under source parent",
].join("\n");

/**
 * A "good" objective window that mentions worktree, base SHA, and source paths.
 */
const GOOD_OBJECTIVE = [
  "Worktree: {{WT_PATH}} (branch: wt/test, base: abc123def456)",
  "Source: flow/requirements/test.md",
  "Docs: docs/plans/test.md",
].join("\n");

describe("Validator M1-M20 checks (RED phase — all should FAIL)", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validator-m-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a goal file with the valid filename into tmpDir */
  function writeGoal(content: string, filename = VALID_FILENAME): string {
    const p = path.join(tmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
  }

  // ── M1: Worktree not created ──────────────────────────────────────
  it("M1: FAILS when worktree path in objective does not exist", () => {
    const objective = GOOD_OBJECTIVE.replace(
      "{{WT_PATH}}",
      "/nonexistent/path/wt-test-does-not-exist",
    );
    const content = buildGoalFile({
      objective,
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when worktree path does not exist (M1)",
    );
  });

  // ── M2: Worktree path not locked ─────────────────────────────────
  it("M2: FAILS when objective window has no worktree path", () => {
    const content = buildGoalFile({
      objective: "Do the thing properly. No worktree mentioned anywhere.",
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when no worktree path in objective (M2)",
    );
  });

  // ── M3: Base SHA not locked ──────────────────────────────────────
  it("M3: FAILS when objective window has no base SHA", () => {
    const objective = "Worktree: /some/path/wt-test (branch: wt/test)\nNo base SHA here.";
    const content = buildGoalFile({
      objective,
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when no base SHA in objective (M3)",
    );
  });

  // ── M5: Ceremony not in contract ─────────────────────────────────
  it("M5: FAILS when verificationContract missing 'Ordered workflow (MANDATORY)'", () => {
    const contract = [
      "AUDITOR HARD-REJECT: any violation = immediate abort",
      "LD-nest-child: verify nesting",
    ].join("\n");
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: contract,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when verificationContract missing 'Ordered workflow (MANDATORY)' (M5)",
    );
  });

  // ── M6: Auditor hard-reject missing ──────────────────────────────
  it("M6: FAILS when verificationContract missing 'AUDITOR HARD-REJECT'", () => {
    const contract = [
      "Ordered workflow (MANDATORY)",
      "LD-nest-child: verify nesting",
    ].join("\n");
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: contract,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when verificationContract missing 'AUDITOR HARD-REJECT' (M6)",
    );
  });

  // ── M7: LD constraints missing ───────────────────────────────────
  it("M7: FAILS when verificationContract has no LD- references", () => {
    const contract = [
      "Ordered workflow (MANDATORY)",
      "AUDITOR HARD-REJECT: any violation = immediate abort",
      "No LD references here at all",
    ].join("\n");
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: contract,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when verificationContract has no LD- references (M7)",
    );
  });

  // ── M8: Source path not in objective ─────────────────────────────
  it("M8: FAILS when objective has no flow/ or docs/ paths", () => {
    const objective = [
      "Worktree: /some/path (branch: wt/test, base: abc123def456)",
      "No source paths mentioned here.",
    ].join("\n");
    const content = buildGoalFile({
      objective,
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when objective has no flow/ or docs/ paths (M8)",
    );
  });

  // ── M9: blockCompletion missing on tasks ─────────────────────────
  it("M9: FAILS when tasks lack blockCompletion: true", () => {
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
      taskList: {
        tasks: [
          {
            id: "t1",
            title: "Create worktree",
            status: "completed",
            verificationContract: "worktree exists",
            // blockCompletion intentionally omitted
          },
        ],
        blockCompletion: true,
      },
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when tasks lack blockCompletion: true (M9)",
    );
  });

  // ── M10: taskList.blockCompletion missing ────────────────────────
  it("M10: FAILS when taskList.blockCompletion is false/missing", () => {
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
      taskList: {
        tasks: [
          {
            id: "t1",
            title: "Create worktree",
            status: "completed",
            verificationContract: "worktree exists",
            blockCompletion: true,
          },
        ],
        blockCompletion: false,
      },
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when taskList.blockCompletion is false (M10)",
    );
  });

  // ── M11: t1 worktree task not completed ──────────────────────────
  it("M11: FAILS when first task is 'create worktree' but status != completed", () => {
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
      taskList: {
        tasks: [
          {
            id: "t1",
            title: "Create worktree",
            status: "pending", // NOT completed
            verificationContract: "worktree exists",
            blockCompletion: true,
          },
        ],
        blockCompletion: true,
      },
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when first worktree task is not completed (M11)",
    );
  });

  // ── M12: Symlink check ───────────────────────────────────────────
  // NOTE: The validator currently rejects symlinks as a SIDE EFFECT
  // (parseGoalFile returns null because the resolved path differs).
  // There is no EXPLICIT symlink check with a clear error message.
  // GREEN phase should add an explicit lstat() check with a descriptive
  // error message instead of relying on parser failure.
  it("M12: FAILS when goal file is a symlink (explicit check, not parser side-effect)", () => {
    // Use a dedicated subdir to avoid filename collisions with other tests
    const m12Dir = path.join(tmpDir, "m12-symlink");
    fs.mkdirSync(m12Dir, { recursive: true });

    const realFile = path.join(m12Dir, "real-goal-file.md");
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", m12Dir),
      verificationContract: GOOD_CONTRACT,
    });
    fs.writeFileSync(realFile, content);

    const symlinkPath = path.join(m12Dir, VALID_FILENAME);
    fs.symlinkSync(realFile, symlinkPath);

    const result = runValidator(symlinkPath);
    // Validator already rejects symlinks (parseGoalFile returns null).
    // But the error message should explicitly say "symlink" not "parse failed".
    // GREEN phase must add explicit lstat() + clear error message.
    const hasExplicitSymlinkError =
      result.stdout.includes("symlink") || result.stderr.includes("symlink");
    assert.ok(
      hasExplicitSymlinkError,
      "Validator should have an EXPLICIT symlink check with clear error message (M12). " +
        "Currently rejects via parser side-effect. Got stdout: " + result.stdout.slice(0, 300),
    );
  });

  // ── M13: Subdir check ────────────────────────────────────────────
  it("M13: FAILS when goal file is in .pi/goals/subdir/", () => {
    const subdir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subdir, { recursive: true });
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = path.join(subdir, VALID_FILENAME);
    fs.writeFileSync(goalPath, content);

    const result = runValidator(goalPath);
    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when goal file is in a subdirectory (M13)",
    );
  });

  // ── M19: JSON output ─────────────────────────────────────────────
  it("M19: FAILS when --json flag used but output is not valid JSON", () => {
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath, ["--json"]);
    // Validator should either: (a) recognize --json and output valid JSON,
    // or (b) error on unknown flag. Currently it ignores --json silently.
    // Either way, stdout should be parseable JSON if --json was requested.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // If stdout is not JSON, the test should fail (validator doesn't support --json)
      assert.fail(
        "Validator should output valid JSON when --json flag is used (M19). Got: " +
          result.stdout.slice(0, 200),
      );
    }
    // If we got here, JSON parsed — but we need to verify it has expected shape
    assert.ok(
      parsed && typeof parsed === "object",
      "JSON output should be an object",
    );
  });

  // ── M20: Worktree branch mismatch ────────────────────────────────
  it("M20: FAILS when worktree branch doesn't match objective", () => {
    // Create a real git worktree to test branch mismatch
    const m20Dir = path.join(tmpDir, "m20-git");
    const repoDir = path.join(m20Dir, "repo");
    const wtDir = path.join(m20Dir, "wt");

    fs.mkdirSync(m20Dir, { recursive: true });

    try {
      // Create a minimal git repo
      fs.mkdirSync(repoDir, { recursive: true });
      execSync("git init", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "test");
      execSync("git add .", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git commit -m "init"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });

      // Create a branch first, then create worktree from that branch
      // Use 'git branch' to create without switching, then worktree add
      execSync("git branch wt/expected-branch", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync(`git worktree add "${wtDir}" wt/expected-branch`, {
        cwd: repoDir,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e: any) {
      // If git setup fails, report clearly instead of silently passing
      assert.fail(`M20 git setup failed: ${e.message?.slice(0, 200)}`);
      return; // unreachable but satisfies TS
    }

    // Objective says branch is "wt/wrong-branch" but worktree is on "wt/expected-branch"
    const objective = [
      `Worktree: ${wtDir} (branch: wt/wrong-branch, base: abc123def456)`,
      "Source: flow/requirements/test.md",
    ].join("\n");
    const content = buildGoalFile({
      objective,
      verificationContract: GOOD_CONTRACT,
    });
    const goalPath = writeGoal(content);
    const result = runValidator(goalPath);

    // Cleanup worktree
    try {
      execSync(`git worktree remove "${wtDir}"`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
    } catch {
      // ignore cleanup errors
    }

    assert.notEqual(
      result.exitCode,
      0,
      "Validator should FAIL when worktree branch doesn't match objective (M20)",
    );
  });

  // ── M4: Location check (repo-not-on-main → parent .pi/goals/) ────────
  it("M4: FAILS when goal file is in a side worktree, not main worktree's .pi/goals/", () => {
    // Create a repo with multiple worktrees:
    // - main worktree on 'main' branch
    // - side worktree on 'dev' branch
    // Goal file in side worktree's .pi/goals/ should FAIL
    const m4Dir = path.join(tmpDir, "m4-location");
    const repoDir = path.join(m4Dir, "repo");
    const mainWtDir = path.join(m4Dir, "main-wt");
    const sideWtDir = path.join(m4Dir, "side-wt");

    fs.mkdirSync(m4Dir, { recursive: true });

    try {
      // Create repo with initial commit on 'main'
      fs.mkdirSync(repoDir, { recursive: true });
      execSync("git init", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git symbolic-ref HEAD refs/heads/main', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "main");
      execSync("git add .", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync('git commit -m "init main"', { cwd: repoDir, encoding: "utf8", stdio: "pipe" });

      // Create side worktree on 'dev' branch
      execSync("git branch dev", { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
      execSync(`git worktree add "${sideWtDir}" dev`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      assert.fail(`M4 git setup failed: ${e.message?.slice(0, 200)}`);
      return;
    }

    // Write goal file in SIDE worktree's .pi/goals/ (side is on dev, not main)
    const sideGoalsDir = path.join(sideWtDir, ".pi", "goals");
    fs.mkdirSync(sideGoalsDir, { recursive: true });
    const goalPath = path.join(sideGoalsDir, VALID_FILENAME);
    const content = buildGoalFile({
      objective: GOOD_OBJECTIVE.replace("{{WT_PATH}}", tmpDir),
      verificationContract: GOOD_CONTRACT,
    });
    fs.writeFileSync(goalPath, content);

    const result = runValidator(goalPath);
    // Should FAIL because side worktree is on dev, not main
    const hasM4Error = result.stdout.includes("M4") || result.stderr.includes("M4");
    assert.ok(
      hasM4Error,
      "Validator should FAIL with M4 error when goal is in side worktree, not main worktree's .pi/goals/. Got: " + result.stdout.slice(0, 300),
    );

    // Cleanup worktree
    try {
      execSync(`git worktree remove "${sideWtDir}"`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
    } catch {
      // ignore cleanup errors
    }
  });
});
