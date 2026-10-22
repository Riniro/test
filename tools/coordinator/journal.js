import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const JOURNAL_FILE = 'journal.json';
const BACKUP_FILE = 'journal.bak.json';

const KNOWN_KEYS = new Set([
  'version',
  'issueKey',
  'stage',
  'runId',
  'taskId',
  'dispatchIds',
  'branch',
  'commitSha',
  'prUrl',
  'lastConfirmedAction',
  'updatedAt',
  'checksum',
]);

const PROTECTED_KEYS = new Set(['checksum', 'version']);

const REQUIRED_KEYS = [
  'version',
  'issueKey',
  'stage',
  'runId',
  'taskId',
  'dispatchIds',
  'branch',
  'commitSha',
  'prUrl',
  'lastConfirmedAction',
  'updatedAt',
  'checksum',
];

const DEFAULTS = {
  version: 1,
  issueKey: null,
  stage: null,
  runId: null,
  taskId: null,
  dispatchIds: [],
  branch: null,
  commitSha: null,
  prUrl: null,
  lastConfirmedAction: null,
};

function journalPath({ stateDir, repoKey }) {
  return path.join(stateDir, repoKey, JOURNAL_FILE);
}

function backupPath({ stateDir, repoKey }) {
  return path.join(stateDir, repoKey, BACKUP_FILE);
}

function checksumOf(record) {
  const copy = {};
  for (const k of Object.keys(record).filter((k) => k !== 'checksum')) {
    copy[k] = record[k];
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(copy, sortKeysReplacer))
    .digest('hex');
}

function sortKeysReplacer(_, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = sortKeysReplacer(k, value[k]);
    }
    return sorted;
  }
  return value;
}

function _readRecord(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, raw };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'MISSING' };
    }
    return { ok: false, reason: 'READ_ERROR', detail: err.message };
  }
}

function _validateRecord(record) {
  // Check checksum if present
  if (record.checksum != null) {
    const expected = checksumOf(record);
    if (record.checksum !== expected) {
      return { ok: false, reason: 'CHECKSUM_MISMATCH' };
    }
  }

  // Check required fields
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      return {
        ok: false,
        reason: 'CORRUPT',
        detail: `Missing required field: ${key}`,
      };
    }
  }

  return { ok: true, record };
}

function _ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _writeOwnerAtomic(filePath, data) {
  const tmpFile = filePath + '.tmp.' + crypto.randomUUID();
  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, filePath);
}

function _filterPatch(patch) {
  const filtered = {};
  for (const key of Object.keys(patch)) {
    if (KNOWN_KEYS.has(key) && !PROTECTED_KEYS.has(key)) {
      filtered[key] = patch[key];
    }
  }
  return filtered;
}

function write({ stateDir, repoKey, patch }) {
  const filePath = journalPath({ stateDir, repoKey });
  const backupPath_ = backupPath({ stateDir, repoKey });

  let existing = null;
  const readResult = _readRecord(filePath);
  if (readResult.ok) {
    let parsed;
    try {
      parsed = JSON.parse(readResult.raw);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      const validation = _validateRecord(parsed);
      if (validation.ok) {
        existing = validation.record;
      }
    }
  }

  // Backup existing valid record before overwriting
  if (existing != null) {
    _writeOwnerAtomic(backupPath_, existing);
  }

  // Start from defaults or existing, then overlay filtered patch
  let record;
  if (existing != null) {
    record = { ...existing };
  } else {
    record = { ...DEFAULTS };
  }

  // Apply filtered patch
  const filtered = _filterPatch(patch || {});
  for (const key of Object.keys(filtered)) {
    record[key] = filtered[key];
  }

  // Always set updatedAt to current time
  record.updatedAt = new Date().toISOString();

  // Compute and set checksum (protected — cannot be overridden)
  record.checksum = checksumOf(record);

  _ensureDir(filePath);
  _writeOwnerAtomic(filePath, record);

  return { ok: true, record };
}

function read({ stateDir, repoKey }) {
  const filePath = journalPath({ stateDir, repoKey });
  const readResult = _readRecord(filePath);

  if (!readResult.ok) {
    if (readResult.reason === 'MISSING') {
      return { ok: false, reason: 'MISSING' };
    }
    return { ok: false, reason: 'CORRUPT', detail: readResult.detail };
  }

  let record;
  try {
    record = JSON.parse(readResult.raw);
  } catch (err) {
    return { ok: false, reason: 'CORRUPT', detail: err.message };
  }

  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'CORRUPT', detail: 'Record is not an object' };
  }

  // Check required fields first (before checksum to catch both cases)
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      return { ok: false, reason: 'CORRUPT', detail: `Missing required field: ${key}` };
    }
  }

  // Validate checksum
  if (record.checksum != null) {
    const expected = checksumOf(record);
    if (record.checksum !== expected) {
      return { ok: false, reason: 'CHECKSUM_MISMATCH' };
    }
  }

  return { ok: true, record };
}

export { journalPath, backupPath, write, read, checksumOf };
