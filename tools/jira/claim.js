#!/usr/bin/env node
// claim.js — Mechanical gate guarding against repeated pickup.
//
// Returns exit code 0 only when the claim is confirmed via readback.
// Exit codes:
//   0 — claimed, readback confirmed
//   2 — usage error or issue not found
//   3 — ai-ready label absent (not ready to claim)
//   4 — work already exists (PR found)
//   5 — mutation succeeded but readback did not confirm
//   6 — source unavailable or authentication failed

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================================================
// Arg parsing
// ==========================================================================

function parseArgs(argv) {
  const a = {
    project: null,
    issue: null,
    repo: null,
    transitionId: null,
    adoptExisting: false,
  };
  let i = 0;
  while (i < argv.length) {
    const x = argv[i];
    if (x === '--project' && i + 1 < argv.length) { a.project = argv[++i]; i++; continue; }
    if (x === '--issue' && i + 1 < argv.length) { a.issue = argv[++i]; i++; continue; }
    if (x === '--repo' && i + 1 < argv.length) { a.repo = argv[++i]; i++; continue; }
    if (x === '--transition-id' && i + 1 < argv.length) { a.transitionId = argv[++i]; i++; continue; }
    if (x === '--adopt-existing') { a.adoptExisting = true; i++; continue; }
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
  process.stdout.write(JSON.stringify(body) + '\n');
  process.exit(statusCode);
}

// ==========================================================================
// PR search — same pattern as pickup.js searchPrsByKey
// ==========================================================================

async function searchPrsByKey(key, repo, env) {
  const res = await ghSpawn(
    ['pr', 'list', '--search', key, '--state', 'all', '--json',
     'number,state,title,url', '--limit', '10'],
    env
  );
  if (res.status !== 0) return null;
  try { return JSON.parse(res.stdout) || []; } catch { return []; }
}

// ==========================================================================
// Pure key-in-title check (same as pickup.js)
// ==========================================================================

function keyInTitle(key, title) {
  const escaped = key.replace(/[-/]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(title);
}

// ==========================================================================
// Main logic
// ==========================================================================

export async function main({ argv, env } = {}) {
  const args = parseArgs(argv || process.argv.slice(2));
  const e = env || process.env;

  // --- Validate args ---
  if (!args.project || !args.issue || !args.repo) {
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
  for (const pr of prList) {
    if ((pr.state === 'OPEN' || pr.state === 'MERGED') && keyInTitle(args.issue, pr.title)) {
      // Without --adopt-existing: return code 4, no mutations
      if (!args.adoptExisting) {
        exitJson(4, { success: false, reason: 'work_exists', pr: { number: pr.number, state: pr.state, url: pr.url } });
      }

      // With --adopt-existing: remove ai-ready, add ai-awaiting-merge, keep other labels
      const labelsAfter = labelsBefore.map((l) => (l === 'ai-ready' ? 'ai-awaiting-merge' : l));

      let setResult;
      try {
        const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
        await client.setLabels({ creds, key: args.issue, labels: labelsAfter });
        setResult = { ok: true };
      } catch (err) {
        if (err.code === 'AUTH_FAILED' || err.code === 'SOURCE_UNAVAILABLE') {
          exitJson(6, { success: false, reason: 'source_unavailable' });
        }
        exitJson(5, { success: false, reason: 'readback_failed' });
      }

      // Readback — verify labels
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
      if (!readbackLabels.includes('ai-awaiting-merge')) {
        exitJson(5, { success: false, reason: 'readback_failed' });
      }
      for (const lb of labelsBefore) {
        if (lb === 'ai-ready') continue;
        if (!readbackLabels.includes(lb)) {
          exitJson(5, { success: false, reason: 'readback_failed' });
        }
      }

      exitJson(4, {
        success: false,
        reason: 'work_exists',
        adopted: true,
        labelsBefore: labelsBefore,
        labelsAfter: readbackLabels,
        pr: { number: pr.number, state: pr.state, url: pr.url },
      });
    }
  }

  // --- Step 3: Check ai-ready label ---
  const hasReady = labelsBefore.includes('ai-ready');
  if (!hasReady) {
    exitJson(3, { success: false, reason: 'not_ready' });
  }

  // --- Step 4: Remove ai-ready, keeping other labels ---
  const labelsAfter = labelsBefore.filter((l) => l !== 'ai-ready');

  let setResult;
  try {
    const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
    await client.setLabels({ creds, key: args.issue, labels: labelsAfter });
    setResult = { ok: true };
  } catch (err) {
    if (err.code === 'AUTH_FAILED' || err.code === 'SOURCE_UNAVAILABLE') {
      exitJson(6, { success: false, reason: 'source_unavailable' });
    }
    exitJson(5, { success: false, reason: 'readback_failed' });
  }

  // --- Step 4b: Readback — verify ai-ready is gone and other labels remain ---
  let issueReadback;
  try {
    const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
    issueReadback = await client.getIssue({ creds, key: args.issue });
  } catch (err) {
    exitJson(5, { success: false, reason: 'readback_failed' });
  }

  const readbackLabels = issueReadback.labels || [];
  const readbackHasReady = readbackLabels.includes('ai-ready');

  if (readbackHasReady) {
    exitJson(5, { success: false, reason: 'readback_failed' });
  }

  // Check that all previous labels (except ai-ready) are still present
  for (const lb of labelsBefore) {
    if (lb === 'ai-ready') continue;
    if (!readbackLabels.includes(lb)) {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }
  }

  // --- Step 5: Transition (optional) ---
  const statusBefore = issue.status;
  if (args.transitionId) {
    try {
      const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
      await client.transition({ creds, key: args.issue, transitionId: args.transitionId });
    } catch (err) {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }

    // Readback status
    let issueStatusReadback;
    try {
      const client = await import(pathToFileURL(path.join(__dirname, 'client.js')).href);
      issueStatusReadback = await client.getIssue({ creds, key: args.issue });
    } catch {
      exitJson(5, { success: false, reason: 'readback_failed' });
    }

    if (issueStatusReadback.status !== issueReadback.status) {
      // Update our local readback to the latest
      issueReadback = issueStatusReadback;
    }
  }

  // --- Step 6: Print claim summary (exit code 0) ---
  exitJson(0, {
    success: true,
    key: args.issue,
    summary: issueReadback.summary || '',
    labelsBefore: labelsBefore,
    labelsAfter: readbackLabels,
    statusBefore: statusBefore,
    statusAfter: issueReadback.status || '',
    claimedAt: new Date().toISOString(),
    pr: null,
  });
}

// ==========================================================================
// CLI entry
// ==========================================================================

const _isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isDirectRun) main();
