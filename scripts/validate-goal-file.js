#!/usr/bin/env node

/**
 * PI Goal File Validator + Dashboard Visibility Checker
 *
 * Imports the EXACT parsing functions from local pi-goal-xx repo.
 * Validates goal files will show up in PI + goal-dashboard lists.
 * ALSO verifies via goal-dashboard API that the goal is actually visible.
 *
 * Usage:
 *   node validate-goal-file.js <goal-file-path>
 *   node validate-goal-file.js --all <repo-path>
 *   node validate-goal-file.js --all <repo-path> --check-dashboard
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Dynamic import of pi-goal-xx parse functions ───────────────────────
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
let checkDashboard = false;
let dashboardGoals = null;

// ── Dashboard fetch ────────────────────────────────────────────────────
async function fetchDashboardGoals() {
  for (const url of DASHBOARD_URLS) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const goals = Array.isArray(data) ? data : (data.goals || []);
      if (goals.length >= 0) {
        return { goals, url };
      }
    } catch { /* try next */ }
  }
  return null;
}

function checkGoalInDashboard(goalId, repoName) {
  if (!dashboardGoals) return null;
  const found = dashboardGoals.find(g =>
    g.id === goalId && (!g.repoName || g.repoName === repoName)
  );
  return found || null;
}

// ── Validation ─────────────────────────────────────────────────────────
function validateFile(filePath, repoName) {
  const fname = basename(filePath);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${fname}`);
  console.log(`${'═'.repeat(70)}`);

  if (!existsSync(filePath)) {
    console.log('  ❌ FAIL: file does not exist');
    exitCode = 1;
    return;
  }

  // ── Check 1: filename matches active_goal_<ts>_<id>.md pattern ──
  const fnMatch = fname.match(ACTIVE_FILENAME_REGEX);
  if (!fnMatch) {
    console.log('  ❌ FAIL: filename does not match active_goal_<timestamp>_<id>.md');
    console.log(`     expected: active_goal_<${TIMESTAMP_LEN}digits>_<id>.md`);
    console.log(`     got:      ${fname}`);
    console.log(`     common issues:`);
    console.log(`       - goal ID has extra hyphens (must be exactly 1 hyphen: xxxx-yyyy)`);
    console.log(`       - timestamp is wrong length (expected ${TIMESTAMP_LEN} digits)`);
    exitCode = 1;
    return;
  }

  const [, tsStr, idFromFile] = fnMatch;
  const errors = [];
  const warnings = [];

  // ── Check 2: timestamp is correct length ──
  if (tsStr.length !== TIMESTAMP_LEN) {
    errors.push(`timestamp is ${tsStr.length} digits, expected ${TIMESTAMP_LEN} (centiseconds YYYYMMDDHHMMSScc)`);
  }

  // ── Check 3: parseGoalFile succeeds (EXACT pi-goal-xx parser) ──
  const goal = parseGoalFile(filePath);
  if (!goal) {
    errors.push('parseGoalFile() returned null — JSON frontmatter malformed or missing');
    console.log('\n  ❌ CRITICAL: pi-goal-xx parser returned null');
    errors.forEach(e => console.log(`     ${e}`));
    exitCode = 1;
    return;
  }

  // ── Check 4: id field matches filename id ──
  if (goal.id !== idFromFile) {
    errors.push(`id mismatch: filename has "${idFromFile}" but JSON has "${goal.id}"`);
  }

  // ── Check 5: id has valid format (single hyphen) ──
  if (!ID_REGEX.test(goal.id)) {
    errors.push(`id "${goal.id}" fails regex ${ID_REGEX} — must be <base36>-<base36> with exactly 1 hyphen`);
  }

  // ── Check 6: dashboard filename extraction works ──
  const dashMatch = fname.match(FILENAME_ID_REGEX);
  if (!dashMatch) {
    errors.push(`dashboard ID extraction regex ${FILENAME_ID_REGEX} fails on filename — ID won't be extractable`);
  }

  // ── Check 7: activePath matches filename ──
  const expectedActivePath = `.pi/goals/${fname}`;
  if (goal.activePath !== expectedActivePath) {
    warnings.push(`activePath "${goal.activePath}" != expected "${expectedActivePath}"`);
  }

  // ── Check 8: status + autoContinue combo ──
  if (goal.status === 'paused' && goal.autoContinue === true) {
    warnings.push('status=paused + autoContinue=true → pi-goal-xx normalizes to active');
  }

  // ── Check 9: required fields present ──
  if (!goal.objective || goal.objective.trim().length === 0) {
    errors.push('objective is empty or missing');
  }
  if (!goal.createdAt) {
    warnings.push('createdAt missing — will default to now()');
  }

  // ── Check 10: JSON is valid (re-parse to be sure) ──
  const content = require('fs').readFileSync(filePath, 'utf8');
  const end = findJsonObjectEnd(content);
  if (end < 0) {
    errors.push('findJsonObjectEnd() returned -1 — JSON object boundary not found');
  } else {
    try {
      JSON.parse(content.slice(0, end + 1));
    } catch (e) {
      errors.push(`JSON.parse failed: ${e.message}`);
    }
  }

  // ── Check 11: "# Goal Prompt" marker exists ──
  if (!content.includes('\n# Goal Prompt')) {
    errors.push('missing "\\n# Goal Prompt" marker — pi-goal-xx uses this to split JSON from objective');
  }

  // ── Check 12: createdAt timezone sanity ──
  // PI timestampForFile() uses LOCAL TIME (getHours etc)
  // PI nowIso() uses UTC (toISOString)
  // So filename timestamp is LOCAL, createdAt must be UTC
  // This check catches the #1 recurring bug: writing local time with Z suffix
  if (goal.createdAt) {
    const createdDate = new Date(goal.createdAt);
    if (Number.isFinite(createdDate.getTime())) {
      const pad = (v, w = 2) => String(v).padStart(w, '0');
      // What the filename timestamp encodes (LOCAL TIME):
      const tsYear = tsStr.slice(0, 4);
      const tsMonth = tsStr.slice(4, 6);
      const tsDay = tsStr.slice(6, 8);
      const tsHour = tsStr.slice(8, 10);
      const tsMin = tsStr.slice(10, 12);
      const tsSec = tsStr.slice(12, 14);

      // What createdAt encodes, converted to LOCAL TIME:
      const caLocalYear = String(createdDate.getFullYear());
      const caLocalMonth = pad(createdDate.getMonth() + 1);
      const caLocalDay = pad(createdDate.getDate());
      const caLocalHour = pad(createdDate.getHours());
      const caLocalMin = pad(createdDate.getMinutes());
      const caLocalSec = pad(createdDate.getSeconds());

      const tsLocalStr = `${tsYear}-${tsMonth}-${tsDay} ${tsHour}:${tsMin}:${tsSec}`;
      const caLocalStr = `${caLocalYear}-${caLocalMonth}-${caLocalDay} ${caLocalHour}:${caLocalMin}:${caLocalSec}`;

      if (tsLocalStr !== caLocalStr) {
        const tzOffset = -createdDate.getTimezoneOffset() / 60;
        const tzSign = tzOffset >= 0 ? '+' : '';
        errors.push(
          `createdAt timezone mismatch: filename timestamp "${tsLocalStr} (local)" ` +
          `vs createdAt "${caLocalStr} (local, from UTC ${goal.createdAt})". ` +
          `System TZ = UTC${tzSign}${tzOffset}. ` +
          `PI timestampForFile() uses local time, nowIso() uses UTC. ` +
          `createdAt must be the UTC equivalent of the filename timestamp.`
        );
      }
    }
  }

  // ── Report ──
  console.log(`  Parse:     ${goal ? '✅' : '❌'} parseGoalFile ${goal ? 'succeeded' : 'FAILED'}`);
  console.log(`  ID:        ${goal.id}`);
  console.log(`  Status:    ${goal.status}`);
  console.log(`  AutoCont:  ${goal.autoContinue}`);
  console.log(`  Objective: ${goal.objective.length} chars`);
  console.log(`  Created:   ${goal.createdAt}`);
  console.log(`  Timestamp: ${tsStr} (${tsStr.length} digits, expected ${TIMESTAMP_LEN})`);
  console.log(`  GoalPrompt marker: ${content.includes('\n# Goal Prompt') ? '✅' : '❌'}`);

  if (errors.length > 0) {
    console.log(`\n  ❌ ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`     ❌ ${e}`));
    exitCode = 1;
  }

  if (warnings.length > 0) {
    console.log(`\n  ⚠️  WARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`     ⚠️  ${w}`));
  }

  // ── Dashboard visibility check ──
  if (checkDashboard) {
    if (!dashboardGoals) {
      console.log(`\n  ⚠️  DASHBOARD: unreachable (both PROD + DEV down)`);
    } else {
      const found = checkGoalInDashboard(goal.id, repoName);
      if (found) {
        console.log(`\n  ✅ DASHBOARD: found in API — state=${found.derivedState}, repo=${found.repoName}`);
      } else {
        console.log(`\n  ❌ DASHBOARD: NOT FOUND in API — goal is invisible!`);
        exitCode = 1;
      }
    }
  }

  if (errors.length === 0 && (!checkDashboard || (dashboardGoals && checkGoalInDashboard(goal.id, repoName)))) {
    console.log(`\n  ✅ ALL CHECKS PASSED`);
  }
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

// ── Main ──
const args = process.argv.slice(2);
const hasCheckDash = args.includes('--check-dashboard');
if (hasCheckDash) {
  checkDashboard = true;
  args.splice(args.indexOf('--check-dashboard'), 1);
}

const arg = args[0];

if (!arg) {
  console.error('Usage:');
  console.error('  node validate-goal-file.js <goal-file-path> [--check-dashboard]');
  console.error('  node validate-goal-file.js --all <repo-path> [--check-dashboard]');
  process.exit(1);
}

if (arg === '--all') {
  const repoPath = args[1] || process.cwd();
  const repoName = basename(repoPath);

  // Pre-fetch dashboard if needed
  if (checkDashboard) {
    console.log('🔍 Fetching dashboard goals...');
    const result = await fetchDashboardGoals();
    if (result) {
      dashboardGoals = result.goals;
      console.log(`   ✅ Connected to ${result.url} — ${dashboardGoals.length} goals found`);
    } else {
      console.log(`   ⚠️  Both dashboard URLs unreachable — dashboard check will be skipped`);
    }
  }

  console.log(`\n🔍 Scanning ${repoPath}/.pi/goals/ for all active goal files...`);
  const files = findAllGoalFiles(repoPath);
  if (files.length === 0) {
    console.log('  No active goal files found.');
  } else {
    console.log(`  Found ${files.length} active goal file(s)`);
    for (const f of files) validateFile(f, repoName);
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  SUMMARY: ${files.length} files, exit code ${exitCode}`);
    console.log(`${'═'.repeat(70)}`);
  }
} else {
  // Derive repo name from path
  const pathParts = arg.split('/');
  const goalsIdx = pathParts.indexOf('goals');
  const repoName = goalsIdx > 1 ? pathParts[goalsIdx - 2] : basename(arg);

  if (checkDashboard) {
    console.log('🔍 Fetching dashboard goals...');
    const result = await fetchDashboardGoals();
    if (result) {
      dashboardGoals = result.goals;
      console.log(`   ✅ Connected to ${result.url} — ${dashboardGoals.length} goals found`);
    } else {
      console.log(`   ⚠️  Both dashboard URLs unreachable — dashboard check will be skipped`);
    }
  }

  validateFile(arg, repoName);
}

process.exit(exitCode);
