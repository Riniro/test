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
  };

  if (meta && typeof meta === 'object') {
    for (const key of Object.keys(meta)) {
      owner[key] = meta[key];
    }
  }

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
    return { held: false, owner: null, processAlive: null, ageMs: null, stale: false };
  }

  const owner = readOwner(lockPath);
  if (!owner) {
    return { held: true, owner: null, processAlive: null, ageMs: null, stale: false };
  }

  let processAlive = null;
  try {
    process.kill(owner.pid, 0);
    processAlive = true;
  } catch {
    processAlive = false;
  }

  const ageMs = Date.now() - new Date(owner.heartbeatAt).getTime();

  return {
    held: true,
    owner,
    processAlive,
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

function forceRelease({ stateDir, repoKey, confirm, reason }) {
  if (confirm !== true || !reason || typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, reason: 'CONFIRMATION_REQUIRED' };
  }

  const lockPath = lockDir({ stateDir, repoKey });

  if (!fs.existsSync(lockPath)) {
    return { ok: true, released: null };
  }

  const owner = readOwner(lockPath);
  fs.rmSync(lockPath, { recursive: true, force: false });

  return { ok: true, released: owner };
}

export {
  acquire,
  release,
  status,
  heartbeat,
  forceRelease,
  lockDir,
};
