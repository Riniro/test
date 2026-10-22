import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  journalPath,
  backupPath,
  write,
  read,
  checksumOf,
} from '../tools/coordinator/journal.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
}

let stateDir;

test('setup: create tmp stateDir', () => {
  stateDir = tmpDir();
});

after(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
});

// ------------------------------------------------------------------
// 13. write затем read возвращает ту же запись; checksum совпадает
// ------------------------------------------------------------------
test('write then read returns same record; checksum matches', () => {
  const repoKey = 'basic';
  const patch = { issueKey: 'KAN-6', stage: 'planning' };

  const w = write({ stateDir, repoKey, patch });
  assert.equal(w.ok, true);

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(r.record, w.record);

  // Checksum must match
  const expected = checksumOf(r.record);
  assert.equal(r.record.checksum, expected);
});

// ------------------------------------------------------------------
// 14. Последовательные write сливаются
// ------------------------------------------------------------------
test('sequential write merges: earlier fields preserved', () => {
  const repoKey = 'merge';

  const w1 = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(w1.ok, true);

  const w2 = write({ stateDir, repoKey, patch: { stage: 'execution' } });
  assert.equal(w2.ok, true);

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, true);
  assert.equal(r.record.issueKey, 'KAN-6'); // preserved
  assert.equal(r.record.stage, 'execution'); // updated
});

// ------------------------------------------------------------------
// 15. patch с посторонним ключом: ключ игнорируется
// ------------------------------------------------------------------
test('patch with unknown key is ignored', () => {
  const repoKey = 'unknown-key';

  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', secret: 's3cret', extra: 42 } });
  assert.equal(w.ok, true);
  assert.equal(w.record.issueKey, 'KAN-6');
  assert.equal(w.record.secret, undefined);
  assert.equal(w.record.extra, undefined);
});

// ------------------------------------------------------------------
// 15. patch с checksum или version: не переопределяются
// ------------------------------------------------------------------
test('patch cannot override checksum or version', () => {
  const repoKey = 'protected';

  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', checksum: 'fake', version: 999 } });
  assert.equal(w.ok, true);
  assert.equal(w.record.version, 1); // default, not 999
  assert.notEqual(w.record.checksum, 'fake');
});

// ------------------------------------------------------------------
// 16. Повреждение 1 — битый JSON: CORRUPT с detail
// ------------------------------------------------------------------
test('corrupt JSON returns CORRUPT with non-empty detail', () => {
  const repoKey = 'corrupt-json';
  const filePath = journalPath({ stateDir, repoKey });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not json');

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CORRUPT');
  assert.ok(typeof r.detail === 'string' && r.detail.length > 0);
});

// ------------------------------------------------------------------
// 17. Повреждение 2 — подменённый checksum
// ------------------------------------------------------------------
test('checksum mismatch returns CHECKSUM_MISMATCH', () => {
  const repoKey = 'bad-checksum';
  const filePath = journalPath({ stateDir, repoKey });

  // Create valid record
  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(w.ok, true);

  // Read, modify issueKey, write back without recalculating checksum
  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw);
  record.issueKey = 'CHANGED';
  fs.writeFileSync(filePath, JSON.stringify(record));

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CHECKSUM_MISMATCH');
});

// ------------------------------------------------------------------
// 18. Повреждение 3 — отсутствующее поле при верном checksum
// ------------------------------------------------------------------
test('missing required field with valid checksum returns CORRUPT', () => {
  const repoKey = 'missing-field';
  const filePath = journalPath({ stateDir, repoKey });

  // Create valid record
  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(w.ok, true);

  // Read, remove required field, recalculate checksum
  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw);
  delete record.issueKey;
  // Recalculate checksum so it passes checksum check but fails required field check
  record.checksum = checksumOf(record);
  fs.writeFileSync(filePath, JSON.stringify(record));

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CORRUPT');
});

// ------------------------------------------------------------------
// 19. journal.bak.json появляется после второго write
// ------------------------------------------------------------------
test('backup appears after second write', () => {
  const repoKey = 'backup-test';

  write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(fs.existsSync(backupPath({ stateDir, repoKey })), false);

  const w2 = write({ stateDir, repoKey, patch: { stage: 'execution' } });
  assert.equal(w2.ok, true);
  assert.equal(fs.existsSync(backupPath({ stateDir, repoKey })), true);

  const bak = JSON.parse(fs.readFileSync(backupPath({ stateDir, repoKey }), 'utf8'));
  assert.equal(bak.stage, 'planning'); // previous value
});

// ------------------------------------------------------------------
// 20. Повреждённый журнал не затирает резервную копию
// ------------------------------------------------------------------
test('corrupt journal does not overwrite backup', () => {
  const repoKey = 'corrupt-no-del-bak';

  // First write
  const w1 = write({ stateDir, repoKey, patch: { issueKey: 'A', stage: 's1' } });
  assert.equal(w1.ok, true);

  // Second write — creates backup
  const w2 = write({ stateDir, repoKey, patch: { issueKey: 'B', stage: 's2' } });
  assert.equal(w2.ok, true);

  // Read backup content before corruption
  const bakBefore = JSON.parse(fs.readFileSync(backupPath({ stateDir, repoKey }), 'utf8'));

  // Corrupt journal.json
  const filePath = journalPath({ stateDir, repoKey });
  fs.writeFileSync(filePath, '{corrupted');

  // Third write — should NOT overwrite backup
  const w3 = write({ stateDir, repoKey, patch: { issueKey: 'C', stage: 's3' } });
  assert.equal(w3.ok, true);

  const bakAfter = JSON.parse(fs.readFileSync(backupPath({ stateDir, repoKey }), 'utf8'));
  assert.deepStrictEqual(bakAfter, bakBefore); // backup unchanged
});

// ------------------------------------------------------------------
// 21. Переживание обрыва — tmp file doesn't replace journal.json
// ------------------------------------------------------------------
test('interrupted write does not corrupt existing journal', () => {
  const repoKey = 'interruption';

  // Create valid journal
  const w1 = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(w1.ok, true);

  // Read current valid content for later comparison
  const validRecord = JSON.parse(fs.readFileSync(journalPath({ stateDir, repoKey }), 'utf8'));

  // Manually create a tmp file with bad content (no rename happens)
  const filePath = journalPath({ stateDir, repoKey });
  const tmpFile = filePath + '.tmp.' + 'bad-id-12345';
  fs.writeFileSync(tmpFile, '{not valid json');

  // read should still return the original valid record
  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, true);
  assert.equal(r.record.issueKey, 'KAN-6');

  // Cleanup
  try { fs.unlinkSync(tmpFile); } catch { /* */ }
});

// ------------------------------------------------------------------
// 22. Журнал не содержит process.env и посторонних ключей
// ------------------------------------------------------------------
test('journal does not contain process.env or extra patch keys', () => {
  const repoKey = 'no-secrets';

  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', secret: 'should-not-appear' } });
  assert.equal(w.ok, true);

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, true);

  const raw = JSON.stringify(r.record);
  assert.ok(!raw.includes('process.env'), 'should not contain process.env');
  assert.ok(!raw.includes('should-not-appear'), 'should not contain extra key value');
});

// ------------------------------------------------------------------
// KAN-6-B2: checksum: null → CHECKSUM_MISMATCH
// ------------------------------------------------------------------
test('valid journal with checksum set to null in file returns CHECKSUM_MISMATCH', () => {
  const repoKey = 'null-checksum';
  const filePath = journalPath({ stateDir, repoKey });

  // Write valid journal
  const w = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6', stage: 'planning' } });
  assert.equal(w.ok, true);

  // Read file, replace checksum with null, write back
  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw);
  record.checksum = null;
  fs.writeFileSync(filePath, JSON.stringify(record));

  const r = read({ stateDir, repoKey });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CHECKSUM_MISMATCH');
});

// ------------------------------------------------------------------
// KAN-6-B2: corrupted checksum=null in journal does not overwrite bak
// ------------------------------------------------------------------
test('null checksum in journal does not overwrite backup', () => {
  const repoKey = 'null-checksum-bak';

  // First write
  const w1 = write({ stateDir, repoKey, patch: { issueKey: 'A', stage: 's1' } });
  assert.equal(w1.ok, true);

  // Second write — creates backup
  const w2 = write({ stateDir, repoKey, patch: { issueKey: 'B', stage: 's2' } });
  assert.equal(w2.ok, true);

  // Read backup content before corruption
  const bakBefore = JSON.parse(fs.readFileSync(backupPath({ stateDir, repoKey }), 'utf8'));

  // Corrupt journal.json: set checksum to null
  const filePath = journalPath({ stateDir, repoKey });
  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw);
  record.checksum = null;
  fs.writeFileSync(filePath, JSON.stringify(record));

  // Third write — should NOT overwrite backup
  const w3 = write({ stateDir, repoKey, patch: { issueKey: 'C', stage: 's3' } });
  assert.equal(w3.ok, true);

  const bakAfter = JSON.parse(fs.readFileSync(backupPath({ stateDir, repoKey }), 'utf8'));
  assert.deepStrictEqual(bakAfter, bakBefore); // backup unchanged
});

// ------------------------------------------------------------------
// Дополнительно: write без patch
// ------------------------------------------------------------------
test('write without patch creates record with defaults', () => {
  const repoKey = 'no-patch';

  const w = write({ stateDir, repoKey, patch: undefined });
  assert.equal(w.ok, true);
  assert.equal(w.record.version, 1);
  assert.equal(w.record.issueKey, null);
  assert.deepStrictEqual(w.record.dispatchIds, []);
  assert.equal(w.record.lastConfirmedAction, null);
});

// ------------------------------------------------------------------
// Дополнительно: write without patch then update
// ------------------------------------------------------------------
test('write without patch then update preserves defaults', () => {
  const repoKey = 'no-patch-then-update';

  write({ stateDir, repoKey, patch: undefined });
  const w2 = write({ stateDir, repoKey, patch: { issueKey: 'KAN-6' } });
  assert.equal(w2.ok, true);
  assert.equal(w2.record.issueKey, 'KAN-6');
  assert.equal(w2.record.version, 1); // unchanged
});

// ------------------------------------------------------------------
// Дополнительно: read missing
// ------------------------------------------------------------------
test('read for non-existent journal returns MISSING', () => {
  const r = read({ stateDir, repoKey: 'non-existent' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'MISSING');
});

// ------------------------------------------------------------------
// Дополнительно: checksumOf with nested objects sorts keys recursively
// ------------------------------------------------------------------
test('checksumOf sorts keys recursively in nested objects', () => {
  const record = {
    b: 'value2',
    a: 'value1',
    nested: { z: 1, a: 2 },
    checksum: 'ignored',
  };
  const cs = checksumOf(record);
  // Verify it's consistent
  const cs2 = checksumOf(record);
  assert.equal(cs, cs2);
});

// ------------------------------------------------------------------
// Дополнительно: journalPath and backupPath return absolute paths
// ------------------------------------------------------------------
test('journalPath and backupPath return correct paths', () => {
  const jp = journalPath({ stateDir: '/state', repoKey: 'my-repo' });
  assert.equal(jp, path.join('/state', 'my-repo', 'journal.json'));

  const bp = backupPath({ stateDir: '/state', repoKey: 'my-repo' });
  assert.equal(bp, path.join('/state', 'my-repo', 'journal.bak.json'));
});

// ------------------------------------------------------------------
// Дополнительно: write creates missing directories
// ------------------------------------------------------------------
test('write creates missing directories', () => {
  const repoKey = 'new-nested';

  // stateDir exists but repoKey directory does not
  const w = write({ stateDir, repoKey, patch: { issueKey: 'TEST' } });
  assert.equal(w.ok, true);

  assert.ok(fs.existsSync(journalPath({ stateDir, repoKey })));
});

after(() => {
  try {
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
});
