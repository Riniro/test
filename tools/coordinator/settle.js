#!/usr/bin/env node
// settle.js — bounded settlement watch command.
// Wraps the pure `decide()` verdict module with CLI arg parsing, polling,
// evidence collection, journal recording, and JSON stdout.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

import { decide } from './settlement.js';

// Settlement journal lock helpers — re-exported from the guard module.
import { guardedSettlements } from '../settlement-guard.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Launch adapter: how the Orca CLI is invoked.
//
// Production: the exact Orca executable of this Run, with no prefix arguments.
// Tests: process.execPath plus an absolute path to a temporary stub script.
//
// The command line is never split on spaces: the executable and every prefix
// argument are passed separately, and spawnSync runs with shell: false.
// ---------------------------------------------------------------------------

function resolveOrcaLaunch(env = process.env) {
  const executable = env.SETTLE_ORCA_EXEC || 'orca';

  let prefixArgs = [];
  const raw = env.SETTLE_ORCA_PREFIX_ARGS_JSON;
  if (raw !== undefined && raw !== '') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      die('SETTLE_ORCA_PREFIX_ARGS_JSON is not valid JSON.');
      return { executable, prefixArgs: [] };
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      die('SETTLE_ORCA_PREFIX_ARGS_JSON must be a JSON array of strings.');
      return { executable, prefixArgs: [] };
    }
    prefixArgs = parsed;
  }

  return { executable, prefixArgs };
}

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { command: null, run: undefined, task: undefined, dispatch: undefined, worktree: undefined, repoKey: undefined, deadlineMs: 600000, pollMs: 15000, tests: undefined };
  let i = 0;

  // Skip 'watch' at the start if present (positional command).
  // Supports both `settle.js watch --run ...` and `settle.js --run ...`.
  if (argv[0] === 'watch') i++;

  // If there are remaining flags starting with '--', continue parsing.
  // If argv[i] is missing or not a flag, that's an error (no command, no args).
  if (i >= argv.length || !argv[i].startsWith('--')) {
    process.stderr.write('Usage: node settle.js watch --run <runId> --task <taskId> --dispatch <dispatchId> --worktree <path> [--repo-key <key>] [--deadline-ms 600000] [--poll-ms 15000] [--tests "cmd"]\n');
    process.exit(2);
  }

  args.command = 'watch';

  while (i < argv.length) {
    const a = argv[i];
    if (a === '--run') { i++; args.run = argv[i++]; }
    else if (a === '--task') { i++; args.task = argv[i++]; }
    else if (a === '--dispatch') { i++; args.dispatch = argv[i++]; }
    else if (a === '--worktree') { i++; args.worktree = argv[i++]; }
    else if (a === '--repo-key') { i++; args.repoKey = argv[i++]; }
    else if (a === '--deadline-ms') { i++; args.deadlineMs = Number(argv[i++]); }
    else if (a === '--poll-ms') { i++; args.pollMs = Number(argv[i++]); }
    else if (a === '--tests') { i++; args.tests = argv[i++]; }
    else { die(`Unknown flag: ${a}`); }
  }

  if (!args.command || args.command !== 'watch') {
    process.stderr.write('Unknown command. Use: node settle.js watch ...\n');
    process.exit(2);
  }
  if (args.run === undefined || args.task === undefined || args.dispatch === undefined || args.worktree === undefined) {
    die('Missing required flag: --run, --task, --dispatch, --worktree are required.');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Evidence collectors (independent — no cross-inference)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON response from `orca orchestration worker-list` and return
 * the workers array.  Handles multiple response shapes.
 *
 * Exported for testing so the test suite can exercise parsing without
 * spawning a real `orca` CLI.
 *
 * @param {string} raw — raw JSON string from the CLI
 * @returns {object[]} workers list
 */
export function parseWorkerList(raw) {
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

function collectWorkerDone(runId, taskId, dispatchId) {
  try {
    const launch = resolveOrcaLaunch();
    const result = spawnSync(launch.executable, [
      ...launch.prefixArgs,
      'orchestration', 'worker-list', '--run', runId, '--json',
    ], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    if (result.error || result.status !== 0) {
      return { found: false, recordFound: false, state: null, raw: null, taskId, dispatchId };
    }

    const out = result.stdout;
    if (typeof out !== 'string' || out.trim().length === 0) {
      return { found: false, recordFound: false, state: null, raw: null, taskId, dispatchId };
    }

    const list = parseWorkerList(out);
    const rec = list.find(r => r.dispatchId === dispatchId && r.taskId === taskId);
    if (!rec) return { found: false, recordFound: false, state: null, raw: null, taskId, dispatchId };
    return {
      found: true,
      recordFound: true,
      state: rec.state || null,
      raw: rec,
      taskId,
      dispatchId,
    };
  } catch {
    // spawnSync does not throw; unreachable but kept for safety
    return { found: false, recordFound: false, state: null, raw: null, taskId, dispatchId };
  }
}

/**
 * Read the inbox for a run and look for a worker_done message whose payload
 * matches the expected taskId and dispatchId.  Uses `inbox --terminal run:<runId>`
 * which is the only method that does not consume messages.
 *
 * @param {string} runId
 * @returns {object|null}  { type, to, payload: { taskId, dispatchId }, id } or null
 */
function collectInbox(runId) {
  try {
    const launch = resolveOrcaLaunch();
    const result = spawnSync(launch.executable, [
      ...launch.prefixArgs,
      'orchestration', 'inbox', '--terminal', 'run:' + runId, '--limit', '50', '--json',
    ], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    if (result.error || result.status !== 0) return null;

    const out = result.stdout;
    if (typeof out !== 'string' || out.trim().length === 0) return null;

    const data = JSON.parse(out);
    const messages = data?.result?.messages || [];

    for (const msg of messages) {
      if (msg.type !== 'worker_done') continue;
      if (msg.to !== ('run:' + runId)) continue;
      const p = msg.payload;
      if (p && typeof p === 'object' && p.taskId && p.dispatchId) {
        return { type: msg.type, to: msg.to, payload: p, id: msg.id };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function collectCommit(worktree) {
  if (!worktree || !fs.existsSync(worktree)) return null;
  try {
    const result = spawnSync('git', [
      '-C', worktree, 'log', '--oneline', '-1', '--format=%H',
    ], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      return null;
    }
    if (result.status !== 0) {
      if (result.status === 128) return '';
      return null;
    }

    const out = result.stdout;
    return typeof out === 'string' ? out.trim() : '';
  } catch {
    return null;
  }
}

function collectTests(tests) {
  if (!tests) return { ran: false };
  const parts = tests.trim().split(/\s+/);
  if (parts.length === 0) return { ran: false };
  const cmd = parts[0];
  const args = parts.slice(1);
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status === null) return { ran: false };
  return { ran: true, passed: result.status === 0 };
}

// ---------------------------------------------------------------------------
// Journal (atomic write)
// ---------------------------------------------------------------------------

function getJournalPath(repoKey) {
  const stateDir = process.env.COORDINATOR_STATE_DIR || join(os.homedir(), '.claude-coordinator');
  const repo = repoKey || 'default';
  return join(stateDir, repo, 'settlements.json');
}

function readJournal(journalPath) {
  try {
    if (fs.existsSync(journalPath)) return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function writeJournal(journalPath, data) {
  const dir = join(journalPath, '..');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = journalPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, journalPath);
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

function watch(args) {
  const start = Date.now();
  const deadline = start + args.deadlineMs;
  let deadlineExceeded = false;

  let workerListResult = null;
  let inboxMessage = null;
  let commit = null;
  let tests = { ran: false };

  let foundWorkerListSucceeded = false;
  let foundInboxVerified = false;

  while (Date.now() < deadline) {
    // Collect worker-list status independently
    if (!foundWorkerListSucceeded) {
      const result = collectWorkerDone(args.run, args.task, args.dispatch);
      workerListResult = result;

      if (result.recordFound && result.state === 'succeeded') {
        foundWorkerListSucceeded = true;
      }
    }

    // Collect inbox message independently
    if (!foundInboxVerified) {
      const msg = collectInbox(args.run);
      if (msg) {
        const p = msg.payload;
        if (p && p.taskId === args.task && p.dispatchId === args.dispatch) {
          inboxMessage = msg;
          foundInboxVerified = true;
        }
      }
    }

    // Early-stop check: both independently confirmed
    if (foundWorkerListSucceeded && foundInboxVerified) break;
    if (foundWorkerListSucceeded) break;

    // Sleep until next poll (no busy-wait)
    const now = Date.now();
    if (now >= deadline) break;
    const wait = Math.max(0, Math.min(args.pollMs, deadline - now));
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    } catch {
      // Atomics.wait may throw on some platforms; fall back to a busy loop
      const endWait = Date.now() + wait;
      while (Date.now() < endWait) { /* spin */ }
    }
  }

  deadlineExceeded = Date.now() >= deadline;

  // Collect commit evidence once after polling (before building evidence).
  commit = collectCommit(args.worktree);

  // Run tests once after polling
  tests = collectTests(args.tests);

  // Build evidence for output
  const workerDoneFound = (workerListResult?.state === 'succeeded') &&
                          inboxMessage !== null &&
                          inboxMessage.type === 'worker_done' &&
                          inboxMessage.to === ('run:' + args.run) &&
                          inboxMessage.payload &&
                          inboxMessage.payload.taskId === args.task &&
                          inboxMessage.payload.dispatchId === args.dispatch;

  const evidence = {
    workerDone: {
      found: workerDoneFound,
      recordFound: workerListResult?.recordFound || false,
      status: inboxMessage ? 'worker_done' : null,
      taskId: inboxMessage?.payload?.taskId || args.task,
      dispatchId: inboxMessage?.payload?.dispatchId || args.dispatch,
    },
    workerList: {
      state: workerListResult?.state || null,
      recordFound: workerListResult?.recordFound || false,
    },
    inboxVerified: foundInboxVerified,
    commit: commit,
    tests: tests,
  };

  // Build dispatch/work/tests for decide()
  // workerDone: confirmed only when inbox message matches AND worker-list says succeeded
  const workerDoneObj = (workerListResult?.state === 'succeeded' && workerDoneFound)
    ? {
        taskId: args.task,
        dispatchId: args.dispatch,
        status: 'succeeded',
      }
    : null;

  const dispatchStatus = workerListResult?.state || null;

  const dispatchObj = {
    workerDone: workerDoneObj,
    expectedTaskId: args.task,
    expectedDispatchId: args.dispatch,
    status: dispatchStatus,
  };

  const work = {
    commit: commit,
  };

  const verdictResult = decide({
    dispatch: dispatchObj,
    work: work,
    tests: tests,
    deadlineExceeded: deadlineExceeded,
  });

  // Determine exit code
  let exitCode = 0;
  switch (verdictResult.verdict) {
    case 'SETTLED_BY_WORKER': exitCode = 0; break;
    case 'WORK_PRESENT_UNSETTLED': exitCode = 20; break;
    case 'NO_WORK_UNSETTLED': exitCode = 21; break;
    case 'UNVERIFIABLE': exitCode = 22; break;
  }

  // recommendedRecovery
  let recommendedRecovery = null;
  if (verdictResult.verdict !== 'SETTLED_BY_WORKER') {
    recommendedRecovery = `orca orchestration worker-show --dispatch ${args.dispatch}`;
  }

  // Determine alreadyRecorded — done under the settlements lock (R1).
  // guardedSettlements wraps the full read→mutate→write cycle.
  let alreadyRecorded = false;

  const guardResult = guardedSettlements({
    repoKey: args.repoKey,
    lockRequired: true,
    mutateFn: (journal) => {
      let existingEntry = null;
      try {
        existingEntry = journal[args.dispatch];
      } catch { /* ignore */ }

      if (existingEntry && existingEntry.verdict === verdictResult.verdict) {
        alreadyRecorded = true;
      } else if (existingEntry && existingEntry.verdict !== verdictResult.verdict) {
        alreadyRecorded = false;
        verdictResult.reasons.push('VERDICT_CHANGED');
      }

      if (!alreadyRecorded) {
        // Record to journal under lock — only when not already recorded
        const entry = {
          ...verdictResult,
          evidence,
          deadlineExceeded,
          recommendedRecovery,
          alreadyRecorded,
          recordedAt: new Date().toISOString(),
        };

        // B1: preserve completedAction when rewriting the entry
        if (existingEntry && existingEntry.completedAction) {
          entry.completedAction = existingEntry.completedAction;
        }

        journal[args.dispatch] = entry;
      }
    },
  });

  if (guardResult.code !== 0) {
    // The journal was not touched: busy (23), corrupt (24) or an I/O error
    // (25).  Each keeps its own code so the caller knows which it was, and a
    // corrupt journal is reported, never rewritten.
    const entry = {
      ...verdictResult,
      evidence,
      deadlineExceeded,
      recommendedRecovery,
      journalNotWritten: guardResult.reason,
      recordedAt: new Date().toISOString(),
    };
    if (guardResult.reason === 'LOCK_BUSY') entry.lockBusy = true;
    if (guardResult.reason === 'CORRUPT') entry.journalCorrupt = true;
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    return guardResult.code;
  }

  // Print the entry (alreadyRecorded flag is set correctly in mutateFn)
  // If alreadyRecorded=true, the journal was not modified (to keep file
  // unchanged), so we rebuild the output entry with the correct flag.
  let entryForOutput;
  if (alreadyRecorded) {
    entryForOutput = {
      ...verdictResult,
      evidence,
      deadlineExceeded,
      recommendedRecovery,
      alreadyRecorded: true,
      recordedAt: new Date().toISOString(),
    };
  } else {
    entryForOutput = guardResult.journal[args.dispatch];
  }

  // Print exactly one JSON object to stdout
  process.stdout.write(JSON.stringify(entryForOutput, null, 2) + '\n');

  return exitCode;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export { resolveOrcaLaunch };

export function main({ argv = process.argv.slice(2), cwd = process.cwd(), env = process.env } = {}) {
  const args = parseArgs(argv);
  return watch(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
