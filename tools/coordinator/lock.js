import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER_FILE = 'owner.json';
const DEFAULT_TTL_MS = 900000;

function lockDir({ stateDir, repoKey }) {
  return path.join(stateDir, repoKey, 'lock');
}

function ensureParentDir(lockPath) {
  const parent = path.dirname(lockPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function readOwner(lockPath) {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  try {
    const raw = fs.readFileSync(ownerPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeOwnerAtomic(lockPath, ownerData) {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const tmpFile = ownerPath + '.tmp.' + crypto.randomUUID();
  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(ownerData));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, ownerPath);
}

function acquire({ stateDir, repoKey, meta }) {
  const lockPath = lockDir({ stateDir, repoKey });

  if (fs.existsSync(lockPath)) {
    const owner = readOwner(lockPath);
    return { ok: false, reason: 'BUSY', owner };
  }

  ensureParentDir(lockPath);

  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      const owner = readOwner(lockPath);
      return { ok: false, reason: 'BUSY', owner };
    }
    throw err;
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const owner = {
    token,
    pid: process.pid,
    host: os.hostname(),
    repoKey,
    acquiredAt: now,
    heartbeatAt: now,
    worktree: meta?.worktree ?? null,
  };

  writeOwnerAtomic(lockPath, owner);

  return { ok: true, token, owner };
}

function release({ stateDir, repoKey, token }) {
  const lockPath = lockDir({ stateDir, repoKey });

  if (!fs.existsSync(lockPath)) {
    return { ok: false, reason: 'NOT_HELD' };
  }

  const owner = readOwner(lockPath);
  if (!owner || owner.token !== token) {
    return { ok: false, reason: 'NOT_OWNER' };
  }

  fs.rmSync(lockPath, { recursive: true, force: false });

  return { ok: true };
}

function status({ stateDir, repoKey, ttlMs } = {}) {
  const lockPath = lockDir({ stateDir, repoKey });
  const ttl = ttlMs ?? DEFAULT_TTL_MS;

  if (!fs.existsSync(lockPath)) {
    return { held: false, owner: null, processAlive: null, ownerState: null, ownerUnverified: null, ageMs: null, stale: false };
  }

  const owner = readOwner(lockPath);
  if (!owner) {
    return { held: true, owner: null, processAlive: null, ownerState: 'undetermined', ownerUnverified: 'owner.json is missing or unreadable', ageMs: null, stale: false };
  }

  // Kept for compatibility, but it is only an answer about the owner on the owner's own host.
  const cls = classifyOwner(owner);
  const sameHost = typeof owner.host === 'string' && owner.host === os.hostname();
  let processAlive = null;
  if (sameHost && typeof owner.pid === 'number') processAlive = cls.state === 'alive';

  const ageMs = Date.now() - new Date(owner.heartbeatAt).getTime();

  return {
    held: true,
    owner,
    processAlive,
    ownerState: cls.state,
    ownerUnverified: cls.unverified,
    ageMs: ageMs > 0 ? ageMs : 0,
    stale: ageMs > ttl,
  };
}

function heartbeat({ stateDir, repoKey, token }) {
  const lockPath = lockDir({ stateDir, repoKey });

  if (!fs.existsSync(lockPath)) {
    return { ok: false, reason: 'NOT_HELD' };
  }

  const owner = readOwner(lockPath);
  if (!owner || owner.token !== token) {
    return { ok: false, reason: 'NOT_OWNER' };
  }

  owner.heartbeatAt = new Date().toISOString();
  writeOwnerAtomic(lockPath, owner);

  return { ok: true };
}

/**
 * Classifies the owner of a held lock: three outcomes, not two.
 *  - dead:         owner.host is this host AND process owner.pid does not answer;
 *  - alive:        process owner.pid answers on its own host;
 *  - undetermined: another host, no/unreadable owner.json, or a missing / non-numeric pid.
 * A pid is meaningful only on the owner's host, so a foreign host is never "dead".
 * @returns {{ state: 'dead'|'alive'|'undetermined', unverified: string|null }}
 */
function classifyOwner(owner, { host } = {}) {
  if (owner === null || owner === undefined || typeof owner !== 'object' || Array.isArray(owner)) {
    return { state: 'undetermined', unverified: 'owner.json is missing or unreadable' };
  }
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { state: 'undetermined', unverified: 'owner.pid is missing or not a number' };
  }
  const here = host === undefined ? os.hostname() : host;
  if (typeof owner.host !== 'string' || owner.host !== here) {
    return {
      state: 'undetermined',
      unverified: 'owner host ' + JSON.stringify(owner.host === undefined ? null : owner.host)
        + ' differs from this host; a pid can be checked only on the host of the owner',
    };
  }
  try {
    process.kill(owner.pid, 0);
    return { state: 'alive', unverified: null };
  } catch (err) {
    // EPERM means the process exists but is not ours: it answers, so it is alive.
    if (err && err.code === 'EPERM') return { state: 'alive', unverified: null };
    return { state: 'dead', unverified: null };
  }
}

function forceRelease({ stateDir, repoKey, confirm, reason }) {
  if (confirm !== true || !reason || typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, reason: 'CONFIRMATION_REQUIRED' };
  }

  const lockPath = lockDir({ stateDir, repoKey });

  if (!fs.existsSync(lockPath)) {
    return { ok: true, released: null };
  }

  const owner = readOwner(lockPath);
  const cls = classifyOwner(owner);
  if (cls.state !== 'dead') {
    return {
      ok: false,
      reason: 'OWNER_NOT_DEAD',
      ownerState: cls.state,
      unverified: cls.state === 'alive'
        ? 'owner process ' + owner.pid + ' answers on this host'
        : cls.unverified,
      owner,
    };
  }
  fs.rmSync(lockPath, { recursive: true, force: false });

  return { ok: true, released: owner };
}

export {
  acquire,
  release,
  status,
  heartbeat,
  forceRelease,
  classifyOwner,
  lockDir,
};
