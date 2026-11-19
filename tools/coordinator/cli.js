import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { acquire, release, status, heartbeat, forceRelease, lockDir } from './lock.js';
import { read as readJournal, write } from './journal.js';
import { findLinkedPr } from '../jira/find-pr.js';

const HEARTBEAT_INTERVAL_MS = 30000;

// Claim states that allow the executor to start (contract: "Исполняемый маршрут запуска").
const STARTABLE_CLAIM_STATES = { claimed: 'implement', review_pending: 'review', closing: 'close' };

// Gate code for a claim state that does not allow a start.
const CLAIM_STATE_CODES = {
  blocked: 3, not_ready: 3,
  awaiting_merge: 4, work_exists: 4,
  readback_failed: 5,
  source_unavailable: 6,
  mutation_failed: 7,
  usage: 2, not_found: 2,
};

// Pickup `reason` -> mode of the candidate. Any other reason at code 0 is incomplete data.
const CANDIDATE_MODES = { ready: 'implement', review: 'review', closing: 'close', closing_ci_failed: 'close' };
const VALID_MODES = ['implement', 'review', 'close'];

// A candidate and an accepted result are good for 5 minutes from their OWN createdAt.
const RECORD_TTL_MS = 5 * 60 * 1000;
// A createdAt this far in the future is not a clock difference but a record that would never expire.
const FUTURE_SKEW_MS = 60 * 1000;

const PRECHECK_TIMEOUT_MS = 120000;

/** @type {string} */
const STATE_DIR_VAR = 'COORDINATOR_STATE_DIR';

/**
 * Resolve state directory from environment or default.
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {string}
 */
function resolveStateDir(env) {
  const src = env || process.env;
  return src[STATE_DIR_VAR] || path.join(os.homedir(), '.claude-coordinator');
}

/**
 * Resolve repoKey from git repo name (first 16 chars of SHA-256 hex digest).
 * @param {{ cwd?: string }} opts
 * @returns {string | null}
 */
function resolveRepoKey({ cwd } = {}) {
  const cwd_ = cwd || process.cwd();
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: cwd_,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0) {
    return null;
  }
  const raw = result.stdout.replace(/\r?\n/, '').trim();
  const normalized = path.resolve(raw).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Parse CLI arguments into command + remaining args.
 * @param {string[]} argv
 * @returns {{ command: string, args: string[] }}
 */
function parseArgs(argv) {
  const cmd = argv[0];
  return { command: cmd, args: argv.slice(1) };
}

/**
 * Parse sub-options from args.
 * @param {string[]} args
 * @returns {{ flags: Set<string>, token: string|null, reason: string|null }}
 */
function parseOptions(args) {
  const flags = new Set();
  let token = null;
  let reason = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--token' && i + 1 < args.length) {
      token = args[++i];
    } else if (a === '--confirm') {
      flags.add('--confirm');
    } else if (a === '--reason' && i + 1 < args.length) {
      reason = args[++i];
    } else if (a === '--cmd' && i + 1 < args.length) {
      // consumed internally, skip
      i++;
    } else {
      // treat as flag if starts with --
      if (a.startsWith('--')) {
        flags.add(a);
      }
    }
  }
  return { flags, token, reason };
}

/**
 * Check if a process is alive by PID.
 * @param {number|null} pid
 * @returns {boolean | null}
 */
function checkProcessAlive(pid) {
  if (pid === null || pid === undefined) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute exit code from child process termination.
 * @param {number|null} code
 * @param {string|null} signal
 * @returns {number}
 */
function exitCode(code, signal) {
  if (signal !== null && signal !== undefined) {
    const sigNum = signalToNumber(signal);
    if (sigNum !== null && sigNum > 0) {
      return 128 + sigNum;
    }
    return 1;
  }
  return code !== null && code !== undefined ? code : 1;
}

/**
 * Map signal name to Unix signal number.
 * @param {string} signal
 * @returns {number | null}
 */
function signalToNumber(signal) {
  const map = {
    'SIGHUP': 1, 'SIGINT': 2, 'SIGQUIT': 3, 'SIGILL': 4, 'SIGTRAP': 5,
    'SIGABRT': 6, 'SIGBUS': 7, 'SIGFPE': 8, 'SIGKILL': 9, 'SIGUSR1': 10,
    'SIGSEGV': 11, 'SIGUSR2': 12, 'SIGPIPE': 13, 'SIGALRM': 14, 'SIGTERM': 15,
  };
  const n = map[signal];
  if (n !== undefined) return n;
  return null;
}

/**
 * Check if a binary is available.
 * @param {string} name
 * @returns {boolean}
 */
function binaryAvailable(name) {
  try {
    const r = spawnSync(name, ['--version'], {
      timeout: 10000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * CLI main entry point — works both as direct script and exported function.
 * @param {{ argv: string[], cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<number>} exit code
 */
async function main({ argv, cwd, env } = {}) {
  const myEnv = env || process.env;

  const { command, args } = parseArgs(argv || process.argv.slice(2));
  const stateDir = resolveStateDir(myEnv);
  const repoKey = resolveRepoKey({ cwd });
  if (repoKey === null) {
    process.stderr.write('NOT_A_GIT_REPO\n');
    return 14;
  }

  switch (command) {
    case 'precheck':
      return precheck({ args, stateDir, repoKey, cwd, env: myEnv });

    case 'start':
      return start({ args, stateDir, repoKey, cwd, env: myEnv });

    case 'status': {
      const lockState = status({ stateDir, repoKey });
      const lockLocked = lockState.held;

      if (lockLocked) {
        console.log('locked: true');
        if (lockState.owner) {
          const o = lockState.owner;
          // Do NOT print token
          if (o.pid !== undefined) console.log('pid:', o.pid);
          if (o.host !== undefined) console.log('host:', o.host);
          if (o.acquiredAt !== undefined) console.log('acquiredAt:', o.acquiredAt);
          if (o.worktree !== undefined) console.log('worktree:', o.worktree);
          console.log('processAlive:', lockState.processAlive);
          console.log('stale:', lockState.stale);
        }
        console.log('ownerState:', lockState.ownerState);
        if (lockState.ownerUnverified) console.log('ownerUnverified:', lockState.ownerUnverified);
      } else {
        console.log('locked: false');
      }

      // Read journal
      const jr = readJournal({ stateDir, repoKey });
      if (!jr.ok) {
        console.log('journal:', jr.reason);
        if (jr.detail) console.log('detail:', jr.detail);
        if (jr.reason === 'MISSING') {
          // Journal not present is not an error for status
          return lockLocked ? 9 : 0;
        }
        // CORRUPT or CHECKSUM_MISMATCH
        return 10;
      }
      if (jr.record) {
        console.log('stage:', jr.record.stage);
        console.log('updatedAt:', jr.record.updatedAt);
      }

      return lockLocked ? 9 : 0;
    }

    case 'release': {
      const { token: relToken } = parseOptions(args);
      if (!relToken) {
        process.stderr.write('Usage: cli.js release --token <token>\n');
        return 1;
      }
      const rel = release({ stateDir, repoKey, token: relToken });
      if (!rel.ok) {
        if (rel.reason === 'NOT_OWNER') {
          console.log('NOT_OWNER');
          return 11;
        }
        if (rel.reason === 'NOT_HELD') {
          console.log('NOT_HELD');
          return 0;
        }
        return 1;
      }
      console.log('Lock released');
      return 0;
    }

    case 'force-release': {
      const { flags, reason } = parseOptions(args);
      if (!flags.has('--confirm') || !reason || reason.length === 0) {
        console.log('CONFIRMATION_REQUIRED');
        return 12;
      }
      const fr = forceRelease({ stateDir, repoKey, confirm: true, reason });
      if (!fr.ok) {
        if (fr.reason === 'OWNER_NOT_DEAD') {
          // Do NOT print token
          console.log('FORCE_RELEASE_REFUSED');
          console.log('ownerState:', fr.ownerState);
          console.log('unverified:', fr.unverified);
          const o = fr.owner || {};
          if (o.pid !== undefined) console.log('pid:', o.pid);
          if (o.host !== undefined) console.log('host:', o.host);
          if (o.acquiredAt !== undefined) console.log('acquiredAt:', o.acquiredAt);
          return 19;
        }
        return 1;
      }
      console.log('Lock released');
      return 0;
    }

    case 'recover': {
      const lockState = status({ stateDir, repoKey });
      console.log('locked:', lockState.held);
      if (lockState.owner) {
        const o = lockState.owner;
        // Do NOT print token
        if (o.pid !== undefined) console.log('pid:', o.pid);
        if (o.host !== undefined) console.log('host:', o.host);
        console.log('processAlive:', lockState.processAlive);
      }

      // Read journal
      const jr = readJournal({ stateDir, repoKey });
      if (jr.ok && jr.record) {
        const rec = jr.record;
        console.log('stage:', rec.stage);
        console.log('lastConfirmedAction:', rec.lastConfirmedAction);
        if (rec.taskId !== undefined) console.log('taskId:', rec.taskId);
        if (rec.dispatchIds !== undefined) console.log('dispatchIds:', JSON.stringify(rec.dispatchIds));
        if (rec.prUrl !== undefined) console.log('prUrl:', rec.prUrl);
      } else if (jr.reason) {
        console.log('journal:', jr.reason);
      }

      // Check orca/gh availability
      const hasOrca = binaryAvailable('orca');
      const hasGh = binaryAvailable('gh');
      console.log('orca:', hasOrca ? 'available' : 'unavailable');
      console.log('gh:', hasGh ? 'available' : 'unavailable');

      // Determine verdict
      const verdict = determineRecovery(lockState, jr, hasOrca, hasGh);
      console.log(verdict);
      return verdict === 'UNCERTAIN' ? 13 : 0;
    }

    default: {
      process.stderr.write('Usage: cli.js start|precheck|status|release|force-release|recover\n');
      return 2;
    }
  }

  return 0;
}

/** Parses the last JSON object printed on stdout; null when there is none. */
function parseJsonOutput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const candidates = [t, ...t.split('\n').map((l) => l.trim()).filter(Boolean).reverse()];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function runNodeScript({ script, argv, cwd, env }) {
  const r = spawnSync(process.execPath, [script, ...argv], {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: PRECHECK_TIMEOUT_MS,
    env: { ...process.env, ...(env || {}) },
  });
  return { code: r.error || r.status === null ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sortDeep(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}

/**
 * precheck: is there work worth taking right now? It does NOT claim anything and changes no labels
 * anywhere: only pickup.js (read-only) and a read-only PR lookup run. Its result is a CANDIDATE
 * saved to the journal, not a permit. The claim happens in `start`, under the lock.
 */
async function precheck({ args, stateDir, repoKey, cwd, env }) {
  const opt = (name) => { const i = args.indexOf(name); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
  const project = opt('--project');
  const repo = opt('--repo');
  if (!project || !repo) {
    process.stderr.write('Usage: cli.js precheck --project K --repo o/n [--project-label pl] [--ci-grace-minutes N] [--base-branch b]\n');
    return 2;
  }
  const toolsJira = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jira');
  const pickupScript = env.PRECHECK_PICKUP_SCRIPT || path.join(toolsJira, 'pickup.js');

  const pickupArgs = ['--project', project, '--repo', repo, '--json'];
  for (const f of ['--project-label', '--ci-grace-minutes', '--base-branch']) {
    const v = opt(f);
    if (v !== null) pickupArgs.push(f, v);
  }
  const pk = runNodeScript({ script: pickupScript, argv: pickupArgs, cwd, env });
  if (pk.code === null || pk.code === 1) {
    process.stderr.write('PRECHECK: pickup did not run to completion\n');
    return 1;
  }
  if (pk.code !== 0) {
    // 2, 3, 4 (and anything else non-zero): the journal is not changed.
    process.stdout.write(pk.stdout);
    return pk.code;
  }
  const picked = parseJsonOutput(pk.stdout);
  const issueKey = picked && picked.issue && typeof picked.issue.key === 'string' ? picked.issue.key : null;
  if (!issueKey) {
    // Code 0 without a selected issue is incomplete data: nothing may start.
    process.stderr.write('PRECHECK: pickup returned 0 without an issue key\n');
    return 4;
  }
  const mode = Object.prototype.hasOwnProperty.call(CANDIDATE_MODES, picked.reason) ? CANDIDATE_MODES[picked.reason] : null;
  if (mode === null) {
    process.stderr.write('PRECHECK: pickup returned 0 with an unknown reason ' + JSON.stringify(picked.reason === undefined ? null : picked.reason) + '\n');
    return 4;
  }

  // The linked PR and its head: pickup returns no PR for ready/review, and a head cannot be compared
  // against nothing. A failed lookup is not "no PR": it stops the route (code 6).
  const found = await findLinkedPr({ key: issueKey, repo, env });
  if (!found.ok) {
    process.stderr.write('PRECHECK: the PR lookup failed (' + found.reason + ')\n');
    return 6;
  }

  const candidate = { issueKey, mode, pr: found.pr, createdAt: new Date().toISOString() };

  // Saved and read back by a fresh read; a failure to save forbids the launch.
  let saved = false;
  try {
    write({ stateDir, repoKey, patch: { issueKey, candidate } });
    const jr = readJournal({ stateDir, repoKey });
    saved = jr.ok && JSON.stringify(sortDeep(jr.record.candidate)) === JSON.stringify(sortDeep(candidate));
  } catch { saved = false; }
  if (!saved) {
    process.stderr.write('PRECHECK: the candidate was not saved to the journal\n');
    return 5;
  }
  process.stdout.write(JSON.stringify({ candidate }) + '\n');
  return 0;
}

/** Age check by a record's OWN createdAt. Missing, unparsable or far-future means not fresh. */
function recordFresh(rec, now = Date.now()) {
  const t = rec && typeof rec.createdAt === 'string' ? Date.parse(rec.createdAt) : NaN;
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age <= RECORD_TTL_MS && age >= -FUTURE_SKEW_MS;
}

function releaseQuietly(stateDir, repoKey, token) {
  try { release({ stateDir, repoKey, token }); } catch { /* released or gone */ }
}

/**
 * start: lock, candidate, age, issue/mode, claim, state/mode, live comparison, save, age, spawn.
 * The order is the contract. Any refusal in steps 2-9 spawns nothing and releases the lock.
 */
async function start({ args, stateDir, repoKey, cwd, env }) {
  const sep = args.indexOf('--');
  const own = sep === -1 ? args : args.slice(0, sep);
  const rest = sep === -1 ? [] : args.slice(sep + 1);
  const opt = (name) => { const i = own.indexOf(name); return i !== -1 && i + 1 < own.length ? own[i + 1] : null; };
  const project = opt('--project');
  const repo = opt('--repo');
  const issue = opt('--issue');
  const mode = opt('--mode');
  const childCmd = rest[0];
  const childArgs = rest.slice(1);
  if (!project || !repo || !issue || !mode || !childCmd || !VALID_MODES.includes(mode)) {
    process.stderr.write('Usage: cli.js start --project K --repo o/n --issue KEY --mode <implement|review|close> -- <command> [args...]\n');
    return 2;
  }
  const toolsJira = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jira');
  const claimScript = env.PRECHECK_CLAIM_SCRIPT || path.join(toolsJira, 'claim.js');

  // 1. The lock comes first, before the journal is read.
  const acq = acquire({ stateDir, repoKey, meta: { worktree: null } });
  if (!acq.ok) {
    if (acq.reason === 'BUSY') {
      const o = acq.owner || {};
      console.log('BUSY');
      if (o.pid !== undefined) console.log('pid:', o.pid);
      if (o.host !== undefined) console.log('host:', o.host);
      if (o.acquiredAt !== undefined) console.log('acquiredAt:', o.acquiredAt);
      if (o.worktree !== undefined) console.log('worktree:', o.worktree);
      return 9;
    }
    return 1;
  }
  const { token } = acq;

  try {
    // 2. The candidate must be an object.
    const jr = readJournal({ stateDir, repoKey });
    const candidate = jr.ok ? jr.record.candidate : null;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      process.stderr.write('START_REFUSED: no candidate in the journal' + (jr.ok ? '' : ' (journal ' + jr.reason + ')') + '\n');
      return 15;
    }
    // 3. Age from the candidate's own createdAt.
    if (!recordFresh(candidate)) {
      process.stderr.write('START_REFUSED: the candidate is expired or has no valid createdAt\n');
      return 16;
    }
    // 4. --issue and --mode against the candidate.
    if (candidate.issueKey !== issue || candidate.mode !== mode) {
      process.stderr.write('START_REFUSED: --issue/--mode ' + JSON.stringify([issue, mode])
        + ' differ from the candidate ' + JSON.stringify([candidate.issueKey ?? null, candidate.mode ?? null]) + '\n');
      return 17;
    }
    // 5. The claim: the only place where labels change.
    const cl = runNodeScript({
      script: claimScript,
      argv: ['--project', project, '--issue', candidate.issueKey, '--repo', repo, '--adopt-existing'],
      cwd, env,
    });
    if (cl.code === null) {
      process.stderr.write('START_REFUSED: the claim gate did not run to completion\n');
      return 1;
    }
    if (cl.code !== 0) {
      process.stdout.write(cl.stdout);
      process.stderr.write('START_REFUSED: the claim gate returned ' + cl.code + '\n');
      return cl.code;
    }
    // 6. Code 0 is read together with state/mode.
    const out = parseJsonOutput(cl.stdout);
    const state = out && typeof out.state === 'string' ? out.state : 'unknown';
    const claimMode = out && typeof out.mode === 'string' ? out.mode : null;
    if (!Object.prototype.hasOwnProperty.call(STARTABLE_CLAIM_STATES, state) || STARTABLE_CLAIM_STATES[state] !== claimMode) {
      process.stderr.write('START_REFUSED: claim returned 0 with an unusable state/mode ' + JSON.stringify([state, claimMode]) + '\n');
      return 5;
    }
    const prOut = out.pr && typeof out.pr === 'object' ? out.pr : null;
    const livePr = prOut
      ? {
        number: prOut.number === undefined ? null : prOut.number,
        url: prOut.url === undefined ? null : prOut.url,
        headSha: prOut.headSha !== undefined && prOut.headSha !== null ? prOut.headSha
          : (out.readiness && out.readiness.headSha ? out.readiness.headSha : null),
      }
      : null;

    // 7. Live data against the candidate. A different mode is never a silent switch.
    if (claimMode !== candidate.mode) {
      process.stderr.write('START_REFUSED: mode changed since precheck: candidate ' + JSON.stringify(candidate.mode)
        + ', now ' + JSON.stringify(claimMode) + '\n');
      return 18;
    }
    const candPr = candidate.pr && typeof candidate.pr === 'object' ? candidate.pr : null;
    if (candPr === null && livePr !== null) {
      process.stderr.write('START_REFUSED: a PR appeared since precheck: #' + livePr.number + '\n');
      return 18;
    }
    if (candPr !== null && (livePr === null || livePr.number !== candPr.number)) {
      process.stderr.write('START_REFUSED: the linked PR changed since precheck: candidate #' + candPr.number
        + ', now ' + (livePr === null ? 'none' : '#' + livePr.number) + '\n');
      return 18;
    }
    const candHead = candPr && typeof candPr.headSha === 'string' && candPr.headSha ? candPr.headSha : null;
    if (candHead !== null && candHead !== (livePr ? livePr.headSha : null)) {
      process.stderr.write('START_REFUSED: the PR head changed since precheck: candidate '
        + candHead + ', now ' + JSON.stringify(livePr ? livePr.headSha : null) + '\n');
      return 18;
    }
    // Nothing to compare is not a successful comparison, and is reported as such.
    const headComparable = candHead !== null;

    // 8. The accepted result is saved BEFORE the executor starts, and read back.
    const accepted = { issueKey: candidate.issueKey, state, mode: claimMode, pr: livePr, createdAt: new Date().toISOString() };
    let saved = false;
    try {
      write({ stateDir, repoKey, patch: { issueKey: accepted.issueKey, claim: accepted } });
      const back = readJournal({ stateDir, repoKey });
      saved = back.ok && JSON.stringify(sortDeep(back.record.claim)) === JSON.stringify(sortDeep(accepted));
    } catch { saved = false; }
    if (!saved) {
      process.stderr.write('START_REFUSED: the accepted result was not saved to the journal\n');
      return 5;
    }
    // 9. Age of the accepted result.
    if (!recordFresh(accepted)) {
      process.stderr.write('START_REFUSED: the accepted result expired before the executor could start\n');
      return 16;
    }
    process.stdout.write(JSON.stringify({ route: { issueKey: accepted.issueKey, mode: accepted.mode, state, headComparable } }) + '\n');

    writeJournal({ stateDir, repoKey, patch: { stage: 'running' } });

    // 10. Spawn. Arguments after `--` are passed exactly as given; the task goes in the environment.
    const child = spawn(childCmd, childArgs, {
      stdio: 'inherit',
      shell: false,
      detached: false,
      env: {
        ...process.env,
        COORDINATOR_ISSUE_KEY: accepted.issueKey,
        COORDINATOR_MODE: accepted.mode,
        COORDINATOR_CLAIM_CREATED_AT: accepted.createdAt,
      },
    });

    let heartbeatTimer = null;
    try {
      heartbeatTimer = setInterval(() => {
        heartbeat({ stateDir, repoKey, token });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    } catch { /* unref not needed in some environments */ }

    // Forward termination signals to the child; the lock is released in the
    // finally block below once the child has actually gone away.
    function forwardSignal() {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);

    try {
      // Hold the lock for the whole lifetime of the child process.
      return await new Promise((resolve) => {
        child.on('error', () => {
          // Child could not be spawned at all (for example ENOENT).
          resolve(127);
        });
        child.on('exit', (code, signal) => {
          resolve(exitCode(code, signal));
        });
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
    }
  } finally {
    // Also covers every refusal above: no executor, lock freed. NOT_HELD is fine.
    releaseQuietly(stateDir, repoKey, token);
  }
}

/**
 * Helper to write a journal patch.
 * @param {{ stateDir: string, repoKey: string, patch: Record<string, unknown> }} opts
 */
function writeJournal({ stateDir, repoKey, patch }) {
  try {
    write({ stateDir, repoKey, patch });
  } catch { /* ignore write errors for journal updates */ }
}

/**
 * Determine recovery verdict.
 * @param {{ held: boolean, owner: any|null, processAlive: boolean|null, stale: boolean }} lockState
 * @param {{ ok: boolean, record?: any, reason?: string, detail?: string }} jr
 * @param {boolean} hasOrca
 * @param {boolean} hasGh
 * @returns {string}
 */
function determineRecovery(lockState, jr, hasOrca, hasGh) {
  const reasons = [];

  if (!lockState.held) {
    return 'SAFE_TO_RELEASE';
  }

  // Lock is held — need owner info
  if (!lockState.owner) {
    reasons.push('No owner data');
    return reasons.join('; ') || 'UNCERTAIN';
  }

  if (lockState.ownerState === 'alive' || lockState.processAlive === true) {
    reasons.push('Owner process alive');
  } else if (lockState.ownerState === 'undetermined') {
    reasons.push('Owner state undetermined: ' + (lockState.ownerUnverified || 'cannot be checked'));
  }

  // Check journal for pending action
  if (jr.ok && jr.record) {
    const lastAction = jr.record.lastConfirmedAction;
    if (lastAction !== null && lastAction !== undefined) {
      if (lastAction.result === 'pending') {
        reasons.push('lastConfirmedAction.result=pending');
      }
    }
    // If lastConfirmedAction is null or result != pending, that's good
  } else if (jr.reason && jr.reason !== 'MISSING') {
    reasons.push('Journal not readable: ' + jr.reason);
  }

  // If orca or gh unavailable, cannot be SAFE_TO_RELEASE
  if (!hasOrca || !hasGh) {
    reasons.push('Tool(s) unavailable');
  }

  if (reasons.length === 0) {
    return 'SAFE_TO_RELEASE';
  }

  return reasons.join('; ');
}

export { resolveStateDir, resolveRepoKey, main };

// Entry point: run only when this file is executed directly, not when imported.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env })
    .then((rc) => {
      process.exitCode = rc;
    })
    .catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exitCode = 1;
    });
}
