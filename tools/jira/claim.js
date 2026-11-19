#!/usr/bin/env node
// claim.js — Mechanical gate guarding against repeated pickup.
//
// Returns exit code 0 only when the claim is confirmed via readback.
// Exit codes:
//   0 — claimed, readback confirmed
//   2 — usage error or issue not found
//   3 — ai-ready label absent (not ready to claim)
//   4 — work already exists (PR found, awaiting merge or without --adopt-existing)
//   5 — mutation succeeded but readback did not confirm
//   6 — source unavailable or authentication failed
//   7 — the mutation request itself failed (no readback was performed)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================================================
// Arg parsing
// ==========================================================================

const VALUE_FLAGS = {
  '--project': 'project',
  '--issue': 'issue',
  '--repo': 'repo',
  '--transition-id': 'transitionId',
  '--expect-status': 'expectStatus',
};

// An unknown argument, or a flag without a value, sets `invalid`: the caller asked for
// something other than what would run, so the gate must stop (code 2) instead of guessing.
function parseArgs(argv) {
  const a = {
    project: null,
    issue: null,
    repo: null,
    transitionId: null,
    expectStatus: null,
    adoptExisting: false,
    invalid: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--adopt-existing') { a.adoptExisting = true; continue; }
    const field = Object.prototype.hasOwnProperty.call(VALUE_FLAGS, x) ? VALUE_FLAGS[x] : null;
    const value = argv[i + 1];
    if (!field || value === undefined || value === '' || value.startsWith('--')) {
      a.invalid = true;
      break;
    }
    a[field] = value;
    i++;
  }
  return a;
}

// ==========================================================================
// ghSpawn — async child-process wrapper (same pattern as pickup.js)
// ==========================================================================

function ghSpawn(argv, env) {
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
// Output helper
// ==========================================================================

function exitJson(statusCode, body) {
  // `state` is mandatory in every output and equals `reason`.
  const out = { ...body };
  if (out.reason !== undefined) out.state = out.reason;
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(statusCode);
}

// ==========================================================================
// PR search — same pattern as pickup.js searchPrsByKey
// ==========================================================================

async function searchPrsByKey(key, repo, env) {
  const res = await ghSpawn(
    ['pr', 'list', '--repo', repo, '--search', key, '--state', 'all', '--json',
     'number,state,title,url', '--limit', '10'],
    env
  );
  // Only a readable list answers the question. Empty stdout, invalid JSON or a structure that is
  // not a list is a failed source (null), never "no PR": only a proper empty list means that.
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
  try {
    const data = JSON.parse(res.stdout);
    return Array.isArray(data) ? data : null;
  } catch { return null; }
}

// ==========================================================================
// Pure key-in-title check (same as pickup.js)
// ==========================================================================

function keyInTitle(key, title) {
  const escaped = key.replace(/[-/]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(title);
}

// ==========================================================================
// ciCheck — mandatory check-runs gate
// ==========================================================================

const CHECK_RUNS_PER_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 50;

function ciUnavailable(why) {
  const err = new Error('check-runs unavailable: ' + why);
  err.code = 'SOURCE_UNAVAILABLE';
  return err;
}

/**
 * The FULL set of check-runs of a SHA (every page). A failed or unreadable answer is a
 * failure of a mandatory source and throws SOURCE_UNAVAILABLE: it must never become an
 * empty list, because an unknown result is not a negative one.
 * (`gh api` has no --repo flag: the repository is part of the endpoint path.)
 */
export async function fetchCheckRunsForSha(sha, repo, env) {
  const all = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const res = await ghSpawn(
      ['api', 'repos/' + repo + '/commits/' + sha + '/check-runs',
       '--method', 'GET', '-F', 'per_page=' + CHECK_RUNS_PER_PAGE, '-F', 'page=' + page],
      env
    );
    if (res.status !== 0 || !res.stdout) throw ciUnavailable('gh api failed');
    let data;
    try { data = JSON.parse(res.stdout); } catch { throw ciUnavailable('unreadable response'); }
    if (Array.isArray(data)) return data; // already a flat list, nothing to page through
    if (!data || !Array.isArray(data.check_runs)) throw ciUnavailable('unexpected response');
    all.push(...data.check_runs);
    if (typeof data.total_count !== 'number' || all.length >= data.total_count || data.check_runs.length === 0) {
      return all;
    }
  }
  throw ciUnavailable('too many pages');
}

const DEFAULT_REQUIRED_CHECKS = ['Tests (ubuntu-latest)', 'Tests (windows-latest)'];

export function requiredChecks(env) {
  const raw = env && env.CLAIM_REQUIRED_CHECKS;
  if (typeof raw !== 'string') return DEFAULT_REQUIRED_CHECKS;
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * True only when EVERY required check is present, completed and successful.
 * Missing, queued, in_progress and any non-success conclusion are not green.
 */
export function allRequiredChecksGreen(runs, required) {
  if (!Array.isArray(runs) || required.length === 0) return false;
  return required.every((name) => runs.some(
    (r) => r && r.name === name && r.status === 'completed' && r.conclusion === 'success'
  ));
}

/**
 * Mandatory CI gate for a commit SHA via `gh api check-runs`.
 *
 * @returns {Promise<boolean>}
 */
export async function checkCiStatus(headSha, repo, env) {
  const runs = await fetchCheckRunsForSha(headSha, repo, env);
  return allRequiredChecksGreen(runs, requiredChecks(env));
}

// ==========================================================================
// Verdict SHA extraction from comments
// ==========================================================================

const VERDICT_RE = /^AI-REVIEW-VERDICT:\s*(ACCEPT|CHANGES_REQUIRED)\s+sha=([0-9a-fA-F]{40})\s+dispatch=(ctx_[^\s]+)\s+task=(task_[^\s]+)\s+run=(run_[^\s]+)\s*$/;

/**
 * Extract the verdict for the current PR head SHA from comments.
 *
 * Rules:
 * 1. Only consider comments authored by the gate's own account (from getMyself).
 * 2. Parse the full machine-format string; lines missing any of the three
 *    identifiers (dispatch, task, run) are ignored entirely.
 * 3. Among matching lines, select only those whose sha matches the current
 *    head PR (case-insensitive). Verdicts for other SHA are ignored.
 * 4. The last matching line in Jira order decides: ACCEPT is positive,
 *    CHANGES_REQUIRED is negative. An earlier ACCEPT does not override a
 *    later negative verdict.
 * 5. If no positive verdict exists → review_pending.
 * 6. If getMyself or the comment fetch failed, main() stops with code 6 before this
 *    function is reached: a failed source is not an empty list of comments.
 *
 * @param {Array<{ body: string, authorAccountId: string }>} comments — comment objects from getComments.
 * @param {string} accountId — the gate's own accountId from getMyself.
 * @param {string} headSha — current PR head SHA.
 * @returns {{ sha: string | null, verdict: string | null }}
 */
function extractVerdictSha(comments, accountId, headSha) {
  // 1. Filter to comments by the gate's own account
  const ownComments = comments.filter((c) => c.authorAccountId === accountId);

  // 2. Parse machine-format strings from own comments
  let lastVerdict = null; // { sha, verdict }
  for (const c of ownComments) {
    if (typeof c.body !== 'string') continue;
    // Search each line in the body
    const lines = c.body.split('\n');
    for (const line of lines) {
      const m = VERDICT_RE.exec(line);
      if (!m) continue;
      // m[1] = ACCEPT|CHANGES_REQUIRED, m[2] = sha, m[3] = dispatch, m[4] = task, m[5] = run
      const verdict = m[1];
      const sha = m[2];
      // 3. Only consider matching SHA
      if (sha.toLowerCase() === headSha.toLowerCase()) {
        lastVerdict = { sha, verdict };
      }
    }
  }

  return lastVerdict || { sha: null, verdict: null };
}

// ==========================================================================
// Label mutation helper
// ==========================================================================

// The label set to send: `remove` dropped, each `add` present exactly once.
function planLabels(beforeLabels, remove, add) {
  const after = beforeLabels.filter((l) => !remove.includes(l));
  for (const l of add) if (!after.includes(l)) after.push(l);
  return after;
}

function sameLabelSet(a, b) {
  return a.length === b.length && a.every((l) => b.includes(l));
}

async function mutateLabels({ creds, key, labels }) {
  const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
  await client.setLabels({ creds, key, labels });
}

// ==========================================================================
// Readback helper
// ==========================================================================

async function readIssueBack({ creds, key }) {
  const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
  return client.getIssue({ creds, key });
}

// Synchronous: the body does no I/O, and the call site uses the boolean directly.
function verifyReadback(readbackLabels, beforeLabels, mustContain, mustNotContain) {
  if (mustContain.some((l) => !readbackLabels.includes(l))) return false;
  if (mustNotContain.some((l) => readbackLabels.includes(l))) return false;
  // Every foreign label survives; labels the gate removed on purpose are not "foreign".
  for (const lb of beforeLabels) {
    if (lb === 'ai-ready' || mustNotContain.includes(lb)) continue;
    if (!readbackLabels.includes(lb)) return false;
  }
  return true;
}

// ==========================================================================
// Main logic
// ==========================================================================

export async function main({ argv, env } = {}) {
  const args = parseArgs(argv || process.argv.slice(2));
  const e = env || process.env;

  // --- Validate args ---
  if (args.invalid || !args.project || !args.issue || !args.repo) {
    exitJson(2, { success: false, reason: 'usage' });
  }

  if (args.transitionId && !args.expectStatus) {
    exitJson(2, { success: false, reason: 'usage' });
  }

  // --- Load credentials ---
  let creds;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
    creds = mod.loadCredentials(e);
  } catch (err) {
    if (err.code === 'SOURCE_UNAVAILABLE') {
      exitJson(6, { success: false, reason: 'source_unavailable' });
    }
    exitJson(6, { success: false, reason: 'source_unavailable' });
  }

  // --- Step 1: Read the issue ---
  let issue;
  try {
    const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
    issue = await client.getIssue({ creds, key: args.issue });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      exitJson(2, { success: false, reason: 'not_found' });
    }
    if (err.code === 'AUTH_FAILED' || err.code === 'SOURCE_UNAVAILABLE') {
      exitJson(6, { success: false, reason: 'source_unavailable' });
    }
    exitJson(6, { success: false, reason: 'source_unavailable' });
  }

  if (!issue) {
    exitJson(2, { success: false, reason: 'not_found' });
  }

  // --- Check ai-blocked: before any PR search or mutation ---
  if ((issue.fields && issue.fields.labels && issue.fields.labels.includes('ai-blocked')) ||
      (issue.labels && issue.labels.includes('ai-blocked'))) {
    exitJson(3, { success: false, reason: 'blocked', state: 'blocked' });
  }

  // --- Step 2: Check existing work BEFORE any mutations ---
  const labelsBefore = issue.labels || [];
  let prList;
  try {
    prList = await searchPrsByKey(args.issue, args.repo, e);
  } catch {
    exitJson(6, { success: false, reason: 'source_unavailable' });
  }

  if (prList === null) {
    exitJson(6, { success: false, reason: 'source_unavailable' });
  }

  // Look for OPEN or MERGED PR with matching issue key in title
  let foundPr = null;
  for (const pr of prList) {
    if ((pr.state === 'OPEN' || pr.state === 'MERGED') && keyInTitle(args.issue, pr.title)) {
      foundPr = pr;
      break;
    }
  }

  // ----------------------------------------------------------------
  // No PR found
  // ----------------------------------------------------------------
  if (!foundPr) {
    const hasReady = labelsBefore.includes('ai-ready');
    if (!hasReady) {
      // No PR, no ai-ready → code 3
      exitJson(3, { success: false, reason: 'not_ready' });
    }

    // No PR, has ai-ready → normal claim flow
    const labelsAfter = labelsBefore.filter((l) => l !== 'ai-ready');

    let setResult;
    try {
      const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
      await client.setLabels({ creds, key: args.issue, labels: labelsAfter });
      setResult = { ok: true };
    } catch (err) {
      if (err.code === 'AUTH_FAILED') {
        exitJson(6, { success: false, reason: 'source_unavailable' });
      }
      exitJson(7, { success: false, reason: 'mutation_failed' });
    }

    // Readback
    let issueReadback;
    try {
      const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
      issueReadback = await client.getIssue({ creds, key: args.issue });
    } catch {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }

    const readbackLabels = issueReadback.labels || [];
    if (readbackLabels.includes('ai-ready')) {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }
    for (const lb of labelsBefore) {
      if (lb === 'ai-ready') continue;
      if (!readbackLabels.includes(lb)) {
        exitJson(5, { success: false, reason: 'readback_failed' });
      }
    }

    // Transition (optional)
    const statusBefore = issue.status;
    if (args.transitionId) {
      try {
        const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
        await client.transition({ creds, key: args.issue, transitionId: args.transitionId });
      } catch (err) {
        if (err.code === 'AUTH_FAILED') {
          exitJson(6, { success: false, reason: 'source_unavailable' });
        }
        exitJson(7, { success: false, reason: 'mutation_failed' });
      }
      try {
        const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
        issueReadback = await client.getIssue({ creds, key: args.issue });
      } catch {
        exitJson(5, { success: false, reason: 'readback_failed' });
      }

      // If --expect-status was given, verify the actual status matches.
      if (args.expectStatus) {
        const actualName = typeof issueReadback.status === 'string'
          ? issueReadback.status
          : (issueReadback.status && issueReadback.status.name) || '';
        if (actualName.trim().toLowerCase() !== args.expectStatus.trim().toLowerCase()) {
          exitJson(5, { success: false, reason: 'readback_failed' });
        }
      }
    }

    exitJson(0, {
      success: true,
      reason: 'claimed',
      key: args.issue,
      summary: issueReadback.summary || '',
      labelsBefore: labelsBefore,
      labelsAfter: readbackLabels,
      statusBefore: statusBefore,
      statusAfter: issueReadback.status || '',
      claimedAt: new Date().toISOString(),
      pr: null,
      state: 'claimed',
      mode: 'implement',
    });
  }

  // ----------------------------------------------------------------
  // PR found
  // ----------------------------------------------------------------

  // Without --adopt-existing: return code 4, no mutations
  if (!args.adoptExisting) {
    // work_exists carries no `mode`: the decision to continue belongs to the caller,
    // and a permissive mode in a refusal would read as permission.
    exitJson(4, {
      success: false,
      reason: 'work_exists',
      adopted: false,
      labelsBefore: labelsBefore,
      labelsAfter: labelsBefore,
      pr: { number: foundPr.number, state: foundPr.state, url: foundPr.url, headSha: null },
      readiness: null,
    });
  }

  // With --adopt-existing: query gh pr view for status check
  const prViewRes = await ghSpawn(
    ['pr', 'view', String(foundPr.number), '--repo', args.repo, '--json', 'number,state,headRefOid,statusCheckRollup'],
    e
  );

  if (prViewRes.status !== 0) {
    // gh pr view failed → source_unavailable, zero mutations
    exitJson(6, {
      success: false,
      reason: 'source_unavailable',
      adopted: false,
      labelsBefore: labelsBefore,
      labelsAfter: labelsBefore,
      pr: { number: foundPr.number, state: foundPr.state, url: foundPr.url, headSha: null },
      readiness: null,
    });
  }

  let prView;
  try {
    prView = JSON.parse(prViewRes.stdout);
  } catch {
    // JSON parse failed → source_unavailable, zero mutations
    exitJson(6, {
      success: false,
      reason: 'source_unavailable',
      adopted: false,
      labelsBefore: labelsBefore,
      labelsAfter: labelsBefore,
      pr: { number: foundPr.number, state: foundPr.state, url: foundPr.url, headSha: null },
      readiness: null,
    });
  }

  const headRefOid = prView.headRefOid || null;
  const statusCheckRollup = prView.statusCheckRollup || null;

  // ----------------------------------------------------------------
  // Determine readiness
  // ----------------------------------------------------------------
  let verdictSha = null;
  let ciStatus = null; // null until a positive verdict triggers the CI request
  let confirmed = false;

  // A merged PR needs no verdict, no comments and no CI: merge was done by a human.
  // For an open PR every source is read BEFORE the first mutation, and a failed source
  // stops the gate (code 6) instead of being treated as an empty result.
  if (foundPr.state !== 'MERGED') {
    let accountId = null;
    let comments = [];
    try {
      const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
      const myself = await client.getMyself({ creds });
      accountId = myself.accountId;
      comments = await client.getComments({ creds, key: args.issue });
    } catch {
      exitJson(6, { success: false, reason: 'source_unavailable' });
    }

    if (comments.length > 0 && headRefOid && accountId) {
      const result = extractVerdictSha(comments, accountId, headRefOid);
      verdictSha = result.sha;
      if (result.verdict === 'ACCEPT') {
        try {
          ciStatus = await checkCiStatus(headRefOid, args.repo, e);
        } catch {
          exitJson(6, { success: false, reason: 'source_unavailable' });
        }
        if (verdictSha && verdictSha.toLowerCase() === headRefOid.toLowerCase() && ciStatus === true) {
          confirmed = true;
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // Build state table
  // ----------------------------------------------------------------
  let state;
  let mode;
  let targetLabel;
  let removeLabels;

  if (foundPr.state === 'MERGED') {
    state = 'closing';
    mode = 'close';
    targetLabel = 'ai-awaiting-merge';
    removeLabels = ['ai-ready', 'ai-in-review'];
  } else if (confirmed) {
    state = 'awaiting_merge';
    mode = null;
    targetLabel = 'ai-awaiting-merge';
    removeLabels = ['ai-ready', 'ai-in-review'];
  } else {
    // OPEN, not confirmed
    state = 'review_pending';
    mode = 'review';
    targetLabel = 'ai-in-review';
    removeLabels = ['ai-ready', 'ai-awaiting-merge'];
  }

  // readiness.ci: null — CI не запрашивался (нет ACCEPT для этого SHA);
  // false — запрашивался, не все прошли; true — все прошли.
  const readinessCi = ciStatus;

  const readiness = {
    verdictSha: verdictSha,
    headSha: headRefOid,
    ci: readinessCi,
  };

  // ----------------------------------------------------------------
  // If merged, exit code 0
  // If awaiting_merge, exit code 4
  // If review_pending, exit code 0 (continue processing)
  // ----------------------------------------------------------------
  let exitCode;
  if (state === 'closing') {
    exitCode = 0;
  } else if (state === 'awaiting_merge') {
    exitCode = 4;
  } else {
    exitCode = 0;
  }

  // ----------------------------------------------------------------
  // Perform label mutation
  // ----------------------------------------------------------------
  const plannedLabels = planLabels(labelsBefore, removeLabels, [targetLabel]);
  let readbackLabels;

  if (sameLabelSet(plannedLabels, labelsBefore)) {
    // Nothing to change: no change request and nothing to confirm by readback.
    readbackLabels = labelsBefore;
  } else {
    try {
      await mutateLabels({ creds, key: args.issue, labels: plannedLabels });
    } catch (err) {
      if (err.code === 'AUTH_FAILED') {
        exitJson(6, { success: false, reason: 'source_unavailable' });
      }
      exitJson(7, { success: false, reason: 'mutation_failed' });
    }

    // ----------------------------------------------------------------
    // Readback verification
    // ----------------------------------------------------------------
    let issueReadback;
    try {
      issueReadback = await readIssueBack({ creds, key: args.issue });
    } catch {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }

    readbackLabels = issueReadback.labels || [];

    if (!verifyReadback(readbackLabels, labelsBefore, [targetLabel], removeLabels)) {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }
  }

  exitJson(exitCode, {
    success: exitCode === 0,
    reason: state,
    adopted: true,
    state: state,
    mode: mode,
    labelsBefore: labelsBefore,
    labelsAfter: readbackLabels,
    pr: { number: foundPr.number, state: foundPr.state, url: foundPr.url, headSha: headRefOid },
    readiness: readiness,
  });
}

// ==========================================================================
// CLI entry
// ==========================================================================

const _isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isDirectRun) main();
