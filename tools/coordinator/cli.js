import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { acquire, release, status, heartbeat, forceRelease, lockDir } from './lock.js';
import { read as readJournal, write } from './journal.js';

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

    case 'start': {
      // Determine child command and extra args
      let childArgs = args;
      let childCmd = null;
      const sepIdx = childArgs.indexOf('--');
      if (sepIdx !== -1) {
        childCmd = childArgs[sepIdx + 1];
        childArgs = childArgs.slice(sepIdx + 2);
        // skip --cmd flag
        const cmdIdx = childArgs.indexOf('--cmd');
        if (cmdIdx !== -1) {
          childCmd = childArgs[cmdIdx + 1];
          childArgs = childArgs.slice(0, cmdIdx).concat(childArgs.slice(cmdIdx + 2));
        }
      } else if (childArgs.length > 0) {
        childCmd = childArgs[0];
        childArgs = childArgs.slice(1);
      }

      if (!childCmd) {
        process.stderr.write('Usage: cli.js start [-- cmd args...]\n');
        return 2;
      }

      // A non-empty claim in the journal that is not a successful capture means zero executor
      // launches. A null or absent claim keeps the previous behavior.
      const preStart = readJournal({ stateDir, repoKey });
      if (preStart.ok && preStart.record && preStart.record.claim !== null && preStart.record.claim !== undefined) {
        const c = preStart.record.claim;
        const st = c && typeof c === 'object' ? c.state : undefined;
        if (typeof st !== 'string' || !Object.prototype.hasOwnProperty.call(STARTABLE_CLAIM_STATES, st)) {
          process.stderr.write('START_REFUSED: claim state is ' + JSON.stringify(st === undefined ? null : st) + '\n');
          return Object.prototype.hasOwnProperty.call(CLAIM_STATE_CODES, st) ? CLAIM_STATE_CODES[st] : 1;
        }
      }

      // Acquire lock
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

      // Write journal stage: running
      writeJournal({ stateDir, repoKey, patch: { stage: 'running' } });

      // Spawn child process
      const child = spawn(childCmd, childArgs, {
        stdio: 'inherit',
        shell: false,
        detached: false,
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
        // Releasing an already released lock reports NOT_HELD, which is fine.
        release({ stateDir, repoKey, token });
      }
    }

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
 * precheck: the only place where the launch is decided. pickup.js selects the work,
 * claim.js --adopt-existing captures it, the result is written to the journal and read back.
 * The exit code is the gate's; a result that could not be saved is code 5 even if the gate said 0.
 */
function precheck({ args, stateDir, repoKey, cwd, env }) {
  const opt = (name) => { const i = args.indexOf(name); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
  const project = opt('--project');
  const repo = opt('--repo');
  if (!project || !repo) {
    process.stderr.write('Usage: cli.js precheck --project K --repo o/n [--project-label pl] [--ci-grace-minutes N] [--base-branch b]\n');
    return 2;
  }
  const toolsJira = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jira');
  const pickupScript = env.PRECHECK_PICKUP_SCRIPT || path.join(toolsJira, 'pickup.js');
  const claimScript = env.PRECHECK_CLAIM_SCRIPT || path.join(toolsJira, 'claim.js');

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
    // 2, 3, 4 (and anything else non-zero): the gate is not called, the journal is not changed.
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

  const cl = runNodeScript({
    script: claimScript,
    argv: ['--project', project, '--issue', issueKey, '--repo', repo, '--adopt-existing'],
    cwd, env,
  });
  const out = parseJsonOutput(cl.stdout);
  const state = out && typeof out.state === 'string' ? out.state : 'unknown';
  const prOut = out && out.pr && typeof out.pr === 'object' ? out.pr : null;
  const claim = {
    issueKey,
    state,
    mode: out && typeof out.mode === 'string' ? out.mode : null,
    pr: prOut
      ? {
        number: prOut.number === undefined ? null : prOut.number,
        url: prOut.url === undefined ? null : prOut.url,
        headSha: prOut.headSha !== undefined && prOut.headSha !== null ? prOut.headSha
          : (out.readiness && out.readiness.headSha ? out.readiness.headSha : null),
      }
      : null,
  };
  const gateCode = cl.code === null ? 1 : cl.code;

  // The result is saved in ANY outcome and read back by a fresh read.
  let saved = false;
  try {
    write({ stateDir, repoKey, patch: { issueKey, claim } });
    const jr = readJournal({ stateDir, repoKey });
    saved = jr.ok && JSON.stringify(sortDeep(jr.record.claim)) === JSON.stringify(sortDeep(claim));
  } catch { saved = false; }
  if (!saved) {
    process.stderr.write('PRECHECK: the claim result was not saved to the journal\n');
    return 5;
  }

  // Code 0 with a state/mode pair that does not allow a start is not a successful gate.
  if (gateCode === 0 && STARTABLE_CLAIM_STATES[state] !== claim.mode) {
    process.stderr.write('PRECHECK: claim returned 0 with an unusable state/mode\n');
    return 5;
  }
  process.stdout.write(cl.stdout);
  return gateCode;
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

  if (lockState.processAlive === true) {
    reasons.push('Owner process alive');
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
