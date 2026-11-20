// settlement-guard.js — settlement journal locking, idempotency, and resource disposal step.
//
// This module is imported by settle.js (the watch command).  It does not
// depend on live Orca / Jira / GitHub: only on fs and lock.js from the same
// directory.
//
// R1. Guard the read→mutate→write cycle of settlements.json with a dedicated
//     lock.  If the lock cannot be acquired → journal is never touched; a
//     diagnostic code is returned.
//
// R2.  Idempotency: a record of the completed resource-disposal action lives
//      in the same settlements.json file under the same lock.  Re-delivery of
//      the same worker_done does not repeat disposal.
//
// R3.  A separate "settle-dispose" step that, given a dispatchId, re-reads
//      dispatch state, stops its own resources only, and marks the action
//      under lock.

import fs from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import * as lock from './coordinator/lock.js';

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

/**
 * settlements.json lives next to the coordinator journal.
 * The lock uses a dedicated repoKey suffix so it never collides with
 * the route lock that cli.js start holds for the entire executor lifetime.
 */
const SETTLEMENTS_LOCK_KEY = 'settlements-guard';

function getJournalPath(repoKey) {
  const stateDir = process.env.COORDINATOR_STATE_DIR || join(os.homedir(), '.claude-coordinator');
  const repo = repoKey || 'default';
  return join(stateDir, repo, 'settlements.json');
}

// ---------------------------------------------------------------------------
// R1: synchronous guarded journal access
// ---------------------------------------------------------------------------

/**
 * Acquire the settlements lock with bounded retries.
 * Synchronous — no async/await, no Promises.
 * @returns {{ ok: boolean, token: string|null, reason: string|null }}
 */
function acquireSettlementLock(repoKey) {
  let attempts = 0;
  const maxAttempts = 5;
  const retryMs = 50;

  while (attempts < maxAttempts) {
    const res = lock.acquire({
      stateDir: process.env.COORDINATOR_STATE_DIR || join(os.homedir(), '.claude-coordinator'),
      repoKey: SETTLEMENTS_LOCK_KEY,
    });

    if (res.ok) {
      return { ok: true, token: res.token, reason: null };
    }

    attempts++;
    if (attempts < maxAttempts) {
      // Busy-wait: spin for retryMs milliseconds
      const end = Date.now() + retryMs;
      while (Date.now() < end) { /* spin */ }
    }
  }

  return { ok: false, token: null, reason: 'BUSY' };
}

/**
 * Release the settlements lock.
 */
function releaseSettlementLock(repoKey, token) {
  return lock.release({
    stateDir: process.env.COORDINATOR_STATE_DIR || join(os.homedir(), '.claude-coordinator'),
    repoKey: SETTLEMENTS_LOCK_KEY,
    token,
  });
}

/**
 * Read, mutate, and write the settlements journal under lock.
 *
 * @param {object}   opts
 * @param {string}   opts.repoKey
 * @param {function} opts.mutateFn — receives the parsed journal object, may mutate it in place.
 * @param {boolean}  opts.lockRequired — if true and lock cannot be acquired, returns GLOCKED.
 * @returns {object} { code: number, journal: object|null, reason: string|null }
 *   code 0 — success, journal is the updated state.
 *   code 3 — lock busy: journal was not touched.
 */
export function guardedSettlements(opts) {
  const { repoKey, mutateFn, lockRequired = true } = opts;
  const journalPath = getJournalPath(repoKey);

  const lockRes = acquireSettlementLock(repoKey);

  if (!lockRes.ok) {
    // R1: if lock cannot be acquired, do NOT touch the journal at all
    if (lockRequired) {
      return { code: 3, journal: null, reason: 'LOCK_BUSY' };
    }
    // Non-strict mode: proceed without lock (tests only)
  }

  try {
    // Read
    let journal;
    try {
      if (fs.existsSync(journalPath)) {
        journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      } else {
        journal = {};
      }
    } catch {
      journal = {};
    }

    // Mutate
    mutateFn(journal);

    // Write (atomic)
    const dir = join(journalPath, '..');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = journalPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf8');
    fs.renameSync(tmp, journalPath);

    return { code: 0, journal, reason: null };
  } catch (err) {
    // R1: on any error, release lock and return diagnostic
    if (lockRes.ok) {
      releaseSettlementLock(repoKey, lockRes.token);
    }
    return { code: 3, journal: null, reason: 'LOCK_ERROR' };
  } finally {
    if (lockRes.ok) {
      releaseSettlementLock(repoKey, lockRes.token);
    }
  }
}

// ---------------------------------------------------------------------------
// R2: idempotency — action record
// ---------------------------------------------------------------------------

/**
 * Check whether disposal for a given dispatchId has already been performed.
 *
 * @param {string} dispatchId
 * @param {string|null} repoKey
 * @returns {boolean}
 */
export function isDisposalCompleted(dispatchId, repoKey) {
  const journalPath = getJournalPath(repoKey);
  try {
    if (!fs.existsSync(journalPath)) return false;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const entry = journal[dispatchId];
    if (!entry) return false;
    // completedAction exists and is not "pending"
    if (entry.completedAction && entry.completedAction !== 'pending') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Record that disposal for a dispatchId has been performed.
 *
 * Writes under the settlements lock (R1).
 *
 * @param {string} dispatchId
 * @param {string|null} repoKey
 * @param {object}   opts
 * @param {string} opts.verdict — the verdict that triggered disposal.
 * @returns {object} { code: number, reason: string|null }
 */
export function recordDisposal(dispatchId, repoKey, opts) {
  const { verdict } = opts;
  return guardedSettlements({
    repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      const entry = journal[dispatchId];
      if (!entry) return;
      entry.completedAction = {
        name: 'dispose-resources',
        verdict,
        at: new Date().toISOString(),
        eventId: null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// R3: synchronous resource disposal step (no Orca calls — uses mockable env)
// ---------------------------------------------------------------------------

/**
 * Disposal step: re-read dispatch state, stop its own resources, mark action.
 *
 * NOTE: In production this module calls `orca orchestration worker-list` and
 * `orca orchestration worker-stop` via the resolveOrcaLaunch helpers.  Tests
 * override SETTLE_ORCA_EXEC / SETTLE_ORCA_PREFIX_ARGS_JSON to inject stubs.
 *
 * @param {object}   opts
 * @param {string}   opts.dispatchId
 * @param {string}   opts.runId
 * @param {string}   opts.taskId
 * @param {string}   opts.worktree
 * @param {string|null} opts.repoKey
 * @param {number}   opts.pollMs
 * @param {number}   opts.deadlineMs
 * @returns {object} { code: number, body: string|null }
 *
 * Exit codes:
 *   0 — resources disposed, action recorded, `unsettled` stays in journal.
 *   4 — disposal already completed (R2 in action): nothing to do, exit 0.
 *   5 — dispatch ownership or stop result cannot be confirmed → escalation.
 *   3 — lock busy: journal untouched.
 */
export function disposeResources(opts) {
  const {
    dispatchId, runId, taskId, worktree, repoKey, pollMs = 15000, deadlineMs = 600000,
  } = opts;

  // R2: check if already completed
  if (isDisposalCompleted(dispatchId, repoKey)) {
    return { code: 4, body: `disposal already completed for ${dispatchId}; nothing to do` };
  }

  // Read settlements journal entry
  const journalPath = getJournalPath(repoKey);
  let entry;
  try {
    if (fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      entry = journal[dispatchId];
    }
  } catch { /* ignore */ }

  if (!entry) {
    return { code: 5, body: `no settlement entry for ${dispatchId}` };
  }

  const verdict = entry.verdict || null;
  const evidence = entry.evidence || {};
  const workerDone = evidence.workerDone || {};

  // R3: confirm dispatch belongs to this run
  const actualDispatchId = workerDone.dispatchId || null;
  if (actualDispatchId !== dispatchId) {
    return { code: 5, body: `dispatch ownership cannot be confirmed for ${dispatchId}` };
  }

  // Simulate worker-stop for this dispatch
  // In production: orca orchestration worker-stop --dispatch <dispatchId>
  try {
    const launch = resolveOrcaLaunch();
    const result = _spawnSync(launch.executable, [
      ...launch.prefixArgs,
      'orchestration', 'worker-stop', '--dispatch', dispatchId,
    ], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 30000,
    });

    if (result.error || result.status !== 0) {
      // Cannot confirm stop result → escalation
      return { code: 5, body: `worker-stop returned ${result.status || 'error'}` };
    }
  } catch {
    return { code: 5, body: 'worker-stop threw exception' };
  }

  // Mark action as completed under lock (R1)
  const recordResult = recordDisposal(dispatchId, repoKey, { verdict });

  if (recordResult.code !== 0) {
    // Lock busy — action not recorded.  This is the R1 diagnostic case.
    return { code: 3, body: 'disposal record could not be saved: lock busy' };
  }

  return { code: 0, body: `resources disposed for ${dispatchId}` };
}

// ---------------------------------------------------------------------------
// Orca launch helpers
// ---------------------------------------------------------------------------

import { spawnSync as _spawnSync } from 'node:child_process';

function resolveOrcaLaunch(env = process.env) {
  const executable = env.SETTLE_ORCA_EXEC || 'orca';

  let prefixArgs = [];
  const raw = env.SETTLE_ORCA_PREFIX_ARGS_JSON;
  if (raw !== undefined && raw !== '') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { executable, prefixArgs: [] };
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      return { executable, prefixArgs: [] };
    }
    prefixArgs = parsed;
  }

  return { executable, prefixArgs };
}
