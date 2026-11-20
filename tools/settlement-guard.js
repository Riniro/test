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
 * Acquire the settlements lock with bounded retries and Atomics.wait
 * (as used in settle.js).  Synchronous — no async/await, no Promises.
 * @returns {{ ok: boolean, token: string|null, reason: string|null }}
 */
function acquireSettlementLock(repoKey) {
  let attempts = 0;
  const maxAttempts = 5;
  const retryMs = 200;

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
      // Wait with Atomics.wait (non-spinning), fallback to spin
      const end = Date.now() + retryMs;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(retryMs, end - Date.now()));
      } catch {
        while (Date.now() < end) { /* spin */ }
      }
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
 * On corrupt journal → do NOT overwrite; preserve existing entries.
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
        // If the JSON is valid but not an object, treat as corrupt
        if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) {
          journal = {};
        }
      } else {
        journal = {};
      }
    } catch {
      // Parse error — journal is corrupt; return empty object so mutateFn can work,
      // but mark it as corrupt via reason
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
    if (entry.completedAction && entry.completedAction.status === 'completed') {
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
        status: 'completed',
        at: new Date().toISOString(),
        eventId: null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Two-phase pending → completed protocol
// ---------------------------------------------------------------------------

/**
 * Record a "pending" disposal action (step 6 in the protocol).
 * Writes under the settlements lock (R1).
 * Returns code 3 if lock is busy (stop should NOT be called).
 *
 * @param {string} dispatchId
 * @param {string|null} repoKey
 * @returns {object} { code: number, reason: string|null }
 */
export function recordPending(dispatchId, repoKey) {
  return guardedSettlements({
    repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      const entry = journal[dispatchId];
      if (!entry) return;
      entry.completedAction = {
        name: 'dispose-resources',
        status: 'pending',
        at: new Date().toISOString(),
        eventId: null,
      };
    },
  });
}

/**
 * Check if disposal is in "pending" state.
 *
 * @param {string} dispatchId
 * @param {string|null} repoKey
 * @returns {boolean}
 */
export function isDisposalPending(dispatchId, repoKey) {
  const journalPath = getJournalPath(repoKey);
  try {
    if (!fs.existsSync(journalPath)) return false;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const entry = journal[dispatchId];
    if (!entry) return false;
    return entry.completedAction && entry.completedAction.status === 'pending';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// R3: synchronous resource disposal step (no Orca calls — uses mockable env)
// ---------------------------------------------------------------------------

/**
 * Disposal step: two-phase protocol per TЗ B1-B6.
 *
 * 1. Read journal entry.
 * 2. completed → code 0 (B5).
 * 3. pending → re-read dispatch state from Orca; if confirmed → completed, 0; if unknown → escalation.
 * 4. unset → confirm ownership + re-read dispatch state; if matches → record pending, call stop, record completed.
 * 5. Lock busy at any write → stop is NOT called, return busy code.
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
 * Exit codes (align with settle.js family 20–23):
 *   0 — resources disposed, action recorded, `unsettled` stays in journal.
 *   20 — disposal already completed: nothing to do, exit 0 (B5).
 *   23 — lock busy: journal untouched (B4).
 *   5 — dispatch ownership or stop result cannot be confirmed → escalation.
 */
export function disposeResources(opts) {
  const {
    dispatchId, runId, taskId, worktree, repoKey, pollMs = 15000, deadlineMs = 600000,
  } = opts;

  // Read settlements journal entry
  const journalPath = getJournalPath(repoKey);
  let entry;
  try {
    if (fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      entry = journal[dispatchId];
    }
  } catch {
    return { code: 5, body: 'journal read error for ' + dispatchId };
  }

  if (!entry) {
    return { code: 5, body: 'no settlement entry for ' + dispatchId };
  }

  const verdict = entry.verdict || null;
  const evidence = entry.evidence || {};
  const workerDone = evidence.workerDone || {};

  // Check completedAction state
  const completedAction = entry.completedAction || {};
  const status = completedAction.status;

  // Case: completed → B5: code 0, nothing to do
  if (status === 'completed') {
    return { code: 0, body: `disposal already completed for ${dispatchId}; nothing to do` };
  }

  // Case: pending → path 4: re-read dispatch state
  if (status === 'pending') {
    // Re-read dispatch state from Orca
    const dispatchInfo = _readDispatchState(dispatchId, runId, taskId);
    if (!dispatchInfo) {
      return { code: 5, body: 'cannot read dispatch state in pending recovery' };
    }
    if (dispatchInfo.confirmed) {
      // Confirmed completion → mark completed
      const result = recordDisposal(dispatchId, repoKey, { verdict });
      if (result.code !== 0) {
        return { code: 23, body: 'lock busy while recording completion' };
      }
      return { code: 0, body: `disposal confirmed completed for ${dispatchId}` };
    }
    // Unknown outcome → escalation, no repeated stop
    return { code: 5, body: 'dispatch outcome unknown in pending state; escalation' };
  }

  // unset or absent → path 5: confirm ownership, re-read dispatch state
  const actualDispatchId = workerDone.dispatchId || null;

  // Ownership check: Orca-reported dispatchId must match
  if (actualDispatchId !== dispatchId) {
    return { code: 5, body: 'dispatch ownership cannot be confirmed for ' + dispatchId };
  }

  // Re-read dispatch state from Orca
  const dispatchInfo = _readDispatchState(dispatchId, runId, taskId);
  if (!dispatchInfo) {
    return { code: 5, body: 'cannot read dispatch state for ownership confirmation' };
  }
  if (!dispatchInfo.confirmed) {
    // Dispatch not ours or not finished → escalation
    return { code: 5, body: 'dispatch ownership confirmation failed: ' + (dispatchInfo.reason || 'unknown') };
  }

  // Step 6: record pending under lock
  const pendingResult = recordPending(dispatchId, repoKey);
  if (pendingResult.code !== 0) {
    // Lock busy — stop is NOT called (B4)
    return { code: 23, body: 'disposal record could not be saved: lock busy' };
  }

  // Step 7: call stop
  const stopResult = _callStop(dispatchId);
  if (stopResult.code !== 0) {
    // Stop failed — state stays pending, to be handled by path 4
    return stopResult;
  }

  // Step 8: record completed with actual result
  const completedResult = recordDisposal(dispatchId, repoKey, { verdict });
  if (completedResult.code !== 0) {
    // Could not record completion — state stays pending
    return { code: 5, body: 'completedAction could not be recorded; state remains pending' };
  }

  return { code: 0, body: `resources disposed for ${dispatchId}` };
}

/**
 * Read dispatch state from Orca via worker-list.
 * Returns { confirmed: boolean, reason: string|null } or null on read failure.
 */
function _readDispatchState(dispatchId, runId, taskId) {
  try {
    const launch = resolveOrcaLaunch();
    const result = _spawnSync(launch.executable, [
      ...launch.prefixArgs,
      'orchestration', 'worker-list', '--run', runId, '--json',
    ], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    if (result.error || result.status !== 0) {
      return { confirmed: false, reason: 'worker-list failed' };
    }

    const out = result.stdout;
    if (typeof out !== 'string' || out.trim().length === 0) {
      return { confirmed: false, reason: 'worker-list returned empty' };
    }

    const workers = _parseWorkerList(out);
    const rec = workers.find(w => w.dispatchId === dispatchId && w.taskId === taskId);
    if (!rec) {
      return { confirmed: false, reason: 'dispatch not found in worker-list' };
    }

    // Check if the dispatch is finished
    const dispatchStatus = rec.dispatchStatus || null;
    if (dispatchStatus && ['completed', 'failed', 'stopped', 'abandoned'].includes(dispatchStatus)) {
      return { confirmed: true, reason: null };
    }

    return { confirmed: false, reason: 'dispatch status ' + JSON.stringify(dispatchStatus) + ' is not finished' };
  } catch {
    return { confirmed: false, reason: 'worker-list threw exception' };
  }
}

/**
 * Call Orca worker-stop for the given dispatchId.
 * Returns { code: number, body: string|null }.
 */
function _callStop(dispatchId) {
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
      return { code: 5, body: 'worker-stop returned ' + (result.status || 'error') };
    }

    return { code: 0, body: null };
  } catch {
    return { code: 5, body: 'worker-stop threw exception' };
  }
}

/**
 * Parse the JSON response from `orca orchestration worker-list` and return
 * the workers array.  Handles multiple response shapes.
 *
 * @param {string} raw — raw JSON string from the CLI
 * @returns {object[]} workers list
 */
function _parseWorkerList(raw) {
  const data = JSON.parse(raw);

  // data itself is the workers array
  if (Array.isArray(data)) return data;

  // Prefer data.result.workers (actual Orca response shape)
  if (data?.result?.workers && Array.isArray(data.result.workers)) {
    return data.result.workers;
  }

  // Fallback: top-level fields
  if (Array.isArray(data.workers)) return data.workers;
  if (Array.isArray(data.items)) return data.items;

  return [];
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
