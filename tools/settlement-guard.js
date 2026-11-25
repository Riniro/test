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

// Result codes.  The busy code is the SAME everywhere busy is reported — in
// this module, in settle.js and in the CLI — so that a caller never has to
// know which layer refused (B6).
export const CODE_OK = 0;
export const CODE_ESCALATE = 5;
export const CODE_LOCK_BUSY = 23;
export const CODE_JOURNAL_CORRUPT = 24;
export const CODE_IO_ERROR = 25;

function stateDirPath() {
  return process.env.COORDINATOR_STATE_DIR || join(os.homedir(), '.claude-coordinator');
}

function getJournalPath(repoKey) {
  const repo = repoKey || 'default';
  return join(stateDirPath(), repo, 'settlements.json');
}

// ---------------------------------------------------------------------------
// Signal safety
// ---------------------------------------------------------------------------
//
// While this process holds the settlements lock, SIGINT and SIGTERM are
// intercepted so that an ordinary interruption releases the lock instead of
// leaving it behind.  The handlers are installed only while a lock is held and
// removed as soon as the last one is released, so importing this module does
// not change the signal behaviour of a process that is not writing.
//
// Not covered: a stop that cannot run JavaScript at all (SIGKILL, a hard
// reset, a lost machine).  See RECOVERY_AFTER_CRASH at the end of this file —
// recovery there is a deliberate operator action, never an automatic release
// of a lock that may still belong to a living process.

const heldLocks = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM'];
const signalHandlers = new Map();

function releaseAllHeldLocks() {
  for (const token of [...heldLocks]) {
    try {
      lock.release({ stateDir: stateDirPath(), repoKey: SETTLEMENTS_LOCK_KEY, token });
    } catch { /* best effort: we are on our way out */ }
    heldLocks.delete(token);
  }
}

function uninstallSignalHandlers() {
  for (const sig of [...signalHandlers.keys()]) {
    try { process.off(sig, signalHandlers.get(sig)); } catch { /* ignore */ }
    signalHandlers.delete(sig);
  }
}

function installSignalHandlers() {
  if (signalHandlers.size > 0) return;
  for (const sig of SIGNALS) {
    const handler = () => {
      releaseAllHeldLocks();
      uninstallSignalHandlers();
      // Re-raise with the default disposition so the exit status stays honest.
      try { process.kill(process.pid, sig); } catch { process.exit(1); }
    };
    signalHandlers.set(sig, handler);
    try { process.on(sig, handler); } catch { signalHandlers.delete(sig); }
  }
}

// ---------------------------------------------------------------------------
// R1: synchronous guarded journal access
// ---------------------------------------------------------------------------

/**
 * Acquire the settlements lock with bounded retries and Atomics.wait
 * (as used in settle.js).  Synchronous — no async/await, no Promises.
 * @returns {{ ok: boolean, token: string|null, reason: string|null }}
 */
export function acquireSettlementLock(repoKey) {
  let attempts = 0;
  const maxAttempts = 5;
  const retryMs = 200;

  while (attempts < maxAttempts) {
    const res = lock.acquire({
      stateDir: stateDirPath(),
      repoKey: SETTLEMENTS_LOCK_KEY,
    });

    if (res.ok) {
      heldLocks.add(res.token);
      installSignalHandlers();
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
export function releaseSettlementLock(repoKey, token) {
  const res = lock.release({
    stateDir: stateDirPath(),
    repoKey: SETTLEMENTS_LOCK_KEY,
    token,
  });
  heldLocks.delete(token);
  if (heldLocks.size === 0) uninstallSignalHandlers();
  return res;
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
      return { code: CODE_LOCK_BUSY, journal: null, reason: 'LOCK_BUSY' };
    }
    // Non-strict mode: proceed without lock (tests only)
  }

  try {
    // Read.  A journal that exists but cannot be parsed into an object is
    // CORRUPT: the cycle stops here and the file is left exactly as it is.
    // Overwriting it would destroy the very records that make disposal
    // non-repeating (B6, contract «Возобновление»).
    let journal;
    if (fs.existsSync(journalPath)) {
      let raw;
      try {
        raw = fs.readFileSync(journalPath, 'utf8');
      } catch {
        return { code: CODE_IO_ERROR, journal: null, reason: 'IO_ERROR' };
      }
      try {
        journal = JSON.parse(raw);
      } catch {
        return { code: CODE_JOURNAL_CORRUPT, journal: null, reason: 'CORRUPT' };
      }
      if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) {
        return { code: CODE_JOURNAL_CORRUPT, journal: null, reason: 'CORRUPT' };
      }
    } else {
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

    return { code: CODE_OK, journal, reason: null };
  } catch {
    // A failure of the mutation or of the write itself is a different outcome
    // from «busy» and carries its own code.
    return { code: CODE_IO_ERROR, journal: null, reason: 'IO_ERROR' };
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
  let entryFound = false;
  const res = guardedSettlements({
    repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      const entry = journal[dispatchId];
      if (!entry) return;
      entryFound = true;
      const held = entry.completedAction || {};
      entry.completedAction = {
        name: 'dispose-resources',
        verdict,
        status: 'completed',
        trigger: held.trigger || null,
        at: new Date().toISOString(),
        eventId: null,
      };
    },
  });
  if (res.code !== CODE_OK) return res;
  if (!entryFound) {
    // Nothing was recorded: saying «ok» here would report an action as
    // remembered when the journal holds no trace of it.
    return { code: CODE_ESCALATE, journal: null, reason: 'NO_ENTRY' };
  }
  return res;
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
export function recordPending(dispatchId, repoKey, opts = {}) {
  let entryFound = false;
  const res = guardedSettlements({
    repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      const entry = journal[dispatchId];
      if (!entry) return;
      entryFound = true;
      entry.completedAction = {
        name: 'dispose-resources',
        status: 'pending',
        trigger: opts.trigger || null,
        at: new Date().toISOString(),
        eventId: null,
      };
    },
  });
  if (res.code !== CODE_OK) return res;
  if (!entryFound) {
    return { code: CODE_ESCALATE, journal: null, reason: 'NO_ENTRY' };
  }
  return res;
}

// Outcomes of a disposal claim.  Exactly one process can be granted the right
// to call worker-stop for a dispatch; the others are told who holds it.
export const CLAIM_GRANTED = 'granted';
export const CLAIM_ALREADY_COMPLETED = 'already-completed';
export const CLAIM_HELD_BY_OTHER = 'held-by-other';

/**
 * Decide and record, under ONE hold of the lock, whether this process may call
 * worker-stop for a dispatch.
 *
 * Reading the state and writing the intent must not be two separate steps: in
 * between, another process can read the same "nothing recorded yet" and the
 * stop is sent twice.  So the entry is re-read inside the mutation and the
 * intent is written only when nothing is there — an existing `pending` or
 * `completed` is never overwritten.
 *
 * @returns {{ code: number, claim: string|null, reason: string|null }}
 *   claim CLAIM_GRANTED           — this process wrote the intent and may stop.
 *   claim CLAIM_ALREADY_COMPLETED — someone already finished; nothing to do.
 *   claim CLAIM_HELD_BY_OTHER     — another process holds the intent; do not stop.
 */
export function claimDisposal(dispatchId, repoKey, opts = {}) {
  let claim = null;
  let detail = null;

  const res = guardedSettlements({
    repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      const entry = journal[dispatchId];
      if (!entry) { claim = 'no-entry'; return; }

      const existing = entry.completedAction;
      const status = existing ? existing.status : undefined;

      if (status === 'completed') { claim = CLAIM_ALREADY_COMPLETED; return; }
      if (status === 'pending') { claim = CLAIM_HELD_BY_OTHER; return; }
      if (existing) { claim = 'unknown-status'; detail = JSON.stringify(status); return; }

      entry.completedAction = {
        name: 'dispose-resources',
        status: 'pending',
        trigger: opts.trigger || null,
        at: new Date().toISOString(),
        eventId: null,
      };
      claim = CLAIM_GRANTED;
    },
  });

  if (res.code !== CODE_OK) {
    return { code: res.code, claim: null, reason: res.reason };
  }
  if (claim === 'no-entry') {
    return { code: CODE_ESCALATE, claim: null, reason: 'NO_ENTRY' };
  }
  if (claim === 'unknown-status') {
    return { code: CODE_ESCALATE, claim: null, reason: 'UNKNOWN_STATUS ' + detail };
  }
  return { code: CODE_OK, claim, reason: null };
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
 * @param {string}   opts.runId — the run this process is completing.
 * @param {string}   opts.taskId — optional; checked against the journal entry.
 * @param {string|null} opts.repoKey
 * @param {boolean}  opts.deadlineExceeded — true when the wait ended on the
 *   deadline rather than on a result.  Only then may a live dispatch be
 *   stopped, and the step still stays unsettled.
 * @returns {object} { code: number, body: string|null }
 *
 * Exit codes:
 *   0  — resources disposed (or already disposed): `unsettled` stays in the journal.
 *   5  — ownership or stop result cannot be confirmed → escalation.
 *   23 — lock busy: journal untouched, worker-stop not called (B4).
 *   24 — journal corrupt: left untouched, nothing stopped (B6).
 *   25 — read or write error.
 */
export function disposeResources(opts) {
  const {
    dispatchId, runId, taskId, repoKey, deadlineExceeded = false,
  } = opts;

  // Read settlements journal entry.  A corrupt journal is its own outcome and
  // is left untouched (B6).
  const journalPath = getJournalPath(repoKey);
  let entry;
  if (fs.existsSync(journalPath)) {
    let raw;
    try {
      raw = fs.readFileSync(journalPath, 'utf8');
    } catch {
      return { code: CODE_IO_ERROR, body: 'journal read error for ' + dispatchId };
    }
    let journal;
    try {
      journal = JSON.parse(raw);
    } catch {
      return { code: CODE_JOURNAL_CORRUPT, body: 'settlements journal is unreadable and was left untouched: ' + journalPath };
    }
    if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) {
      return { code: CODE_JOURNAL_CORRUPT, body: 'settlements journal is not an object and was left untouched: ' + journalPath };
    }
    entry = journal[dispatchId];
  }

  if (!entry) {
    return { code: CODE_ESCALATE, body: 'no settlement entry for ' + dispatchId };
  }

  const verdict = entry.verdict || null;
  const completedAction = entry.completedAction;
  const status = completedAction ? completedAction.status : undefined;

  // A record written before the pending→completed protocol existed carries no
  // status.  Its outcome is unknown, and an unknown outcome is never a
  // permission to stop again: it is escalated, not assumed either way.
  if (completedAction && status !== 'pending' && status !== 'completed') {
    return {
      code: CODE_ESCALATE,
      body: 'completedAction for ' + dispatchId + ' carries no recognised status (' +
            JSON.stringify(status) + '); outcome unknown, nothing was stopped',
    };
  }

  // Case: completed → B5: code 0, nothing to do
  if (status === 'completed') {
    return { code: CODE_OK, body: `disposal already completed for ${dispatchId}; nothing to do` };
  }

  // Ownership is confirmed against the run this process owns, using the task
  // identity stored in the journal entry — never by comparing a value in the
  // entry with the key the same entry lives under.
  const ownership = _confirmOwnership({ entry, dispatchId, runId, taskId });
  if (!ownership.ok) {
    return { code: CODE_ESCALATE, body: 'dispatch ownership cannot be confirmed for ' + dispatchId + ': ' + ownership.reason };
  }

  // Case: pending → recovery after an interruption.  The stop is never
  // repeated: either the outcome is confirmed, or it is escalated.
  if (status === 'pending') {
    if (ownership.finished) {
      const result = recordDisposal(dispatchId, repoKey, { verdict });
      if (result.code !== CODE_OK) {
        return { code: result.code, body: 'completion could not be recorded (' + result.reason + '); state remains pending' };
      }
      return { code: CODE_OK, body: `disposal confirmed completed for ${dispatchId}` };
    }
    return {
      code: CODE_ESCALATE,
      body: 'dispatch ' + dispatchId + ' is still ' + JSON.stringify(ownership.state) +
            ' after an interrupted disposal; outcome unknown, the stop is not repeated',
    };
  }

  // No action recorded yet.  A live dispatch is stopped only when the deadline
  // has passed; the step then stays unsettled — stopping is not acceptance.
  if (!ownership.finished && !deadlineExceeded) {
    return {
      code: CODE_ESCALATE,
      body: 'dispatch ' + dispatchId + ' is still ' + JSON.stringify(ownership.state) +
            ' and no deadline was reached; nothing was stopped',
    };
  }

  // Step 6: claim the right to stop.  The decision and the record of the
  // intent happen under one hold of the lock, so two processes racing for the
  // same dispatch cannot both be granted it.  If the intent cannot be saved,
  // the stop is not called at all (B4).
  const claimed = claimDisposal(dispatchId, repoKey, {
    trigger: ownership.finished ? 'result' : 'deadline',
  });
  if (claimed.code !== CODE_OK) {
    return {
      code: claimed.code,
      body: 'disposal intent could not be saved (' + claimed.reason + '); worker-stop was not called',
    };
  }
  if (claimed.claim === CLAIM_ALREADY_COMPLETED) {
    return { code: CODE_OK, body: `disposal already completed for ${dispatchId}; nothing to do` };
  }
  if (claimed.claim === CLAIM_HELD_BY_OTHER) {
    // Another process wrote the intent first.  Only the process that wrote it
    // may send the command, so this one stops here and touches nothing.
    return {
      code: CODE_LOCK_BUSY,
      body: 'disposal for ' + dispatchId + ' is already in progress elsewhere; worker-stop was not called',
    };
  }

  // Step 7: call stop
  const stopResult = _callStop(dispatchId);
  if (stopResult.code !== CODE_OK) {
    // Stop failed — state stays pending, to be handled by the recovery path.
    return stopResult;
  }

  // Step 8: record completed with actual result.  The verdict of the
  // observation is carried over unchanged: disposal never settles a step.
  const completedResult = recordDisposal(dispatchId, repoKey, { verdict });
  if (completedResult.code !== CODE_OK) {
    return {
      code: completedResult.code,
      body: 'completedAction could not be recorded (' + completedResult.reason + '); state remains pending',
    };
  }

  return {
    code: CODE_OK,
    body: `resources disposed for ${dispatchId}` + (ownership.finished ? '' : ' after deadline; step stays unsettled'),
  };
}

/**
 * Confirm that a dispatch belongs to the run this process is completing.
 *
 * The identity being confirmed comes from the journal entry; the confirmation
 * comes from Orca, scoped to the caller's own run.  Comparing a field of the
 * entry with the key that entry is stored under would confirm nothing.
 *
 * @returns {{ ok: boolean, finished?: boolean, state?: string|null, reason: string|null }}
 */
function _confirmOwnership({ entry, dispatchId, runId, taskId }) {
  const journalTaskId = entry?.evidence?.workerDone?.taskId || null;
  if (!journalTaskId) {
    return { ok: false, reason: 'the journal entry carries no taskId to confirm against' };
  }
  if (taskId && taskId !== journalTaskId) {
    return {
      ok: false,
      reason: 'taskId ' + JSON.stringify(taskId) + ' does not match the journal entry (' + JSON.stringify(journalTaskId) + ')',
    };
  }
  if (!runId) {
    return { ok: false, reason: 'no run id to scope the ownership check' };
  }

  const listed = _readDispatchState(dispatchId, runId, journalTaskId);
  if (!listed.ok) {
    return { ok: false, reason: listed.reason };
  }
  return { ok: true, finished: listed.finished, state: listed.state, reason: null };
}

const FINISHED_STATES = ['succeeded', 'failed', 'stopped', 'abandoned', 'completed'];

/**
 * Read dispatch state from Orca via worker-list, scoped to one run.
 *
 * A dispatch counts as belonging to the run only if the run's own worker list
 * holds a record with this dispatchId and the expected taskId.  A record
 * without a readable state is not treated as finished.
 *
 * @returns {{ ok: boolean, finished?: boolean, state?: string|null, reason: string|null }}
 */
function _readDispatchState(dispatchId, runId, expectedTaskId) {
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
      return { ok: false, reason: 'worker-list failed' };
    }

    const out = result.stdout;
    if (typeof out !== 'string' || out.trim().length === 0) {
      return { ok: false, reason: 'worker-list returned empty' };
    }

    const workers = _parseWorkerList(out);
    const rec = workers.find(w => w.dispatchId === dispatchId && w.taskId === expectedTaskId);
    if (!rec) {
      return { ok: false, reason: 'dispatch is not in the worker list of run ' + runId };
    }

    // `state` is the field the real `worker-list --json` reports.
    const state = rec.state || null;
    if (!state) {
      return { ok: false, reason: 'worker-list record carries no state' };
    }

    return { ok: true, finished: FINISHED_STATES.includes(state), state, reason: null };
  } catch {
    return { ok: false, reason: 'worker-list threw exception' };
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
      return { code: CODE_ESCALATE, body: 'worker-stop returned ' + (result.status || 'error') + '; state remains pending' };
    }

    return { code: CODE_OK, body: null };
  } catch {
    return { code: CODE_ESCALATE, body: 'worker-stop threw exception; state remains pending' };
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

// ---------------------------------------------------------------------------
// Recovery after a crash that could not run JavaScript
// ---------------------------------------------------------------------------
//
// SIGINT and SIGTERM release the settlements lock (see installSignalHandlers).
// A SIGKILL, a power loss or a lost machine cannot: the lock directory stays
// behind and every later write reports busy.
//
// Recovery is a deliberate operator action and never an automatic release,
// because a held lock may still belong to a living process:
//
//   1. `lock.status({ stateDir, repoKey: 'settlements-guard' })` — who holds
//      it, since when, and what `classifyOwner` says about that owner.
//   2. Only when the owner classifies as dead, and only then:
//      `lock.forceRelease({ stateDir, repoKey: 'settlements-guard',
//                           confirm: true, reason: '<why>' })`.
//   3. If the owner cannot be classified — another host, an unknown pid —
//      the lock stays. Escalate instead of guessing: a lock taken from a live
//      writer costs more than a wait.
//
// Note on the limits of the handlers: this module writes synchronously, and a
// signal that arrives while a synchronous block is running is delivered only
// after that block ends. The handlers cover the ordinary case — a process
// interrupted while holding the lock between writes — not an interruption in
// the middle of one.
export const RECOVERY_AFTER_CRASH =
  'lock.status({repoKey:"settlements-guard"}) → classifyOwner → ' +
  'lock.forceRelease({confirm:true}) only for an owner classified dead; otherwise escalate.';
