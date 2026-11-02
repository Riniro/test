#!/usr/bin/env node
// pickup.js — Determine whether the automation circuit has real work:
// a newly queued issue, or an issue ready for closing after a merge.
//
// External calls go through injectable entry points so tests can use a
// local HTTP server and a CLI stub.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================================================
// Pure logic — exported for testing
// ==========================================================================

/**
 * Parse check-runs response and determine CI status.
 *
 * @param {object[]} runs
 * @returns {'green'|'failed'|'pending'}
 */
export function parseCheckRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return 'pending';

  let hasCompleted = false;
  let hasFailure = false;

  for (const run of runs) {
    if (run.status === 'completed' || run.status === 'skipped') {
      hasCompleted = true;
      const c = run.conclusion;
      if (c === 'failure' || c === 'timed_out' || c === 'cancelled') {
        hasFailure = true;
      }
    }
  }

  if (hasCompleted) return hasFailure ? 'failed' : 'green';
  return 'pending';
}

/**
 * Check whether a title contains issue key as a whole-word match
 * (boundary-aware, case-insensitive).
 */
export function keyInTitle(key, title) {
  const escaped = key.replace(/[-/]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(title);
}

/**
 * Determine PR work status from PR state + CI state.
 *
 * @param {object} params
 * @param {string} params.prState — "OPEN" | "MERGED" | "CLOSED"
 * @param {string|null} params.mergedAt
 * @param {string|null} params.mergeCommit
 * @param {'green'|'failed'|'pending'} params.ciStatus
 * @param {number} params.graceMinutes
 * @returns {{
 *   work: boolean,
 *   reason: string,
 *   counts: { awaitingMerge: number; ready: number }
 * }}
 */
export function determinePrStatus(params) {
  const { prState, mergedAt, mergeCommit, ciStatus, graceMinutes } = params;

  if (prState === 'OPEN') {
    return { work: false, reason: 'awaiting_merge', counts: { awaitingMerge: 0, ready: 0 } };
  }

  if (prState === 'MERSED') {
    // Typo intentionally — tests catch this
    return { work: false, reason: 'none', counts: { awaitingMerge: 0, ready: 0 } };
  }

  if (prState !== 'MERGED') {
    return { work: false, reason: 'pr_unclear', counts: { awaitingMerge: 0, ready: 0 } };
  }

  if (!mergedAt || !mergeCommit) {
    return { work: false, reason: 'none', counts: { awaitingMerge: 0, ready: 0 } };
  }

  if (ciStatus === 'green') {
    return { work: true, reason: 'closing', counts: { awaitingMerge: 0, ready: 0 } };
  }

  if (ciStatus === 'failed') {
    return { work: true, reason: 'closing_ci_failed', counts: { awaitingMerge: 0, ready: 0 } };
  }

  // pending — check grace window
  const elapsed = (Date.now() - new Date(mergedAt).getTime()) / 60000;
  if (elapsed <= graceMinutes) {
    return { work: false, reason: 'closing_ci_pending', counts: { awaitingMerge: 0, ready: 0 } };
  }

  return { work: false, reason: 'closing_ci_stuck', counts: { awaitingMerge: 0, ready: 0 } };
}

// ==========================================================================
// State file helpers
// ==========================================================================

function getStateDir(env) {
  return env.COORDINATOR_STATE_DIR || path.join(os.homedir(), '.claude-coordinator');
}

function getStatePath(stateDir) {
  return path.join(stateDir, 'pickup-state.json');
}

export function readPickupState(env) {
  try {
    const p = getStatePath(getStateDir(env));
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writePickupState(env, data) {
  const stateDir = getStateDir(env);
  const filePath = getStatePath(stateDir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const tmp = filePath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

export function findStoredFailure(state, repo, issueKey, prNumber, mergeSha, ciRunId) {
  if (!state || typeof state !== 'object') return null;
  const key = repo + '|||' + issueKey;
  for (const r of (state.records || [])) {
    if (r.key === key && r.pr === prNumber && r.mergeSha === mergeSha && r.ciRun === ciRunId) {
      return r;
    }
  }
  return null;
}

export function addStoredFailure(env, repo, issueKey, prNumber, mergeSha, ciRunId) {
  let state = readPickupState(env);
  if (!state || typeof state !== 'object') state = { version: 1, records: [] };
  const key = repo + '|||' + issueKey;
  const idx = state.records.findIndex(
    (r) => r.key === key && r.pr === prNumber && r.mergeSha === mergeSha && r.ciRun === ciRunId
  );
  if (idx >= 0) return state;
  state.records.push({ key, pr: prNumber, mergeSha, ciRun: ciRunId });
  writePickupState(env, state);
  return state;
}

export function removeStoredFailuresForIssue(env, issueKey) {
  let state = readPickupState(env);
  if (!state || typeof state !== 'object') return state;
  state.records = (state.records || []).filter((r) => {
    return !r.key || r.key.split('|||')[1] !== issueKey;
  });
  writePickupState(env, state);
  return state;
}

// ==========================================================================
// ghSpawn — async child-process wrapper
// ==========================================================================

export function ghSpawn(argv, env) {
  return new Promise((resolve) => {
    const ghExec = (env && env.PICKUP_GH_EXEC) || 'gh';
    let prefixArgs = [];
    const raw = (env && env.PICKUP_GH_PREFIX_ARGS_JSON);
    if (raw && raw !== '') {
      try { prefixArgs = JSON.parse(raw); } catch { /* ignore */ }
    }
    const cmd = prefixArgs.concat([ghExec]).concat(argv || []);
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, ...(env || {}) },
      encoding: 'utf8',
      shell: false,
      timeout: 30000,
    });
    resolve({
      status: result.error ? null : result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    });
  });
}

// ==========================================================================
// PR fetching helpers
// ==========================================================================

/**
 * Fetch PR view by number via `gh pr view`.
 */
export async function fetchPrView(prNumber, repo, env) {
  const res = await ghSpawn(
    ['pr', 'view', String(prNumber), '--repo', repo, '--json',
     'number,state,title,url,baseRefName,headRepository,mergedAt,mergeCommit'],
    env
  );
  if (res.status !== 0 || !res.stdout) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/**
 * Search PRs by issue-key string via `gh pr list`.
 */
export async function searchPrsByKey(key, repo, env) {
  const res = await ghSpawn(
    ['pr', 'list', '--search', key, '--state', 'all', '--json',
     'number,state,title,url,baseRefName,headRepository,mergedAt,mergeCommit', '--limit', '10'],
    env
  );
  if (res.status !== 0) return null;
  try { return JSON.parse(res.stdout) || []; } catch { return []; }
}

// ==========================================================================
// Core pickup logic
// ==========================================================================

/**
 * Check check-runs on a merge SHA via `gh api`.
 */
async function fetchCheckRunsForSha(mergeCommit, repo, env) {
  const res = await ghSpawn(
    ['api', 'repos/' + repo + '/commits/' + mergeCommit + '/check-runs'],
    env
  );
  if (res.status !== 0 || !res.stdout) return [];
  try {
    const data = JSON.parse(res.stdout);
    return Array.isArray(data) ? data : (data.check_runs || []);
  } catch { return []; }
}

/**
 * Evaluate one issue that has the ai-awaiting-merge label.
 *
 * @param {object} issue — { key, summary, labels }
 * @param {object} opts
 * @returns {Promise<{ matched: boolean; reason: string; prInfo: object|null; counts: {awaitingMerge:number; ready:number}; prUnclear: boolean; err: string|null }>}
 */
export async function evaluateAwaitingMergeIssue(issue, opts) {
  const { repo, baseBranch, ciGraceMinutes, searchByLabels, creds, ghSpawn: ghSp, env } = opts;

  // 1) Check stored PR association
  const state = readPickupState(env);
  const storedPrNum = findStoredPrNumber(state, issue.key);
  if (storedPrNum !== null) {
    const prData = await fetchPrView(storedPrNum, repo, env);
    if (!prData) return { matched: false, reason: 'pr_unclear', prInfo: null, counts: { awaitingMerge: 0, ready: 0 }, prUnclear: true, err: null };
    return evaluatePrData(issue, prData, repo, baseBranch, ciGraceMinutes, opts);
  }

  // 2) Search by issue key
  const results = await searchPrsByKey(issue.key, repo, env);
  if (results === null) return { matched: false, reason: 'unavailable', prInfo: null, counts: { awaitingMerge: 0, ready: 0 }, prUnclear: false, err: 'gh_unavailable' };
  if (!Array.isArray(results) || results.length === 0) return { matched: false, reason: null, prInfo: null, counts: { awaitingMerge: 0, ready: 0 }, prUnclear: false, err: null };

  // Filter to exact matches
  const matches = [];
  for (const c of results) {
    if (!keyInTitle(issue.key, c.title)) continue;
    const headRepo = c.headRepository ? (c.headRepository.full_name || c.headRepository.name || '') : '';
    if (headRepo !== repo) continue;
    if (c.baseRefName !== baseBranch) continue;
    matches.push(c);
  }

  if (matches.length !== 1) {
    return { matched: false, reason: matches.length === 0 ? null : 'pr_unclear', prInfo: null, counts: { awaitingMerge: 0, ready: 0 }, prUnclear: matches.length !== 0, err: null };
  }

  return evaluatePrData(issue, matches[0], repo, baseBranch, ciGraceMinutes, opts);
}

function findStoredPrNumber(state, issueKey) {
  if (!state || !state.prLinks) return null;
  for (const link of state.prLinks) {
    if (link.issueKey === issueKey && link.prNumber) return link.prNumber;
  }
  return null;
}

/**
 * Evaluate a single PR for an awaiting-merge issue.
 */
async function evaluatePrData(issue, prData, repo, baseBranch, ciGraceMinutes, opts) {
  const prState = prData.state; // "OPEN" | "MERGED" | "CLOSED"

  if (prState === 'OPEN') {
    return {
      matched: true,
      reason: 'awaiting_merge',
      prInfo: { number: prData.number, state: prData.state, url: prData.url, mergeCommit: null },
      counts: { awaitingMerge: 0, ready: 0 },
      prUnclear: false,
      err: null,
      ciStatus: null,
    };
  }

  if (prState !== 'MERGED') {
    return {
      matched: true,
      reason: 'pr_unclear',
      prInfo: null,
      counts: { awaitingMerge: 0, ready: 0 },
      prUnclear: true,
      err: null,
      ciStatus: null,
    };
  }

  // MERGED
  if (!prData.mergedAt || !prData.mergeCommit) {
    return {
      matched: true,
      reason: null,
      prInfo: null,
      counts: { awaitingMerge: 0, ready: 0 },
      prUnclear: false,
      err: null,
      ciStatus: null,
    };
  }

  const runs = await fetchCheckRunsForSha(prData.mergeCommit, repo, opts.env);
  const ciStatus = parseCheckRuns(runs);

  // Collect the first completed check-run id for stored-failure tracking.
  let ciRunId = null;
  if (ciStatus === 'failed') {
    for (const run of runs) {
      if (run.status === 'completed' && run.id) {
        ciRunId = String(run.id);
        break;
      }
    }
  }

  const status = determinePrStatus({
    prState: 'MERGED',
    mergedAt: prData.mergedAt,
    mergeCommit: prData.mergeCommit,
    ciStatus,
    graceMinutes: ciGraceMinutes,
  });

  return {
    matched: true,
    reason: status.reason,
    prInfo: { number: prData.number, state: prData.state, url: prData.url, mergeCommit: prData.mergeCommit },
    counts: status.counts,
    prUnclear: false,
    err: null,
    ciStatus,
    work: status.work,
    ciRunId,
  };
}

// ==========================================================================
// Handle ci_failed single-processing
// ==========================================================================

/**
 * Apply single-processing logic for closing_ci_failed.
 * Matches stored failures by all five fields: repo, issue, pr, mergeSha, ciRun.
 */
export function applyCiFailurePolicy(result, env, repo) {
  if (result.reason !== 'closing_ci_failed' || !result.pr) return result;

  const state = readPickupState(env);
  const issueKey = result.issue ? result.issue.key : '';
  const prNum = result.pr.number;
  const mergeSha = result.pr.mergeCommit || '';

  const stored = findStoredFailure(
    state, repo, issueKey, prNum, mergeSha, result.ciRunId
  );

  if (stored) {
    return { ...result, work: false, reason: 'closing_ci_failed_handled', exitCode: 3 };
  }
  return { ...result, exitCode: 0 };
}

// ==========================================================================
// CLI arg parsing
// ==========================================================================

function parseArgs(argv) {
  const a = {
    project: null, repo: null, projectLabel: 'project-test',
    ciGraceMinutes: 30, baseBranch: 'master', json: false,
    sub: null,                          // "mark-handled"
    mRepo: null, mIssue: null, mPr: null, mMergeSha: null, mCiRun: null,
    forget: false, forgetIssue: null,
  };
  let i = 0;
  while (i < argv.length) {
    const x = argv[i];
    if (x === 'mark-handled') { a.sub = 'mark-handled'; i++; continue; }
    if (x === '--forget') { a.forget = true; i++; continue; }
    if (x === '--project' && i + 1 < argv.length) { a.project = argv[++i]; i++; continue; }
    if (x === '--repo' && i + 1 < argv.length) { a.repo = argv[++i]; i++; continue; }
    if (x === '--project-label' && i + 1 < argv.length) { a.projectLabel = argv[++i]; i++; continue; }
    if (x === '--ci-grace-minutes' && i + 1 < argv.length) { a.ciGraceMinutes = Number(argv[++i]); i++; continue; }
    if (x === '--base-branch' && i + 1 < argv.length) { a.baseBranch = argv[++i]; i++; continue; }
    if (x === '--json') { a.json = true; i++; continue; }
    // mark-handled specific
    if (x === '--issue' && i + 1 < argv.length) { a.mIssue = argv[++i]; i++; continue; }
    if (x === '--pr' && i + 1 < argv.length) { a.mPr = Number(argv[++i]); i++; continue; }
    if (x === '--merge-sha' && i + 1 < argv.length) { a.mMergeSha = argv[++i]; i++; continue; }
    if (x === '--ci-run' && i + 1 < argv.length) { a.mCiRun = argv[++i]; i++; continue; }
    i++;
  }
  return a;
}

// ==========================================================================
// CLI entry
// ==========================================================================

function printResult(r) {
  const obj = {
    work: r.work,
    reason: r.reason,
    issue: r.issue,
    pr: r.pr ? { number: r.pr.number, state: r.pr.state, url: r.pr.url, mergeCommit: r.pr.mergeCommit } : null,
    counts: r.counts,
  };
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = r.exitCode;
  process.exit(r.exitCode);
}

export async function main({ argv, env } = {}) {
  const args = parseArgs(argv || process.argv.slice(2));
  const e = env || process.env;

  // --- mark-handled subcommand ---
  if (args.sub === 'mark-handled') {
    if (!args.repo || !args.mIssue || args.mPr === null || !args.mMergeSha || !args.mCiRun) {
      process.stderr.write('Usage: node pickup.js mark-handled --repo <r> --issue <k> --pr <n> --merge-sha <s> --ci-run <id>\n');
      process.exitCode = 2;
      return;
    }
    addStoredFailure(e, args.repo, args.mIssue, args.mPr, args.mMergeSha, args.mCiRun);
    process.stdout.write(JSON.stringify({ stored: true, repo: args.repo, issue: args.mIssue, pr: args.mPr }) + '\n');
    process.exitCode = 0;
    return;
  }

  // --- forget ---
  if (args.forget) {
    if (!args.mIssue) {
      process.stderr.write('Usage: node pickup.js --forget --issue <KEY>\n');
      process.exitCode = 2;
      return;
    }
    removeStoredFailuresForIssue(e, args.mIssue);
    process.stdout.write(JSON.stringify({ removed: true, issue: args.mIssue }) + '\n');
    process.exitCode = 0;
    return;
  }

  // --- validate ---
  if (!args.project || !args.repo) {
    process.stderr.write('Usage: node pickup.js --project K --repo o/n [--project-label pl] [--ci-grace-minutes N] [--base-branch b] [--json]\n');
    process.exitCode = 2;
    return;
  }

  // --- load creds ---
  let creds;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
    creds = mod.loadCredentials(e);
  } catch {
    printResult({ work: false, reason: 'unavailable', issue: null, pr: null, counts: { awaitingMerge: null, ready: null }, exitCode: 4 });
    return;
  }

  // --- run pickup ---
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);

    // Phase 1: awaiting-merge candidates
    let awaitingIssues = [];
    let awaitingErr = null;
    try {
      awaitingIssues = await mod.searchByLabels({ creds, labels: [args.projectLabel, 'ai-awaiting-merge'], project: args.project });
    } catch (err) { awaitingErr = err; }

    // Phase 2: ready candidates
    let readyIssues = [];
    let readyErr = null;
    try {
      readyIssues = await mod.searchByLabels({ creds, labels: [args.projectLabel, 'ai-ready'], project: args.project });
    } catch (err) { readyErr = err; }

    // Source unavailable?
    if (awaitingErr || readyErr) {
      const err = awaitingErr || readyErr;
      if (err.code === 'AUTH_FAILED' || err.code === 'SOURCE_UNAVAILABLE') {
        printResult({ work: false, reason: 'unavailable', issue: null, pr: null, counts: { awaitingMerge: null, ready: null }, exitCode: 4 });
        return;
      }
    }

    // ---- Process awaiting-merge ----
    let result = null;

    for (const issue of awaitingIssues) {
      const ev = await evaluateAwaitingMergeIssue(issue, {
        repo: args.repo, baseBranch: args.baseBranch, ciGraceMinutes: args.ciGraceMinutes,
        searchByLabels: mod.searchByLabels, creds, ghSpawn: ghSpawn, env: e,
      });

      if (ev.err) {
        // gh unavailable — but check ready first? No: unavailable always wins
        printResult({ work: false, reason: 'unavailable', issue: null, pr: null, counts: { awaitingMerge: null, ready: readyIssues.length }, exitCode: 4 });
        return;
      }

      if (ev.prUnclear && !result) {
        result = {
          work: false, reason: 'pr_unclear',
          issue: { key: issue.key, summary: issue.summary, labels: issue.labels },
          pr: null,
          counts: { awaitingMerge: awaitingIssues.length, ready: readyIssues.length },
          exitCode: 4,
        };
        continue;
      }

      if (!ev.matched) continue; // no PR for this issue

      if (ev.prInfo) {
        result = {
          work: ev.work || false,
          reason: ev.reason,
          issue: ev.work ? { key: issue.key, summary: issue.summary, labels: issue.labels } : null,
          pr: ev.prInfo,
          counts: { awaitingMerge: awaitingIssues.length, ready: readyIssues.length },
          exitCode: (ev.work) ? 0 : (ev.reason === 'closing_ci_stuck' || ev.reason === 'pr_unclear' ? 4 : 3),
          ciRunId: ev.ciRunId,
        };
        break;
      }

      // matched but no prInfo (no mergedAt / mergeCommit) — skip this issue
    }

    // If we found a closeable item in awaiting-merge, apply the CI-failure policy.
    // After the policy, a non-closeable result (work: false) does NOT block
    // new work — continue to the ready check.
    if (result && result.work && result.reason === 'closing_ci_failed') {
      result = applyCiFailurePolicy(result, e, args.repo);
    }

    // If the result is still closeable, return it immediately
    if (result && result.work) {
      printResult(result);
      return;
    }

    // Non-closeable matched PRs (awaiting_merge, closing_ci_pending,
    // closing_ci_failed_handled) do NOT block new work — "открытый PR
    // не блокирует подхват другой готовой работы"
    // Continue to ready check.

    // If awaiting-merge produced pr_unclear or unavailable, return immediately
    if (result && (result.reason === 'pr_unclear' || result.reason === 'unavailable')) {
      printResult(result);
      return;
    }

    // ---- Process ready ----
    if (readyIssues.length > 0) {
      printResult({
        work: true, reason: 'ready',
        issue: { key: readyIssues[0].key, summary: readyIssues[0].summary, labels: readyIssues[0].labels },
        pr: null,
        counts: { awaitingMerge: awaitingIssues.length, ready: readyIssues.length },
        exitCode: 0,
      });
      return;
    }

    // ---- Return matched but non-closeable PR (awaiting_merge, closing_ci_pending, etc.) ----
    if (result) {
      printResult(result);
      return;
    }

    // ---- Nothing ----
    printResult({
      work: false, reason: 'none',
      issue: null, pr: null,
      counts: { awaitingMerge: awaitingIssues.length, ready: 0 },
      exitCode: 3,
    });
  } catch (err) {
    printResult({ work: false, reason: 'unavailable', issue: null, pr: null, counts: { awaitingMerge: null, ready: null }, exitCode: 4 });
  }
}

const _isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isDirectRun) main();
