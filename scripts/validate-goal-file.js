#!/usr/bin/env node

/**
 * PI Goal File Validator + Dashboard Visibility Checker + Ceremony Enforcer
 *
 * Imports the EXACT parsing functions from local pi-goal-xx repo.
 *
 * Layers:
 *   C1-C12  — Existing format checks (filename, JSON, ID, timezone, marker)
 *   M1-M20  — Ceremony checks (worktree, contract, tasks, location, symlink)
 *
 * Usage:
 *   node validate-goal-file.js <goal-file-path> [--json]
 *   node validate-goal-file.js --all <repo-path> [--json]
 */

import { existsSync, readdirSync, readFileSync, lstatSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

// ── Dynamic import of pi-goal-xx parse functions ───────────────────────
import { dirname as pathDirname } from 'path';
import { realpathSync } from 'fs';
// Resolve symlinks: if invoked via a symlink (e.g. hermes profile → repo copy),
// import.meta.url gives the symlink path, not the target. realpathSync resolves
// to the real file so __dirname + parent points at the actual repo root.
const __filename = realpathSync(fileURLToPath(import.meta.url));
const __dirname = pathDirname(__filename);
// Script lives at <repo-root>/scripts/validate-goal-file.js — repo root is parent
const PI_GOAL_XX_PATH = dirname(__dirname);

let parseGoalFile, findJsonObjectEnd;
try {
  const mod = await import(join(PI_GOAL_XX_PATH, 'extensions/storage/goal-files.ts'));
  parseGoalFile = mod.parseGoalFile;
  findJsonObjectEnd = mod.findJsonObjectEnd;
} catch (e) {
  console.error('FATAL: cannot import pi-goal-xx from', PI_GOAL_XX_PATH);
  console.error(e.message);
  console.error('\nMake sure pi-goal-xx repo exists at that path.');
  process.exit(2);
}

// ── Format constants (from pi-goal-xx source) ──────────────────────────
const ID_REGEX = /^[a-z0-9]+-[a-z0-9]+$/;
const FILENAME_ID_REGEX = /_([a-z0-9]+)-([a-z0-9]+)\.md$/;
const ACTIVE_FILENAME_REGEX = /^active_goal_(\d{14,17})_([a-z0-9]+-[a-z0-9]+)\.md$/;
const TIMESTAMP_LEN = 16;  // centiseconds

const DASHBOARD_URLS = [
  'http://127.0.0.1:25080/api/goals',
  'http://100.114.135.99:15173/api/goals',
];

let exitCode = 0;
let useJson = false;
let dashboardGoals = null;
let dashboardUrl = null;

// ── Dashboard fetch ────────────────────────────────────────────────────
async function fetchDashboardGoals() {
  for (const url of DASHBOARD_URLS) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const goals = Array.isArray(data) ? data : (data.goals || []);
      return { goals, url };
    } catch { /* try next */ }
  }
  return null;
}

function checkGoalInDashboard(goalId, repoName) {
  if (!dashboardGoals) return null;
  return dashboardGoals.find(g =>
    g.id === goalId && (!g.repoName || g.repoName === repoName)
  ) || null;
}

// ── Worktree / git helpers ─────────────────────────────────────────────
function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
  } catch {
    return null;
  }
}

function worktreeExists(wtPath) {
  if (!wtPath) return false;
  // Quick fs check first
  if (!existsSync(wtPath)) return false;
  // Verify it's actually a git worktree via git's own list
  const parent = dirname(wtPath);
  const list = safeExec('git worktree list', { cwd: parent });
  if (list === null) {
    // Not a git repo at parent — fall back to fs.existsSync
    return existsSync(wtPath);
  }
  return list.split('\n').some(line => line.startsWith(wtPath + ' ') || line.includes(wtPath + ' '));
}

function worktreeBranch(wtPath) {
  if (!existsSync(wtPath)) return null;
  return safeExec('git branch --show-current', { cwd: wtPath });
}

// ── Objective window extraction ────────────────────────────────────────
function extractObjectiveWindow(content) {
  const start = content.indexOf('\n# Goal Prompt');
  if (start < 0) return '';
  const endIdx = content.indexOf('\n## Progress', start);
  if (endIdx < 0) return content.slice(start);
  return content.slice(start, endIdx);
}

// ── M-check helpers ────────────────────────────────────────────────────
// Accept two formats:
//   Compact:  Worktree: <path> (branch: <branch>, base: <sha>)
//   Multi-line w/ backticks:
//     Worktree (ABS path): `<path>`
//     Branch: `<branch>`
//     Base SHA: `<sha>`
const WORKTREE_COMPACT_REGEX = /Worktree:\s*(\S+)\s*\(branch:\s*([^,)]+?),\s*base:\s*([a-f0-9]{7,40})\)/;
const WORKTREE_MULTILINE_PATH_REGEX = /Worktree\s*\(\s*ABS\s*path\s*\)\s*:\s*`?([^`\n]+?)`?\s*$/m;
const WORKTREE_FALLBACK_PATH_REGEX = /Worktree:\s*`?(\S+?)`?\s*$/m;
const BASE_SHA_REGEX = /Base\s+SHA\s*:\s*`?([a-f0-9]{7,40})`?|^base:\s*([a-f0-9]{7,40})/im;
const BRANCH_REGEX = /Branch\s*:\s*`?([^`\n,]+?)`?\s*$/m;
const SOURCE_PATH_REGEX = /(flow\/|docs\/)/;
const LD_CONSTRAINT_REGEX = /\[LD-[a-z0-9-]+\]/i;
// TaskStatus: "pending" | "complete" | "skipped" (per goal-record.ts)
const TASK_DONE_STATUSES = ['complete', 'skipped'];

function parseWorktreeFromObjective(objWindow) {
  // Try compact form first
  const compact = objWindow.match(WORKTREE_COMPACT_REGEX);
  if (compact) {
    return { path: compact[1].trim(), branch: compact[2].trim(), base: compact[3].trim() };
  }
  // Try multi-line w/ backticks
  const multiPath = objWindow.match(WORKTREE_MULTILINE_PATH_REGEX);
  const fallbackPath = objWindow.match(WORKTREE_FALLBACK_PATH_REGEX);
  const pathMatch = multiPath || fallbackPath;
  if (!pathMatch) return null;
  const branchMatch = objWindow.match(BRANCH_REGEX);
  const baseMatch = objWindow.match(BASE_SHA_REGEX);
  return {
    path: pathMatch[1].trim(),
    branch: branchMatch ? branchMatch[1].trim() : null,
    base: baseMatch ? (baseMatch[1] || baseMatch[2]).trim() : null,
  };
}

// ── Validation ─────────────────────────────────────────────────────────
function validateFile(filePath, repoName) {
  const fname = basename(filePath);
  const checks = {};
  const errors = [];
  const warnings = [];

  // ── Pre-check: file exists ──
  if (!existsSync(filePath)) {
    errors.push(`file does not exist: ${filePath}`);
    return { errors, warnings, checks };
  }

  // ── M12: explicit symlink check (BEFORE parser side-effect) ──
  let isSymlink = false;
  try {
    const stat = lstatSync(filePath);
    isSymlink = stat.isSymbolicLink();
  } catch { /* ignore */ }
  if (isSymlink) {
    errors.push('M12: goal file is symlink — must be regular file, not symlink (SOUL: never symlink)');
    checks.M12 = { pass: false, msg: 'file is symlink' };
    return { errors, warnings, checks };
  }
  checks.M12 = { pass: true, msg: 'regular file' };

  // ── M13: not in subdir ──
  const parentDir = basename(dirname(filePath));
  const isGoals = parentDir === 'goals';
  const isTmp = /^validator-m-test-/.test(parentDir) || /^tmp/.test(parentDir) || parentDir === 'tmp' || parentDir === 'T';
  if (!isGoals && !isTmp) {
    errors.push(`M13: goal file in subdir "${parentDir}" — must be DIRECTLY in .pi/goals/ (SOUL: no subdir, no symlink)`);
    checks.M13 = { pass: false, msg: `in subdir ${parentDir}` };
  } else {
    checks.M13 = { pass: true, msg: 'directly in goals/tmp root' };
  }

  // ── Check 1: filename pattern ──
  const fnMatch = fname.match(ACTIVE_FILENAME_REGEX);
  if (!fnMatch) {
    errors.push(`C1: filename does not match active_goal_<timestamp>_<id>.md (got: ${fname})`);
    checks.C1 = { pass: false };
    return { errors, warnings, checks };
  }
  checks.C1 = { pass: true };

  const [, tsStr, idFromFile] = fnMatch;

  // ── Check 2: timestamp length ──
  if (tsStr.length !== TIMESTAMP_LEN) {
    errors.push(`C2: timestamp is ${tsStr.length} digits, expected ${TIMESTAMP_LEN}`);
    checks.C2 = { pass: false };
  } else {
    checks.C2 = { pass: true };
  }

  // ── Check 3: parseGoalFile succeeds ──
  const goal = parseGoalFile(filePath);
  if (!goal) {
    errors.push('C3: parseGoalFile() returned null — JSON frontmatter malformed');
    checks.C3 = { pass: false };
    return { errors, warnings, checks };
  }
  checks.C3 = { pass: true };

  // ── Check 4: id matches filename ──
  if (goal.id !== idFromFile) {
    errors.push(`C4: id mismatch — filename has "${idFromFile}" but JSON has "${goal.id}"`);
    checks.C4 = { pass: false };
  } else {
    checks.C4 = { pass: true };
  }

  // ── Check 5: id format ──
  if (!ID_REGEX.test(goal.id)) {
    errors.push(`C5: id "${goal.id}" fails regex ${ID_REGEX}`);
    checks.C5 = { pass: false };
  } else {
    checks.C5 = { pass: true };
  }

  // ── Check 6: dashboard ID extraction ──
  checks.C6 = fnMatch ? { pass: true } : { pass: false };

  // ── Check 7: activePath (warning) ──
  const expectedActivePath = `.pi/goals/${fname}`;
  if (goal.activePath !== expectedActivePath) {
    warnings.push(`C7: activePath "${goal.activePath}" != expected "${expectedActivePath}"`);
    checks.C7 = { pass: false, warn: true };
  } else {
    checks.C7 = { pass: true };
  }

  // ── Check 8: status+autoContinue (warning) ──
  if (goal.status === 'paused' && goal.autoContinue === true) {
    warnings.push('C8: status=paused + autoContinue=true normalizes to active');
    checks.C8 = { pass: false, warn: true };
  } else {
    checks.C8 = { pass: true };
  }

  // ── Check 9: objective non-empty ──
  if (!goal.objective || goal.objective.trim().length === 0) {
    errors.push('C9: objective is empty or missing');
    checks.C9 = { pass: false };
  } else {
    checks.C9 = { pass: true };
  }

  // ── Check 10: JSON valid ──
  const content = readFileSync(filePath, 'utf8');
  const end = findJsonObjectEnd(content);
  let jsonValid = false;
  if (end >= 0) {
    try {
      JSON.parse(content.slice(0, end + 1));
      jsonValid = true;
    } catch (e) {
      errors.push(`C10: JSON.parse failed: ${e.message}`);
    }
  } else {
    errors.push('C10: findJsonObjectEnd() returned -1');
  }
  checks.C10 = { pass: jsonValid };

  // ── Check 11: # Goal Prompt marker ──
  const hasMarker = content.includes('\n# Goal Prompt');
  if (!hasMarker) {
    errors.push('C11: missing "\\n# Goal Prompt" marker');
  }
  checks.C11 = { pass: hasMarker };

  // ── Check 12: createdAt timezone ──
  let tzOk = true;
  if (goal.createdAt) {
    const createdDate = new Date(goal.createdAt);
    if (Number.isFinite(createdDate.getTime())) {
      const pad = (v, w = 2) => String(v).padStart(w, '0');
      const tsLocalStr = `${tsStr.slice(0,4)}-${tsStr.slice(4,6)}-${tsStr.slice(6,8)} ${tsStr.slice(8,10)}:${tsStr.slice(10,12)}:${tsStr.slice(12,14)}`;
      const caLocalStr = `${createdDate.getFullYear()}-${pad(createdDate.getMonth()+1)}-${pad(createdDate.getDate())} ${pad(createdDate.getHours())}:${pad(createdDate.getMinutes())}:${pad(createdDate.getSeconds())}`;
      if (tsLocalStr !== caLocalStr) {
        errors.push(`C12: createdAt timezone mismatch — filename "${tsLocalStr} (local)" vs createdAt "${caLocalStr} (local, from UTC ${goal.createdAt})"`);
        tzOk = false;
      }
    }
  }
  checks.C12 = { pass: tzOk };

  // ════════════════════════════════════════════════════════════════════
  // M-CHECKS (ceremony enforcement — V1-V9 violation prevention)
  // ════════════════════════════════════════════════════════════════════

  const objWindow = extractObjectiveWindow(content);
  const contract = goal.verificationContract || '';

  // ── M2/M3: worktree path + base SHA in objective ──
  const wt = parseWorktreeFromObjective(objWindow);
  if (!wt || !wt.path) {
    errors.push('M2: objective window missing Worktree path — must be locked in objective (SOUL: durability). Accepts: `Worktree: <path> (branch: ..., base: ...)` OR multi-line `Worktree (ABS path): \\`<path>\\``');
    checks.M2 = { pass: false };
  } else {
    checks.M2 = { pass: true, path: wt.path };
  }
  if (!wt || !wt.base) {
    errors.push('M3: objective window missing base SHA — must be locked in objective (SOUL: durability). Accepts: `base: <sha>` OR `Base SHA: \\`<sha>\\``');
    checks.M3 = { pass: false };
  } else {
    checks.M3 = { pass: true, sha: wt.base };
  }

  // ── M1: worktree exists ──
  if (wt && wt.path) {
    const exists = worktreeExists(wt.path);
    if (!exists) {
      errors.push(`M1: worktree path in objective does not exist or is not a git worktree: ${wt.path} — create worktree BEFORE writing goal (SOUL step 4)`);
      checks.M1 = { pass: false, path: wt.path };
    } else {
      checks.M1 = { pass: true, path: wt.path };
    }
  } else {
    checks.M1 = { pass: false, msg: 'no worktree path to verify' };
  }

  // ── M20: worktree branch matches objective ──
  if (wt && wt.path && checks.M1?.pass) {
    if (wt.branch) {
      const actualBranch = worktreeBranch(wt.path);
      if (!actualBranch) {
        warnings.push(`M20: cannot determine worktree branch for ${wt.path}`);
        checks.M20 = { pass: false, warn: true };
      } else if (actualBranch !== wt.branch) {
        errors.push(`M20: worktree branch mismatch — objective says "${wt.branch}", git says "${actualBranch}"`);
        checks.M20 = { pass: false, expected: wt.branch, actual: actualBranch };
      } else {
        checks.M20 = { pass: true, branch: actualBranch };
      }
    } else {
      checks.M20 = { pass: true, msg: 'no branch in objective — skipped' };
    }
  } else {
    checks.M20 = { pass: false, msg: 'worktree missing — cannot check branch' };
  }

  // ── M5: ceremony block in contract ──
  if (!contract.includes('Ordered workflow (MANDATORY)')) {
    errors.push('M5: verificationContract missing "Ordered workflow (MANDATORY)" — canonical ceremony block required');
    checks.M5 = { pass: false };
  } else {
    checks.M5 = { pass: true };
  }

  // ── M6: auditor hard-reject rule ──
  if (!contract.includes('AUDITOR HARD-REJECT')) {
    errors.push('M6: verificationContract missing "AUDITOR HARD-REJECT" — auditor hard-reject rule required');
    checks.M6 = { pass: false };
  } else {
    checks.M6 = { pass: true };
  }

  // ── M7: LD constraints ──
  const ldMatches = contract.match(new RegExp(LD_CONSTRAINT_REGEX.source, 'gi'));
  if (!ldMatches || ldMatches.length === 0) {
    errors.push('M7: verificationContract has no [LD-*] constraint references — locked decisions must be baked into every task');
    checks.M7 = { pass: false };
  } else {
    checks.M7 = { pass: true, count: ldMatches.length };
  }

  // ── M8: source path in objective ──
  if (!SOURCE_PATH_REGEX.test(objWindow)) {
    errors.push('M8: objective window has no flow/ or docs/ path reference — source must be recorded for durability');
    checks.M8 = { pass: false };
  } else {
    checks.M8 = { pass: true };
  }

  // ── M9: blockCompletion on all tasks ──
  const tasks = goal.taskList?.tasks || [];
  const missingBC = tasks.filter(t => t.blockCompletion !== true);
  if (missingBC.length > 0) {
    const ids = missingBC.map(t => t.id || '<no-id>').join(', ');
    errors.push(`M9: tasks missing blockCompletion:true — [${ids}] (SOUL: blockCompletion MANDATORY)`);
    checks.M9 = { pass: false, missing: missingBC.length };
  } else {
    checks.M9 = { pass: true, total: tasks.length };
  }

  // ── M10: taskList.blockCompletion ──
  if (goal.taskList?.blockCompletion !== true) {
    errors.push('M10: taskList.blockCompletion must be true (SOUL: blockCompletion MANDATORY)');
    checks.M10 = { pass: false };
  } else {
    checks.M10 = { pass: true };
  }

  // ── M11: first worktree task completed ──
  if (tasks.length > 0) {
    const t1 = tasks[0];
    const t1IsWorktreeTask = /worktree/i.test(t1.title || '') || /worktree/i.test(t1.verificationContract || '');
    if (t1IsWorktreeTask && !TASK_DONE_STATUSES.includes(t1.status)) {
      errors.push(`M11: first task "${t1.title}" is worktree-creation but status="${t1.status}" — worktree must exist BEFORE goal is valid (SOUL step 4). Valid done statuses: ${TASK_DONE_STATUSES.join(' | ')}`);
      checks.M11 = { pass: false, status: t1.status };
    } else {
      checks.M11 = { pass: true, status: t1.status };
    }
  } else {
    checks.M11 = { pass: true, msg: 'no tasks' };
  }

  // ── M14: dashboard visibility (default ON, not opt-in) ──
  if (dashboardGoals === null) {
    warnings.push('M14: dashboard unreachable — cannot verify visibility');
    checks.M14 = { pass: false, warn: true };
  } else {
    const found = checkGoalInDashboard(goal.id, repoName);
    if (!found) {
      errors.push(`M14: goal "${goal.id}" NOT FOUND in dashboard API at ${dashboardUrl} — goal is invisible`);
      checks.M14 = { pass: false };
    } else {
      checks.M14 = { pass: true, state: found.derivedState };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // P1 CHECKS (M15-M18) — WARN severity, ceremony completeness
  // ════════════════════════════════════════════════════════════════════

  // ── M15: worktree pre-flight (node_modules + prisma + .env) ──
  if (wt && wt.path && checks.M1?.pass) {
    const missing = [];
    if (!existsSync(join(wt.path, 'node_modules'))) missing.push('node_modules/');
    // Prisma client may live in different paths depending on layout — check both common locations
    const prismaCandidates = [
      join(wt.path, 'backend', 'node_modules', '.prisma'),
      join(wt.path, 'node_modules', '.prisma'),
      join(wt.path, 'backend', 'src', 'db', 'prisma', 'generated'),
    ];
    const prismaOk = prismaCandidates.some(p => existsSync(p));
    if (!prismaOk) missing.push('prisma-generated-client');
    // .env check — common locations
    const envCandidates = [
      join(wt.path, 'backend', '.env'),
      join(wt.path, '.env'),
    ];
    const envOk = envCandidates.some(p => existsSync(p));
    if (!envOk) missing.push('.env');
    if (missing.length > 0) {
      warnings.push(`M15: worktree pre-flight incomplete — missing [${missing.join(', ')}] (can be deferred to execution, but flag for awareness)`);
      checks.M15 = { pass: false, warn: true, missing };
    } else {
      checks.M15 = { pass: true, msg: 'all pre-flight present' };
    }
  } else {
    checks.M15 = { pass: false, warn: true, msg: 'no worktree to check pre-flight' };
  }

  // ── M16: YOLO mode determined (WARN) ──
  // Look for AGENTS.md in repo containing the goal file's parent repo, then in parent of that.
  // If found and mentions YOLO → report. If not found → WARN (unverified).
  const goalsDir = dirname(filePath);
  const repoRoot = dirname(dirname(goalsDir)); // .pi/goals → .pi → repo
  const agmCandidates = [
    join(repoRoot, 'AGENTS.md'),
    join(dirname(repoRoot), 'AGENTS.md'), // parent repo
    join(process.cwd(), 'AGENTS.md'),
  ];
  let yoloDetected = null; // null = unknown, true/false = determined
  for (const ag of agmCandidates) {
    if (existsSync(ag)) {
      try {
        const txt = readFileSync(ag, 'utf8');
        if (/YOLO/i.test(txt)) {
          // If YOLO mode is described as the project's mode → true. Otherwise just present → unknown.
          if (/operate under the \*\*YOLO\*\*/i.test(txt) || /YOLO mode/i.test(txt)) {
            yoloDetected = true;
          } else {
            yoloDetected = false; // mentioned but not the active mode
          }
          break;
        }
      } catch { /* ignore */ }
    }
  }
  if (yoloDetected === true) {
    warnings.push('M16: YOLO mode detected in AGENTS.md — PR skill should auto-merge + deploy after verifier passes');
    checks.M16 = { pass: true, yolo: true };
  } else if (yoloDetected === false) {
    checks.M16 = { pass: true, yolo: false };
  } else {
    warnings.push('M16: YOLO mode undetermined — no AGENTS.md found in repo or parent (cannot auto-decide PR+merge+deploy ceremony)');
    checks.M16 = { pass: false, warn: true };
  }

  // ── M17: parallel flag validated (WARN) ──
  const objLower = objWindow.toLowerCase();
  const mentionsParallel = /parallel/.test(objLower);
  if (mentionsParallel) {
    // User mentioned parallel → multiple worktrees expected. Check for >1 worktree path in objective.
    const allWtMatches = objWindow.match(new RegExp(WORKTREE_FALLBACK_PATH_REGEX.source, 'gmi')) || [];
    if (allWtMatches.length < 2) {
      warnings.push(`M17: objective mentions "parallel" but only ${allWtMatches.length} worktree path(s) found — parallel lanes need N worktrees + 1 converge lane (SOUL: parallel lanes)`);
      checks.M17 = { pass: false, warn: true, found: allWtMatches.length };
    } else {
      checks.M17 = { pass: true, worktrees: allWtMatches.length };
    }
  } else {
    // Sequential — fine, just informational
    checks.M17 = { pass: true, mode: 'sequential' };
  }

  // ── M18: verifier loop count stated (WARN) ──
  // Look in verificationContract OR objective for "verifier" mentions. Each mention = 1 loop.
  const combined = (contract + '\n' + objWindow).toLowerCase();
  const verifierMentions = (combined.match(/verifier[- ]?loop/g) || []).length;
  if (verifierMentions === 0) {
    warnings.push('M18: no "verifier-loop" mention in contract or objective — at least 1 verifier loop (RED + GREEN) is required by ceremony');
    checks.M18 = { pass: false, warn: true };
  } else if (verifierMentions === 1) {
    warnings.push('M18: only 1 verifier-loop mention — sequential goals need RED + GREEN = 2 loops; parallel needs N-lane + 1 converge');
    checks.M18 = { pass: false, warn: true, count: verifierMentions };
  } else {
    checks.M18 = { pass: true, count: verifierMentions };
  }

  return { errors, warnings, checks, goal };
}

function findAllGoalFiles(repoPath) {
  const goalsDir = join(repoPath, '.pi', 'goals');
  if (!existsSync(goalsDir)) {
    console.error(`No .pi/goals/ directory found in ${repoPath}`);
    process.exit(1);
  }
  return readdirSync(goalsDir)
    .filter(f => f.startsWith('active_goal_') && f.endsWith('.md'))
    .map(f => join(goalsDir, f))
    .sort();
}

function formatHuman(filePath, repoName, result) {
  const fname = basename(filePath);
  const { errors, warnings, checks, goal } = result;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${fname}`);
  console.log(`${'═'.repeat(70)}`);

  if (goal) {
    console.log(`  Parse:     ✅ parseGoalFile succeeded`);
    console.log(`  ID:        ${goal.id}`);
    console.log(`  Status:    ${goal.status}`);
    console.log(`  AutoCont:  ${goal.autoContinue}`);
    console.log(`  Objective: ${goal.objective.length} chars`);
    console.log(`  Created:   ${goal.createdAt}`);
  }

  // M-checks summary
  const mKeys = Object.keys(checks).filter(k => k.startsWith('M')).sort();
  console.log(`\n  M-Checks (ceremony):`);
  for (const k of mKeys) {
    const c = checks[k];
    const icon = c.pass ? '✅' : (c.warn ? '⚠️ ' : '❌');
    const extra = c.msg || c.path || c.branch || c.sha || c.count || c.total || '';
    console.log(`    ${icon} ${k}: ${c.pass ? 'PASS' : (c.warn ? 'WARN' : 'FAIL')}${extra ? ' — ' + extra : ''}`);
  }

  if (errors.length > 0) {
    console.log(`\n  ❌ ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`     ❌ ${e}`));
  }

  if (warnings.length > 0) {
    console.log(`\n  ⚠️  WARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`     ⚠️  ${w}`));
  }

  const passed = errors.length === 0;
  console.log(`\n  ${passed ? '✅ ALL CHECKS PASSED' : '❌ CHECKS FAILED'}`);
}

function formatJson(filePath, repoName, result) {
  const { errors, warnings, checks, goal } = result;
  const output = {
    file: basename(filePath),
    valid: errors.length === 0,
    errors,
    warnings,
    checks,
  };
  if (goal) {
    output.id = goal.id;
    output.status = goal.status;
    output.worktree = checks.M1?.path || null;
    output.worktree_exists = checks.M1?.pass || false;
    output.branch_matches = checks.M20?.pass || false;
    output.dashboard_visible = checks.M14?.pass || false;
  }
  console.log(JSON.stringify(output, null, 2));
}

// ── Main ──
const args = process.argv.slice(2);
const hasJson = args.includes('--json');
if (hasJson) {
  useJson = true;
  args.splice(args.indexOf('--json'), 1);
}

const arg = args[0];

if (!arg) {
  console.error('Usage:');
  console.error('  node validate-goal-file.js <goal-file-path> [--json]');
  console.error('  node validate-goal-file.js --all <repo-path> [--json]');
  process.exit(1);
}

// Always fetch dashboard (M14 = default ON)
const dashResult = await fetchDashboardGoals();
if (dashResult) {
  dashboardGoals = dashResult.goals;
  dashboardUrl = dashResult.url;
}

if (arg === '--all') {
  const repoPath = args[1] || process.cwd();
  const repoName = basename(repoPath);

  console.log(`🔍 Scanning ${repoPath}/.pi/goals/ for all active goal files...`);
  if (dashboardUrl) console.log(`   Dashboard: ${dashboardUrl} (${dashboardGoals.length} goals)`);

  const files = findAllGoalFiles(repoPath);
  if (files.length === 0) {
    console.log('  No active goal files found.');
  } else {
    console.log(`  Found ${files.length} active goal file(s)`);
    for (const f of files) {
      const result = validateFile(f, repoName);
      if (result.errors.length > 0) exitCode = 1;
      if (useJson) formatJson(f, repoName, result);
      else formatHuman(f, repoName, result);
    }
    if (!useJson) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`  SUMMARY: ${files.length} files, exit code ${exitCode}`);
      console.log(`${'═'.repeat(70)}`);
    }
  }
} else {
  // Derive repo name from path
  const pathParts = arg.split('/');
  const goalsIdx = pathParts.indexOf('goals');
  const repoName = goalsIdx > 1 ? pathParts[goalsIdx - 2] : basename(arg);

  const result = validateFile(arg, repoName);
  if (result.errors.length > 0) exitCode = 1;
  if (useJson) formatJson(arg, repoName, result);
  else formatHuman(arg, repoName, result);
}

process.exit(exitCode);
