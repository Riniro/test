#!/usr/bin/env node
// settle.js — bounded settlement watch command.
// Wraps the pure `decide()` verdict module with CLI arg parsing, polling,
// evidence collection, journal recording, and JSON stdout.

import { spawnSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

import { decide } from './settlement.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

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

function collectWorkerDone(runId, taskId, dispatchId) {
  try {
    const out = execSync(`orca orchestration worker-list --run ${JSON.stringify(runId)} --json`, {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const data = JSON.parse(out);
    const list = Array.isArray(data) ? data : (data?.items || data?.workers || []);
    const rec = list.find(r => r.dispatchId === dispatchId && r.taskId === taskId);
    if (!rec) return { found: false, status: null };
    return { found: true, status: rec.workerState || null, dispatchStatus: rec.dispatchStatus || null, raw: rec };
  } catch {
    return { found: false, status: null };
  }
}

function collectCommit(worktree) {
  if (!worktree || !fs.existsSync(worktree)) return null;
  try {
    const out = execSync(`git -C ${JSON.stringify(worktree)} log --oneline -1 --format=%H`, { encoding: 'utf8' });
    const sha = out.trim();
    return sha || '';
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

  let workerDone = { found: false, status: null };
  let dispatchStatus = null;
  let commit = null;
  let tests = { ran: false };

  let foundWorkerDone = false;
  let foundDispatchFinished = false;

  while (Date.now() < deadline) {
    // Collect worker_done
    if (!foundWorkerDone) {
      const result = collectWorkerDone(args.run, args.task, args.dispatch);
      workerDone = {
        found: result.found,
        status: result.status,
        dispatchStatus: result.dispatchStatus,
      };
      dispatchStatus = result.dispatchStatus;

      if (result.found && result.status === 'succeeded') {
        foundWorkerDone = true;
      } else if (result.found && result.status && result.status !== 'succeeded') {
        // Check if dispatch status itself is finished
        if (result.dispatchStatus && ['completed', 'failed', 'stopped', 'abandoned'].includes(result.dispatchStatus)) {
          foundDispatchFinished = true;
          foundWorkerDone = true; // we have enough info
        }
      }
    }

    // Collect commit (once per loop, cheap)
    if (!foundWorkerDone || !foundDispatchFinished) {
      commit = collectCommit(args.worktree);
    }

    // Early-stop check
    if (foundWorkerDone && foundDispatchFinished) break;
    if (foundWorkerDone) break; // worker_done succeeded is enough

    // Sleep until next poll
    const now = Date.now();
    if (now >= deadline) break;
    const wait = Math.max(0, Math.min(args.pollMs, deadline - now));
    const ev = new EventEmitter();
    setTimeout(() => { ev.emit('tick'); }, wait);
    // Block briefly
    const startWait = Date.now();
    while (Date.now() - startWait < wait) { /* spin — acceptable for coordinator */ }
  }

  deadlineExceeded = Date.now() >= deadline;

  // Run tests once after polling
  tests = collectTests(args.tests);

  // Build evidence
  const evidence = {
    workerDone: {
      found: workerDone.found,
      status: workerDone.status,
      taskId: args.task,
      dispatchId: args.dispatch,
    },
    dispatchStatus: dispatchStatus,
    commit: commit,
    tests: tests,
  };

  // Build dispatch/work/tests for decide()
  const dispatchObj = {
    workerDone: workerDone.found ? {
      taskId: args.task,
      dispatchId: args.dispatch,
      status: workerDone.status,
    } : null,
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

  // Determine alreadyRecorded
  const journalPath = getJournalPath(args.repoKey);
  const journal = readJournal(journalPath);
  let alreadyRecorded = false;
  const existingEntry = journal[args.dispatch];

  if (existingEntry && existingEntry.verdict === verdictResult.verdict) {
    alreadyRecorded = true;
  } else if (existingEntry && existingEntry.verdict !== verdictResult.verdict) {
    alreadyRecorded = false;
    verdictResult.reasons.push('VERDICT_CHANGED');
  }

  // Record to journal
  const entry = {
    ...verdictResult,
    evidence,
    deadlineExceeded,
    recommendedRecovery,
    alreadyRecorded,
    recordedAt: new Date().toISOString(),
  };

  if (!alreadyRecorded) {
    journal[args.dispatch] = entry;
    writeJournal(journalPath, journal);
  }

  // If already recorded, set the flag in the output
  entry.alreadyRecorded = alreadyRecorded;

  // Print exactly one JSON object to stdout
  process.stdout.write(JSON.stringify(entry, null, 2) + '\n');

  return exitCode;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main({ argv = process.argv.slice(2), cwd = process.cwd(), env = process.env } = {}) {
  const args = parseArgs(argv);
  return watch(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
