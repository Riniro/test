// find-pr.js — read-only lookup of the PR linked to a Jira issue.
//
// Shared by claim.js (the gate) and the coordinator's precheck. It only reads:
// `gh pr list --search …` and `gh pr view … --json`. It never mutates anything.
//
// The `gh` executable can be replaced for tests with PICKUP_GH_EXEC / PICKUP_GH_PREFIX_ARGS_JSON.

import { spawnSync } from 'node:child_process';

/** Async-looking wrapper around spawnSync, so callers can `await` it. */
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

export async function searchPrsByKey(key, repo, env) {
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

export function keyInTitle(key, title) {
  const escaped = key.replace(/[-/]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(title);
}

/** First OPEN or MERGED PR whose title carries the issue key; null when there is none. */
export function pickLinkedPr(key, prList) {
  for (const pr of prList) {
    if ((pr.state === 'OPEN' || pr.state === 'MERGED') && keyInTitle(key, pr.title)) return pr;
  }
  return null;
}

/**
 * Finds the PR linked to an issue and reads its current head.
 * @returns {Promise<{ ok: true, pr: null | { number, url, headSha } } | { ok: false, reason: string }>}
 *   `ok: false` means a source failed — that is NOT "no PR".
 */
export async function findLinkedPr({ key, repo, env }) {
  let prList;
  try {
    prList = await searchPrsByKey(key, repo, env);
  } catch {
    return { ok: false, reason: 'search_failed' };
  }
  if (prList === null) return { ok: false, reason: 'search_failed' };
  const found = pickLinkedPr(key, prList);
  if (!found) return { ok: true, pr: null };

  const view = await ghSpawn(
    ['pr', 'view', String(found.number), '--repo', repo, '--json', 'number,state,headRefOid'],
    env
  );
  if (view.status !== 0) return { ok: false, reason: 'view_failed' };
  let data = null;
  try { data = JSON.parse(view.stdout); } catch { data = null; }
  const usable = data !== null && typeof data === 'object' && !Array.isArray(data)
    && (data.number !== undefined || data.state !== undefined);
  if (!usable) return { ok: false, reason: 'view_unusable' };
  const headSha = typeof data.headRefOid === 'string' && data.headRefOid ? data.headRefOid : null;
  return { ok: true, pr: { number: found.number, url: found.url === undefined ? null : found.url, headSha } };
}
