import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  acquire,
  release,
  status,
  heartbeat,
  forceRelease,
  classifyOwner,
  lockDir,
} from '../tools/coordinator/lock.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
}

// ------------------------------------------------------------------
// Helper: valid owner.json keys (exactly these 7)
// ------------------------------------------------------------------
const VALID_KEYS = ['acquiredAt', 'heartbeatAt', 'host', 'pid', 'repoKey', 'token', 'worktree'];

let stateDir;

test('setup: create tmp stateDir', () => {
  stateDir = tmpDir();
});

after(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
});


// ------------------------------------------------------------------
// Owner classification helpers (R3)
// ------------------------------------------------------------------
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function ownerPath(repoKey) {
  return path.join(lockDir({ stateDir, repoKey }), 'owner.json');
}

function patchOwner(repoKey, patch) {
  const fp = ownerPath(repoKey);
  const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
  fs.writeFileSync(fp, JSON.stringify({ ...o, ...patch }));
}

function makeOwnerDead(repoKey) {
  patchOwner(repoKey, { pid: deadPid() });
}

// ------------------------------------------------------------------
// 14. Два последовательных acquire с одним repoKey
// ------------------------------------------------------------------
test('acquire second with same repoKey returns BUSY, owner token equals first', async () => {
  const repoKey = 'same-repo';

  const first = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(first.ok, true);

  const second = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'BUSY');
  assert.equal(second.owner.token, first.token);
});

// ------------------------------------------------------------------
// 15. Два acquire с разными meta.worktree — всё равно BUSY
// ------------------------------------------------------------------
test('acquire with different worktree still BUSY', async () => {
  const repoKey = 'shared-repo';

  const first = acquire({ stateDir, repoKey, meta: { worktree: '/wkt/a' } });
  assert.equal(first.ok, true);

  const second = acquire({ stateDir, repoKey, meta: { worktree: '/wkt/b' } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'BUSY');
  assert.equal(second.owner.worktree, '/wkt/a');
});

// ------------------------------------------------------------------
// 16. acquire с разными repoKey — оба успешны
// ------------------------------------------------------------------
test('acquire with different repoKey both succeed', async () => {
  const r1 = 'repo-one';
  const r2 = 'repo-two';

  const a1 = acquire({ stateDir, repoKey: r1, meta: {} });
  assert.equal(a1.ok, true);

  const a2 = acquire({ stateDir, repoKey: r2, meta: {} });
  assert.equal(a2.ok, true);
});

// ------------------------------------------------------------------
// 17. release: чужой token → NOT_OWNER, held stays true; свой → ok, held → false
// ------------------------------------------------------------------
test('release with wrong token returns NOT_OWNER; correct token releases', async () => {
  const repoKey = 'release-test';

  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  const wrong = release({ stateDir, repoKey, token: 'fake-token' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'NOT_OWNER');
  assert.equal(status({ stateDir, repoKey }).held, true);

  const correct = release({ stateDir, repoKey, token: r.token });
  assert.equal(correct.ok, true);
  assert.equal(status({ stateDir, repoKey }).held, false);
});

// ------------------------------------------------------------------
// 18. Просроченная блокировка: stale = true, но acquire всё равно BUSY
// ------------------------------------------------------------------
test('stale lock still returns BUSY on acquire', async () => {
  const repoKey = 'stale-lock';

  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  // Manually backdate heartbeatAt
  const lockPath = path.join(stateDir, repoKey, 'lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  owner.heartbeatAt = new Date(Date.now() - 10000000).toISOString();
  fs.writeFileSync(ownerPath, JSON.stringify(owner));

  const st = status({ stateDir, repoKey, ttlMs: 1 });
  assert.equal(st.stale, true);

  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, false);
  assert.equal(acq.reason, 'BUSY');
});

// ------------------------------------------------------------------
// 19. heartbeat: чужой → NOT_OWNER, heartbeatAt не меняется; свой → обновляется
// ------------------------------------------------------------------
test('heartbeat with wrong token returns NOT_OWNER; own token updates heartbeatAt', async () => {
  const repoKey = 'hb-test';

  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  const lockPath = path.join(stateDir, repoKey, 'lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const oldOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  const oldHb = oldOwner.heartbeatAt;

  const wrong = heartbeat({ stateDir, repoKey, token: 'fake' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'NOT_OWNER');

  const stillOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.equal(stillOwner.heartbeatAt, oldHb);

  // Small delay to ensure new timestamp is strictly greater
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ok = heartbeat({ stateDir, repoKey, token: r.token });
  assert.equal(ok.ok, true);

  const newOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.notEqual(newOwner.heartbeatAt, oldHb);
  assert.ok(newOwner.heartbeatAt > oldHb);
});

// ------------------------------------------------------------------
// 20. forceRelease без confirm/reason → CONFIRMATION_REQUIRED; с confirm+reason → снята
// ------------------------------------------------------------------
test('forceRelease without confirm returns CONFIRMATION_REQUIRED; with confirm removes lock', async () => {
  const repoKey = 'force-test';

  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  const fr = forceRelease({ stateDir, repoKey, confirm: false, reason: '' });
  assert.equal(fr.ok, false);
  assert.equal(fr.reason, 'CONFIRMATION_REQUIRED');
  assert.equal(status({ stateDir, repoKey }).held, true);

  // The owner is this very (live) process: only a proven dead owner may be taken over.
  makeOwnerDead(repoKey);
  const fr2 = forceRelease({ stateDir, repoKey, confirm: true, reason: 'test' });
  assert.equal(fr2.ok, true);
  assert.equal(status({ stateDir, repoKey }).held, false);
});

// ------------------------------------------------------------------
// 21. owner.json содержит ровно 7 предписанных ключей
// ------------------------------------------------------------------
test('owner.json contains exactly the 7 required keys', async () => {
  const repoKey = 'keys-test';

  const r = acquire({ stateDir, repoKey, meta: { worktree: '/some/wkt' } });
  assert.equal(r.ok, true);

  const ownerPath = path.join(stateDir, repoKey, 'lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  const keys = Object.keys(owner).sort();
  assert.deepStrictEqual(keys, VALID_KEYS);
});

// ------------------------------------------------------------------
// Дополнительные проверки acceptance criteria
// ------------------------------------------------------------------

test('acquire writes owner.json with correct fields and values', async () => {
  const repoKey = 'fields-test';
  const r = acquire({ stateDir, repoKey, meta: { worktree: '/wkt/x' } });
  assert.equal(r.ok, true);

  const ownerPath = path.join(stateDir, repoKey, 'lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));

  assert.equal(typeof owner.token, 'string');
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, os.hostname());
  assert.equal(owner.repoKey, repoKey);
  assert.equal(owner.worktree, '/wkt/x');
  assert.ok(typeof owner.acquiredAt === 'string' && owner.acquiredAt.includes('T'));
  assert.ok(typeof owner.heartbeatAt === 'string' && owner.heartbeatAt.includes('T'));
});

test('release with non-existent lock returns NOT_HELD', async () => {
  const res = release({ stateDir, repoKey: 'no-lock', token: 'any' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NOT_HELD');
});

test('status for non-held lock returns held=false', async () => {
  const s = status({ stateDir, repoKey: 'nothing-here' });
  assert.equal(s.held, false);
  assert.equal(s.owner, null);
  assert.equal(s.processAlive, null);
  assert.equal(s.ageMs, null);
  assert.equal(s.stale, false);
});

test('heartbeat on non-existent lock returns NOT_HELD', async () => {
  const h = heartbeat({ stateDir, repoKey: 'no-lock', token: 'x' });
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'NOT_HELD');
});

test('forceRelease on non-existent lock with confirm+reason removes gracefully', async () => {
  const fr = forceRelease({ stateDir, repoKey: 'no-lock', confirm: true, reason: 'test' });
  assert.equal(fr.ok, true);
  assert.equal(fr.released, null);
});

test('forceRelease without confirm does not touch lock', async () => {
  const repoKey = 'force-stay';
  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  const fr = forceRelease({ stateDir, repoKey, confirm: false, reason: 'just a reason' });
  assert.equal(fr.ok, false);
  assert.equal(fr.reason, 'CONFIRMATION_REQUIRED');
  assert.equal(status({ stateDir, repoKey }).held, true);
});

test('forceRelease without reason does not touch lock', async () => {
  const repoKey = 'force-no-reason';
  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  const fr = forceRelease({ stateDir, repoKey, confirm: true, reason: '' });
  assert.equal(fr.ok, false);
  assert.equal(fr.reason, 'CONFIRMATION_REQUIRED');
  assert.equal(status({ stateDir, repoKey }).held, true);
});

test('status with missing owner.json but lock dir exists returns null owner', async () => {
  const repoKey = 'broken-owner';
  const lockPath = path.join(stateDir, repoKey, 'lock');
  fs.mkdirSync(lockPath, { recursive: true });

  const s = status({ stateDir, repoKey });
  assert.equal(s.held, true);
  assert.equal(s.owner, null);
  assert.equal(s.processAlive, null);
  assert.equal(s.ageMs, null);
  assert.equal(s.stale, false);
});

test('lockDir returns absolute path', async () => {
  const p = lockDir({ stateDir, repoKey: 'x' });
  assert.ok(path.isAbsolute(p));
  assert.equal(p, path.join(stateDir, 'x', 'lock'));
});

test('acquire does not modify files on BUSY', async () => {
  const repoKey = 'atomic-busy';
  acquire({ stateDir, repoKey, meta: {} });
  const stat1 = fs.statSync(path.join(stateDir, repoKey));
  acquire({ stateDir, repoKey, meta: {} });
  const stat2 = fs.statSync(path.join(stateDir, repoKey));
  assert.equal(stat1.mtimeMs, stat2.mtimeMs);
});

test('release NOT_OWNER does not delete lock dir', async () => {
  const repoKey = 'not-owner-no-del';
  const r = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(r.ok, true);

  release({ stateDir, repoKey, token: 'wrong' });
  const s = status({ stateDir, repoKey });
  assert.equal(s.held, true);
});

// ------------------------------------------------------------------
// KAN-6-A2: extra meta keys must NOT appear in owner.json
// ------------------------------------------------------------------
test('extra meta keys are not written to owner.json', async () => {
  const repoKey = 'no-extra-keys';
  const r = acquire({ stateDir, repoKey, meta: { secretValue: 's3cret', extra: 42, worktree: '/wkt/extra' } });
  assert.equal(r.ok, true);

  const ownerPath = path.join(stateDir, repoKey, 'lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  const keys = Object.keys(owner);

  // secretValue and extra must NOT be present
  assert.ok(!keys.includes('secretValue'), 'secretValue should not be in owner.json');
  assert.ok(!keys.includes('extra'), 'extra should not be in owner.json');

  // Only the standard 7 keys should remain
  assert.deepStrictEqual(keys.sort(), VALID_KEYS);
});

// ------------------------------------------------------------------
// KAN-6-A2: acquire without meta gives owner.worktree === null
// ------------------------------------------------------------------
test('acquire without meta gives owner.worktree === null', async () => {
  const repoKey = 'no-meta-worktree';
  const r = acquire({ stateDir, repoKey });
  assert.equal(r.ok, true);
  assert.equal(r.owner.worktree, null);

  const ownerPath = path.join(stateDir, repoKey, 'lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.equal(owner.worktree, null);
});

after(() => {
  try {
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
});

// ------------------------------------------------------------------
// R3 / R5.12 — force-release tells three owner states apart
// ------------------------------------------------------------------
test('R3: classifyOwner — dead only for this host with a pid that does not answer', () => {
  const host = os.hostname();
  assert.equal(classifyOwner({ pid: deadPid(), host }).state, 'dead');
  assert.equal(classifyOwner({ pid: process.pid, host }).state, 'alive');
  for (const o of [
    { pid: deadPid(), host: host + '-other' }, // another host: a pid says nothing
    { pid: process.pid, host: host + '-other' },
    { host },                                  // no pid
    { pid: 'abc', host },                      // pid is not a number
    { pid: deadPid() },                        // no host
    null,                                      // no owner.json
    'text',
  ]) {
    const c = classifyOwner(o);
    assert.equal(c.state, 'undetermined', JSON.stringify(o));
    assert.ok(c.unverified && c.unverified.length > 0, 'the refusal must say what stayed unchecked');
  }
});

test('R3: forceRelease removes the lock of a proven dead owner', () => {
  const repoKey = 'fr-dead';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  makeOwnerDead(repoKey);
  const fr = forceRelease({ stateDir, repoKey, confirm: true, reason: 'owner is gone' });
  assert.equal(fr.ok, true);
  assert.equal(status({ stateDir, repoKey }).held, false);
});

test('R3: forceRelease refuses a live owner and leaves the lock', () => {
  const repoKey = 'fr-alive';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  const fr = forceRelease({ stateDir, repoKey, confirm: true, reason: 'looks stuck' });
  assert.equal(fr.ok, false);
  assert.equal(fr.reason, 'OWNER_NOT_DEAD');
  assert.equal(fr.ownerState, 'alive');
  assert.ok(fr.unverified);
  assert.equal(status({ stateDir, repoKey }).held, true);
});

test('R3: forceRelease refuses a foreign host even though its pid does not exist here', () => {
  const repoKey = 'fr-foreign';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  patchOwner(repoKey, { pid: deadPid(), host: os.hostname() + '-other' });
  const fr = forceRelease({ stateDir, repoKey, confirm: true, reason: 'the reason string alone proves nothing' });
  assert.equal(fr.ok, false);
  assert.equal(fr.ownerState, 'undetermined');
  assert.match(fr.unverified, /host/);
  assert.equal(status({ stateDir, repoKey }).held, true);
});

test('R3: forceRelease refuses a missing, unreadable or pid-less owner.json', () => {
  for (const [repoKey, setup] of [
    ['fr-noowner', () => fs.rmSync(ownerPath('fr-noowner'))],
    ['fr-garbage', () => fs.writeFileSync(ownerPath('fr-garbage'), '{not json')],
    ['fr-nopid', () => patchOwner('fr-nopid', { pid: undefined })],
    ['fr-strpid', () => patchOwner('fr-strpid', { pid: 'x' })],
  ]) {
    assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
    setup();
    const fr = forceRelease({ stateDir, repoKey, confirm: true, reason: 'cleanup' });
    assert.equal(fr.ok, false, repoKey);
    assert.equal(fr.ownerState, 'undetermined', repoKey);
    assert.equal(status({ stateDir, repoKey }).held, true, repoKey);
  }
});

test('R3: the confirm/reason requirements are unchanged and checked first', () => {
  const repoKey = 'fr-confirm';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  makeOwnerDead(repoKey);
  assert.equal(forceRelease({ stateDir, repoKey, confirm: false, reason: 'x' }).reason, 'CONFIRMATION_REQUIRED');
  assert.equal(forceRelease({ stateDir, repoKey, confirm: true, reason: '' }).reason, 'CONFIRMATION_REQUIRED');
  assert.equal(status({ stateDir, repoKey }).held, true);
});

test('R3: status reports ownerState; processAlive is null for a foreign host', () => {
  const repoKey = 'st-owner';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  const mine = status({ stateDir, repoKey });
  assert.equal(mine.ownerState, 'alive');
  assert.equal(mine.processAlive, true);
  patchOwner(repoKey, { host: os.hostname() + '-other' });
  const foreign = status({ stateDir, repoKey });
  assert.equal(foreign.ownerState, 'undetermined');
  assert.equal(foreign.processAlive, null, 'a foreign pid must not pose as an answer about the owner');
});

test('R3.5: acquire stays BUSY regardless of age: no automatic release by TTL', () => {
  const repoKey = 'no-ttl-steal';
  assert.equal(acquire({ stateDir, repoKey, meta: {} }).ok, true);
  patchOwner(repoKey, { pid: deadPid(), heartbeatAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
  assert.equal(status({ stateDir, repoKey }).stale, true);
  const again = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'BUSY');
});
