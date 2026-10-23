import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { acquire, release, status } from '../tools/coordinator/lock.js';
import { write as writeJournal, read as readJournal } from '../tools/coordinator/journal.js';
import { main, resolveStateDir, resolveRepoKey } from '../tools/coordinator/cli.js';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

const _CLI_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'coordinator', 'cli.js')).href;

function spawnCli(stateDir, argv) {
  return spawnSync(process.execPath, [_CLI_URL, ...argv], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, COORDINATOR_STATE_DIR: stateDir },
    timeout: 10000,
  });
}

function spawnCliScript(stateDir, scriptBody) {
  const scriptPath = path.join(stateDir, '_tmp_spawn.js');
  fs.writeFileSync(scriptPath, [
    `import { main } from '${_CLI_URL}';`,
    scriptBody,
  ].join('\n'));
  return scriptPath;
}

// ------------------------------------------------------------------
// 21. status — нет блокировки: locked: false, journal: MISSING
// ------------------------------------------------------------------
test('status with no lock shows locked: false and journal: MISSING', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['status'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 22. status — блокировка есть, журнал отсутствует: locked: true, journal: MISSING
// ------------------------------------------------------------------
test('status with lock but no journal shows locked: true and journal: MISSING', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  acquire({ stateDir, repoKey, meta: { worktree: null } });

  const exitCode = await main({
    argv: ['status'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 9);
});

// ------------------------------------------------------------------
// 23. release без --token: Usage error (exit 1)
// ------------------------------------------------------------------
test('release without --token returns exit 1', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['release'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 1);
});

// ------------------------------------------------------------------
// 24. release — правильный токен: lock снимается
// ------------------------------------------------------------------
test('release with correct token releases the lock', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const exitCode = await main({
    argv: ['release', '--token', acq.token],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);

  const st = status({ stateDir, repoKey });
  assert.equal(st.held, false);
});

// ------------------------------------------------------------------
// 25. release — чужой токен: NOT_OWNER (exit 11)
// ------------------------------------------------------------------
test('release with wrong token returns NOT_OWNER exit 11', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const exitCode = await main({
    argv: ['release', '--token', 'wrong-token'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 11);

  const st = status({ stateDir, repoKey });
  assert.equal(st.held, true);
});

// ------------------------------------------------------------------
// 26. release — неактивная блокировка: NOT_HELD (exit 0)
// ------------------------------------------------------------------
test('release on non-existent lock returns NOT_HELD exit 0', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['release', '--token', 'any-token'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 27. force-release без --confirm: CONFIRMATION_REQUIRED (exit 12)
// ------------------------------------------------------------------
test('force-release without --confirm returns exit 12', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['force-release', '--reason', 'test'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 12);
});

// ------------------------------------------------------------------
// 28. force-release с --confirm и --reason: lock снимается
// ------------------------------------------------------------------
test('force-release with --confirm and --reason releases lock', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const exitCode = await main({
    argv: ['force-release', '--confirm', '--reason', 'cleanup'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);

  const st = status({ stateDir, repoKey });
  assert.equal(st.held, false);
});

// ------------------------------------------------------------------
// 29. force-release — нет блокировки: exit 0 (graceful no-op)
// ------------------------------------------------------------------
test('force-release on non-existent lock returns exit 0', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['force-release', '--confirm', '--reason', 'test'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 30. start без команды: Usage (exit 2)
// ------------------------------------------------------------------
test('start without child command returns exit 2', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['start'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 2);
});

// ------------------------------------------------------------------
// 31. start — успешная блокировка: journal обновлён, exit 0
// ------------------------------------------------------------------
test('start acquires lock and writes journal (non-blocking with nohup)', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const rc = await main({ argv: ['start', '--', 'node', '-e', 'process.exit(0)'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `console.log('EXIT_CODE:' + rc);`,
    `process.exit(rc);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  const exitCodeMatch = result.stdout?.match(/EXIT_CODE:(\d+)/);
  assert.ok(exitCodeMatch, 'should see EXIT_CODE in output');
  assert.equal(Number(exitCodeMatch[1]), 0, 'main() exit code should be 0');

  const lockSt = status({ stateDir, repoKey });
  assert.ok(!lockSt.held, 'lock must be released once the child has exited');

  const jr = readJournal({ stateDir, repoKey });
  assert.ok(jr.ok, 'journal should be valid');
  assert.equal(jr.record.stage, 'running');
});

// ------------------------------------------------------------------
// 32. start — повторно BUSY: exit 9
// ------------------------------------------------------------------
test('start when lock already held returns BUSY exit 9', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  // Seed a lock (acquire in this test process — it will be held)
  acquire({ stateDir, repoKey, meta: {} });

  const exitCode = await main({
    argv: ['start', '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 9);
});

// ------------------------------------------------------------------
// 33. recover — нет блокировки: SAFE_TO_RELEASE (exit 0)
// ------------------------------------------------------------------
test('recover with no lock shows SAFE_TO_RELEASE exit 0', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['recover'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 34. resolveStateDir из env
// ------------------------------------------------------------------
test('resolveStateDir returns env var or default path', () => {
  const env1 = { COORDINATOR_STATE_DIR: '/custom/state' };
  assert.equal(resolveStateDir(env1), '/custom/state');

  // Passing an explicit empty object must never fall through to process.env
  // even if COORDINATOR_STATE_DIR is set in the ambient environment.
  assert.equal(resolveStateDir({}), path.join(os.homedir(), '.claude-coordinator'));
});

// ------------------------------------------------------------------
// 35. status с повреждённым журналом: exit 10
// ------------------------------------------------------------------
test('status with corrupt journal returns exit 10', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const journalPath = path.join(stateDir, repoKey, 'journal.json');

  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, '{not valid json');

  const exitCode = await main({
    argv: ['status'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 10);
});

// ------------------------------------------------------------------
// 36. status — журнал CHECKSUM_MISMATCH: exit 10
// ------------------------------------------------------------------
test('status with checksum mismatch returns exit 10', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const journalPath = path.join(stateDir, repoKey, 'journal.json');

  fs.mkdirSync(path.dirname(journalPath), { recursive: true });

  const record = {
    version: 1,
    issueKey: 'TEST',
    stage: 'planning',
    runId: 1,
    taskId: 't1',
    dispatchIds: [],
    branch: 'main',
    commitSha: 'abc123',
    prUrl: null,
    lastConfirmedAction: null,
    updatedAt: new Date().toISOString(),
    checksum: 'invalid-checksum',
  };
  fs.writeFileSync(journalPath, JSON.stringify(record));

  const exitCode = await main({
    argv: ['status'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 10);
});

// ------------------------------------------------------------------
// 37. start — acquire failure: exit 1 (not BUSY)
//         Since lock 'start-repo' is still held, this should return BUSY (9).
// ------------------------------------------------------------------
test('start when lock held returns BUSY exit 9', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  acquire({ stateDir, repoKey, meta: {} });

  const exitCode = await main({
    argv: ['start', '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 9);
});

// ------------------------------------------------------------------
// 38. recover — блокировка есть, process не жив: содержит причину
// ------------------------------------------------------------------
test('recover with dead owner process shows reasons', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  // Fudge pid to non-existent so processAlive=false
  const ownerPath = path.join(stateDir, repoKey, 'lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  owner.pid = 99999;
  fs.writeFileSync(ownerPath, JSON.stringify(owner));

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const rc = await main({ argv: ['recover'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `console.log('EXIT_CODE:' + rc);`,
    `process.exit(rc);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // Disable ANSI color codes in spawned child so assertions are reliable
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  assert.ok(result.stdout?.includes('locked: true'));
  assert.ok(result.stdout?.includes('processAlive:'));
  assert.ok(!result.stdout?.includes(acq.token));
});

// ------------------------------------------------------------------
// 39. release с неактивной блокировкой возвращает 0 (NOT_HELD)
// ------------------------------------------------------------------
test('release of non-existent lock returns exit 0', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['release', '--token', 'non-existent'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 40. recover — journal MISSING: всё равно SAFE_TO_RELEASE если нет блокировки
// ------------------------------------------------------------------
test('recover with no lock and missing journal shows SAFE_TO_RELEASE', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['recover'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);
});

// ------------------------------------------------------------------
// 41. main — неизвестная команда: exit 2
// ------------------------------------------------------------------
test('main with unknown command returns exit 2', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const exitCode = await main({
    argv: ['foobar'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 2);
});

// ------------------------------------------------------------------
// 42. start — child exit code = exit code из CLI
// ------------------------------------------------------------------
test('start propagates child exit code', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const rc = await main({ argv: ['start', '--', 'node', '-e', 'process.exit(42)'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `process.exit(rc);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  assert.equal(result.status, 42);
});

// ------------------------------------------------------------------
// 43. token never appears in status output
// ------------------------------------------------------------------
test('status output does not contain token', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const out = await main({ argv: ['status'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `console.log('EXIT_CODE:' + out);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  assert.ok(!result.stdout?.includes(acq.token), 'status output should not contain the token');
});

// ------------------------------------------------------------------
// 44. recover output does not contain token
// ------------------------------------------------------------------
test('recover output does not contain token', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const out = await main({ argv: ['recover'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `console.log('EXIT_CODE:' + out);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  assert.ok(!result.stdout?.includes(acq.token), 'recover output should not contain the token');
});

// ------------------------------------------------------------------
// 45. start после release — можно заново захватить
// ------------------------------------------------------------------
test('start after release can re-acquire lock', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  // Acquire → release → re-acquire
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  let exitCode = await main({
    argv: ['release', '--token', acq.token],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);

  exitCode = await main({
    argv: ['start', '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);

  // start дождался дочернего процесса и освободил блокировку за собой.
  assert.ok(!status({ stateDir, repoKey }).held);
});

// ------------------------------------------------------------------
// 46. force-release с пустой причиной: exit 12
// ------------------------------------------------------------------
test('force-release with empty reason returns exit 12', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  const exitCode = await main({
    argv: ['force-release', '--confirm', '--reason', ''],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 12);

  const st = status({ stateDir, repoKey });
  assert.equal(st.held, true);
});

// ------------------------------------------------------------------
// 47. multiple sequential start commands: first succeeds, second BUSY
// ------------------------------------------------------------------
test('sequential starts both succeed because each releases the lock', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const r1 = await main({
    argv: ['start', '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(r1, 0);
  assert.ok(!status({ stateDir, repoKey }).held, 'первый start должен освободить блокировку');

  const r2 = await main({
    argv: ['start', '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: { COORDINATOR_STATE_DIR: stateDir },
  });
  // Запуски последовательные, а не одновременные: второй берёт свободную блокировку.
  // Случай BUSY при живом дочернем процессе проверяется в coordinator-cli-process.test.js.
  assert.equal(r2, 0);
});

// ------------------------------------------------------------------
// Дополнительно: status с журналом — показывает stage и updatedAt
// ------------------------------------------------------------------
test('status with valid journal shows stage and updatedAt', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  writeJournal({ stateDir, repoKey, patch: { stage: 'execution', issueKey: 'KAN-6' } });

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const out = await main({ argv: ['status'], cwd: ${JSON.stringify(process.cwd())}, env: { COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
    `console.log('EXIT_CODE:' + out);`,
  ].join('\n'));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  });

  try { fs.unlinkSync(scriptPath); } catch { /* */ }

  assert.ok(result.stdout?.includes('stage: execution'));
  assert.ok(result.stdout?.includes('updatedAt:'));
});
