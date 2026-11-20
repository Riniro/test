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
import { safeCredentialsEnv, liveEnv, liveOfCandidate, writeStubs } from './helpers/route-env.js';

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
    env: { ...process.env, ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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


// A fresh candidate in the journal plus stubs for everything `start` asks: the live re-read (pickup, gh)
// and a claim gate that always captures. `start` also needs --project/--repo/--issue/--mode.
// The environment names JIRA_CREDENTIALS_FILE (test values, a closed local address): if a stub is ever
// mis-wired, the route fails safely instead of reaching a real Jira.
function routeSetup(stateDir, { candidate } = {}) {
  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const cand = candidate || { issueKey: 'KAN-14', mode: 'implement', pr: null, createdAt: new Date().toISOString() };
  writeJournal({ stateDir, repoKey, patch: { candidate: cand } });
  const stub = path.join(stateDir, '_claim_stub.mjs');
  fs.writeFileSync(stub, "process.stdout.write(JSON.stringify({ success: true, state: 'claimed', reason: 'claimed', mode: 'implement', pr: null }) + '\\n');");
  return {
    env: { ...liveEnv(stateDir, liveOfCandidate(cand)), COORDINATOR_STATE_DIR: stateDir, PRECHECK_CLAIM_SCRIPT: stub },
    flags: ['--project', 'KAN', '--repo', 'o/r', '--issue', 'KAN-14', '--mode', 'implement'],
  };
}

// An owner record of THIS host whose process has already exited: the only "proven dead" owner.
function plantOwner(stateDir, repoKey, owner) {
  const lockPath = path.join(stateDir, repoKey, 'lock');
  fs.mkdirSync(lockPath, { recursive: true });
  if (owner !== null) fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner));
  return lockPath;
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function ownerRecord(over = {}) {
  const now = new Date().toISOString();
  return { token: 'secret-token-value', pid: process.pid, host: os.hostname(), repoKey: 'k', acquiredAt: now, heartbeatAt: now, worktree: null, ...over };
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 12);
});

// ------------------------------------------------------------------
// 28. force-release с --confirm и --reason: lock снимается
// ------------------------------------------------------------------
test('force-release with --confirm and --reason releases lock of a proven dead owner', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  plantOwner(stateDir, repoKey, ownerRecord({ pid: deadPid() }));

  const exitCode = await main({
    argv: ['force-release', '--confirm', '--reason', 'cleanup'],
    cwd: process.cwd(),
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 2);
});

// ------------------------------------------------------------------
// 31. start — успешная блокировка: journal обновлён, exit 0
// ------------------------------------------------------------------
test('start acquires lock and writes journal (non-blocking with nohup)', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const rc = await main({ argv: ['start', ...${JSON.stringify(rt.flags)}, '--', 'node', '-e', 'process.exit(0)'], cwd: ${JSON.stringify(process.cwd())}, env: ${JSON.stringify(rt.env)} });`,
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
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  // Seed a lock (acquire in this test process — it will be held)
  acquire({ stateDir, repoKey, meta: {} });

  const exitCode = await main({
    argv: ['start', ...rt.flags, '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: rt.env,
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  acquire({ stateDir, repoKey, meta: {} });

  const exitCode = await main({
    argv: ['start', ...rt.flags, '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: rt.env,
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
    `const rc = await main({ argv: ['recover'], cwd: ${JSON.stringify(process.cwd())}, env: { ...${JSON.stringify(safeCredentialsEnv())}, COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 2);
});

// ------------------------------------------------------------------
// 42. start — child exit code = exit code из CLI
// ------------------------------------------------------------------
test('start propagates child exit code', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const scriptPath = spawnCliScript(stateDir, [
    `process.env.COORDINATOR_STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const rc = await main({ argv: ['start', ...${JSON.stringify(rt.flags)}, '--', 'node', '-e', 'process.exit(42)'], cwd: ${JSON.stringify(process.cwd())}, env: ${JSON.stringify(rt.env)} });`,
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
    `const out = await main({ argv: ['status'], cwd: ${JSON.stringify(process.cwd())}, env: { ...${JSON.stringify(safeCredentialsEnv())}, COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
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
    `const out = await main({ argv: ['recover'], cwd: ${JSON.stringify(process.cwd())}, env: { ...${JSON.stringify(safeCredentialsEnv())}, COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
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
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  // Acquire → release → re-acquire
  const acq = acquire({ stateDir, repoKey, meta: {} });
  assert.equal(acq.ok, true);

  let exitCode = await main({
    argv: ['release', '--token', acq.token],
    cwd: process.cwd(),
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
  });
  assert.equal(exitCode, 0);

  exitCode = await main({
    argv: ['start', ...rt.flags, '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: rt.env,
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
    env: { ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir },
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
  const rt = routeSetup(stateDir);

  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const lockPath = path.join(stateDir, repoKey, 'lock');
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* */ }

  const r1 = await main({
    argv: ['start', ...rt.flags, '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: rt.env,
  });
  assert.equal(r1, 0);
  assert.ok(!status({ stateDir, repoKey }).held, 'первый start должен освободить блокировку');

  const r2 = await main({
    argv: ['start', ...rt.flags, '--', 'node', '-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: rt.env,
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
    `const out = await main({ argv: ['status'], cwd: ${JSON.stringify(process.cwd())}, env: { ...${JSON.stringify(safeCredentialsEnv())}, COORDINATOR_STATE_DIR: ${JSON.stringify(stateDir)} } });`,
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

// ------------------------------------------------------------------
// R5.6 (second half) — 4m59s old is still inside the term, but the live checks STILL run.
// In-process on purpose: the gap between seeding and the age check must be milliseconds,
// not a process start, or the boundary case would depend on machine load.
// ------------------------------------------------------------------
test('R5.6: a candidate 4m59s old is not expired, and the live check (the gate) is still called', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const log = path.join(stateDir, 'claim-calls');
  const stub = path.join(stateDir, '_claim_counting_stub.mjs');
  fs.writeFileSync(stub, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(log)}, 'call\\n');`,
    "process.stdout.write(JSON.stringify({ success: true, state: 'claimed', reason: 'claimed', mode: 'implement', pr: null }) + '\\n');",
  ].join('\n'));
  const marker = path.join(stateDir, 'ran');
  writeJournal({
    stateDir, repoKey,
    patch: { candidate: { issueKey: 'KAN-14', mode: 'implement', pr: null, createdAt: new Date(Date.now() - (4 * 60 + 59) * 1000).toISOString() } },
  });

  const rc = await main({
    argv: ['start', '--project', 'KAN', '--repo', 'o/r', '--issue', 'KAN-14', '--mode', 'implement', '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
    cwd: process.cwd(),
    env: { ...liveEnv(stateDir, {}), COORDINATOR_STATE_DIR: stateDir, PRECHECK_CLAIM_SCRIPT: stub },
  });
  assert.equal(rc, 0);
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1, 'a not-yet-expired record does not replace the re-check');
  assert.ok(fs.existsSync(marker));
});

test('R5.6: a candidate 5m01s old is expired (16): the same setup, the gate is not called', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const log = path.join(stateDir, 'claim-calls');
  const stub = path.join(stateDir, '_claim_counting_stub.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, 'call\\n');`);
  writeJournal({
    stateDir, repoKey,
    patch: { candidate: { issueKey: 'KAN-14', mode: 'implement', pr: null, createdAt: new Date(Date.now() - (5 * 60 + 1) * 1000).toISOString() } },
  });
  const rc = await main({
    argv: ['start', '--project', 'KAN', '--repo', 'o/r', '--issue', 'KAN-14', '--mode', 'implement', '--', process.execPath, '-e', ''],
    cwd: process.cwd(),
    env: { ...liveEnv(stateDir, {}), COORDINATOR_STATE_DIR: stateDir, PRECHECK_CLAIM_SCRIPT: stub },
  });
  assert.equal(rc, 16);
  assert.ok(!fs.existsSync(log));
});

// ==================================================================
// Fix round, R3 + R4 — in-process on purpose: these tests need to hold the clock or the file system
// still for the duration of ONE main() call, which a separate process cannot offer.
// What they borrow (Date.now, fs.renameSync, fs.readFileSync, ChildProcess.prototype.kill, process.emit)
// is a method of a built-in; no module is replaced and no environment variable is added.
// Everything borrowed is restored in `finally`, also when the test fails.
// ==================================================================
import { ChildProcess } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(file, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    await sleep(25);
  }
  return false;
}

/**
 * Runs main() with stderr captured; restored in finally. stdout is NOT captured: under `node --test` a test file
 * reports its results to the runner through stdout, and a swallowed write is a swallowed test result.
 */
async function captureMain(opts) {
  const err = [];
  const ew = process.stderr.write;
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const rc = await main(opts);
    return { rc, stdout: '', stderr: err.join('') };
  } finally {
    process.stderr.write = ew;
  }
}

const CLAIMED_OUT = { success: true, state: 'claimed', reason: 'claimed', mode: 'implement', pr: null };

/** routeSetup plus a counting claim stub; returns the env, flags, a marker file and a child that writes it. */
function countingRoute(stateDir, opts) {
  const rt = routeSetup(stateDir, opts);
  const stubs = writeStubs(stateDir);
  const marker = path.join(stateDir, 'executor-ran');
  const claimLog = path.join(stateDir, 'claim.log');
  rt.env = { ...rt.env, PRECHECK_CLAIM_SCRIPT: stubs.claim, CL_CODE: '0', CL_OUT: JSON.stringify(CLAIMED_OUT), CL_LOG: claimLog };
  rt.marker = marker;
  rt.claimLog = claimLog;
  rt.childArgs = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  rt.repoKey = resolveRepoKey({ cwd: process.cwd() });
  rt.claimCalls = () => (fs.existsSync(claimLog) ? fs.readFileSync(claimLog, 'utf8').split('\n').filter(Boolean).length : 0);
  rt.run = () => captureMain({ argv: ['start', ...rt.flags, '--', ...rt.childArgs], cwd: process.cwd(), env: rt.env });
  return rt;
}

/** Calls `after(path)` once after the first call of fs[name] whose path matches; the call itself is real. */
function afterFirst(name, match, after_) {
  const real = fs[name];
  let fired = false;
  fs[name] = function patched(...a) {
    const r = real.apply(this, a);
    const p = String(name === 'renameSync' ? a[1] : a[0]);
    if (!fired && match(p, a)) { fired = true; after_(p); }
    return r;
  };
  return () => { fs[name] = real; };
}

const DIFFERENT_CLAIM = { issueKey: 'KAN-14', state: 'claimed', mode: 'implement', pr: null, createdAt: '2000-01-01T00:00:00.000Z' };

// ------------------------------------------------------------------
// R3 — the age of the ACCEPTED result (step 10)
// ------------------------------------------------------------------
test('R3: the accepted result expires between its save and the spawn → 16, no executor, an orphan is recorded', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);

  const realNow = Date.now;
  let calls = 0;
  // the first reading is the real one (the candidate is fresh); every later one is 6 minutes ahead
  Date.now = () => (calls++ === 0 ? realNow() : realNow() + 6 * 60 * 1000);
  let res;
  try {
    res = await rt.run();
  } finally {
    Date.now = realNow;
  }
  assert.equal(res.rc, 16, res.stderr);
  assert.ok(!fs.existsSync(rt.marker), 'the executor must not have been started');
  assert.equal(rt.claimCalls(), 1, 'the claim happened');
  assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held, 'the lock is released');
  const o = readJournal({ stateDir, repoKey: rt.repoKey }).record.orphanedClaim;
  assert.ok(o, 'an orphanedClaim must be written');
  assert.equal(o.code, 16);
  assert.equal(o.state, 'claimed');
  assert.match(res.stderr, /ORPHANED_CLAIM: KAN-14 implement code=16 /);
});

// ------------------------------------------------------------------
// R3 — read-back divergence. The journal gets a VALID but DIFFERENT record (the checksum matches,
// the content does not) right after the write: only a content comparison notices.
// ------------------------------------------------------------------
test('R3: start — the accepted result read back differs from the one written → 5, no executor, an orphan is recorded', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);

  const restore = afterFirst('renameSync',
    (p) => p.endsWith('journal.json') && (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).claim !== null; } catch { return false; } })(),
    () => { writeJournal({ stateDir, repoKey: rt.repoKey, patch: { claim: DIFFERENT_CLAIM } }); });
  let res;
  try {
    res = await rt.run();
  } finally {
    restore();
  }
  assert.equal(res.rc, 5, res.stderr);
  assert.ok(!fs.existsSync(rt.marker), 'the executor must not have been started');
  assert.equal(rt.claimCalls(), 1);
  assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held);
  const rec = readJournal({ stateDir, repoKey: rt.repoKey }).record;
  assert.deepStrictEqual(rec.claim, DIFFERENT_CLAIM, 'premise: the divergence really happened');
  assert.ok(rec.orphanedClaim, 'an orphanedClaim must be written');
  assert.equal(rec.orphanedClaim.code, 5);
  assert.match(res.stderr, /ORPHANED_CLAIM: KAN-14 implement code=5 .*not saved/);
});

test('R3: precheck — the candidate read back differs from the one written → 5, the candidate is not accepted', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const repoKey = resolveRepoKey({ cwd: process.cwd() });
  const other = { issueKey: 'KAN-99', mode: 'implement', pr: null, createdAt: '2000-01-01T00:00:00.000Z' };
  const env = { ...liveEnv(stateDir, {}), COORDINATOR_STATE_DIR: stateDir };

  const restore = afterFirst('renameSync',
    (p) => p.endsWith('journal.json') && (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).candidate !== null; } catch { return false; } })(),
    () => { writeJournal({ stateDir, repoKey, patch: { candidate: other } }); });
  let res;
  try {
    res = await captureMain({ argv: ['precheck', '--project', 'KAN', '--repo', 'o/r'], cwd: process.cwd(), env });
  } finally {
    restore();
  }
  assert.equal(res.rc, 5, res.stdout + res.stderr);
  assert.doesNotMatch(res.stdout, /"candidate"/, 'the candidate must not be reported as saved');
  assert.deepStrictEqual(readJournal({ stateDir, repoKey }).record.candidate, other, 'premise: the divergence really happened');
});

// ------------------------------------------------------------------
// R4 — signals are handled from the moment the lock is taken
// ------------------------------------------------------------------
test('R4: a signal between the lock and the spawn (during the synchronous gate calls) → no executor, the lock is released, non-zero code', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  const baseline = process.listenerCount('SIGTERM');

  // The signal lands right after the journal is read: the candidate step is done, the gates are still ahead.
  const restore = afterFirst('readFileSync', (p) => p.endsWith('journal.json'), () => { process.emit('SIGTERM', 'SIGTERM'); });
  let res;
  try {
    res = await rt.run();
  } finally {
    restore();
  }
  assert.equal(res.rc, 143, 'a signal is a non-zero code: ' + res.stderr);
  assert.ok(!fs.existsSync(rt.marker), 'the executor must not have been started');
  assert.equal(rt.claimCalls(), 0, 'nothing was captured: the stop is before the claim');
  assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held, 'the lock is released');
  assert.equal(readJournal({ stateDir, repoKey: rt.repoKey }).record.orphanedClaim, null, 'nothing was captured, so no orphan');
  assert.equal(process.listenerCount('SIGTERM'), baseline, 'the handler is removed');
});

test('R4: a signal after the claim but before the spawn → no executor, lock released, and an orphan (the labels changed)', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  const baseline = process.listenerCount('SIGINT');

  const restore = afterFirst('renameSync',
    (p) => p.endsWith('journal.json') && (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).claim !== null; } catch { return false; } })(),
    () => { process.emit('SIGINT', 'SIGINT'); });
  let res;
  try {
    res = await rt.run();
  } finally {
    restore();
  }
  assert.equal(res.rc, 130, res.stderr);
  assert.ok(!fs.existsSync(rt.marker));
  assert.equal(rt.claimCalls(), 1);
  assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held);
  const o = readJournal({ stateDir, repoKey: rt.repoKey }).record.orphanedClaim;
  assert.ok(o, 'an orphanedClaim must be written');
  assert.equal(o.code, 130);
  assert.match(res.stderr, /ORPHANED_CLAIM: KAN-14 implement code=130 .*SIGINT/);
  assert.equal(process.listenerCount('SIGINT'), baseline, 'the handler is removed');
});

function writeLongChild(dir, readyFile, goFile) {
  const script = path.join(dir, 'long-executor.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
    `const tick = () => { if (fs.existsSync(${JSON.stringify(goFile)})) process.exit(0); else setTimeout(tick, 25); };`,
    'tick();',
  ].join('\n'));
  return script;
}

test('R4: a signal while the executor works is FORWARDED, and the lock is NOT released until the executor has actually finished', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  const ready = path.join(stateDir, 'ready');
  const go = path.join(stateDir, 'go');
  rt.childArgs = [process.execPath, writeLongChild(stateDir, ready, go)];
  const baseline = process.listenerCount('SIGTERM');

  // On Windows kill() ends a process at once, so a child that "outlives" the signal cannot exist there:
  // the forwarding is observed through kill() and the child is kept alive, which is exactly the situation
  // "the executor is still working" that the lock rule is about.
  const realKill = ChildProcess.prototype.kill;
  const kills = [];
  ChildProcess.prototype.kill = function patchedKill(sig) { kills.push(sig); return true; };
  let p;
  try {
    p = rt.run();
    assert.ok(await waitFor(ready), 'the executor must start');
    assert.ok(status({ stateDir, repoKey: rt.repoKey }).held, 'the lock is held while the executor works');

    process.emit('SIGTERM', 'SIGTERM');
    assert.deepStrictEqual(kills, ['SIGTERM'], 'the signal is passed to the child');
    await sleep(300); // bounded: the only way to show that something did NOT happen
    assert.ok(status({ stateDir, repoKey: rt.repoKey }).held, 'the lock must stay while the executor is still alive');

    fs.writeFileSync(go, 'x');
    const res = await p;
    assert.equal(res.rc, 0, 'the code of the executor, which has now finished');
    assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held, 'released only after the executor is gone');
    assert.equal(process.listenerCount('SIGTERM'), baseline, 'the handler is removed');
  } finally {
    ChildProcess.prototype.kill = realKill;
    try { fs.writeFileSync(go, 'x'); } catch { /* gone */ }
    if (p) await p.catch(() => {});
  }
});

test('R4: a signal while the executor works and the child REALLY ends → the lock is released after it, the executor process is gone', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  const ready = path.join(stateDir, 'ready');
  const go = path.join(stateDir, 'never-created');
  rt.childArgs = [process.execPath, writeLongChild(stateDir, ready, go)];
  const baseline = process.listenerCount('SIGTERM');

  const p = rt.run();
  try {
    assert.ok(await waitFor(ready));
    const childPid = Number(fs.readFileSync(ready, 'utf8'));
    process.emit('SIGTERM', 'SIGTERM');
    const res = await p;
    assert.notEqual(res.rc, 0, 'the executor was stopped by the signal');
    assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held, 'the lock is released once the executor is gone');
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert.ok(!alive, 'no executor process is left');
    assert.equal(process.listenerCount('SIGTERM'), baseline);
  } finally {
    fs.writeFileSync(go, 'x');
    await p.catch(() => {});
  }
});

test('R4: repeated main() calls do not accumulate signal handlers', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  for (let i = 0; i < 3; i++) {
    const rt = countingRoute(stateDir);
    const res = await rt.run();
    assert.equal(res.rc, 0, res.stderr);
    fs.rmSync(rt.marker, { force: true });
  }
  assert.deepStrictEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

// ------------------------------------------------------------------
// R2 — an exception after the claim is "captured but not started" too
// ------------------------------------------------------------------
test('R2: an exception after the claim (spawn throws on an invalid command) → an orphan, the lock is released', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  rt.childArgs = ['bad\u0000command'];
  const res = await rt.run();
  assert.notEqual(res.rc, 0, res.stderr);
  assert.equal(rt.claimCalls(), 1);
  assert.ok(!status({ stateDir, repoKey: rt.repoKey }).held);
  const o = readJournal({ stateDir, repoKey: rt.repoKey }).record.orphanedClaim;
  assert.ok(o, 'an orphanedClaim must be written: ' + res.stderr);
  assert.match(o.reason, /exception after the claim/);
  assert.match(res.stderr, /ORPHANED_CLAIM: KAN-14 implement code=1 exception after the claim/);
});

// ------------------------------------------------------------------
// R5 — a mis-wired gate must fail SAFELY. These tests run the REAL pickup.js and claim.js on purpose,
// with the test credentials (a closed local address), and show that nothing leaves the machine.
// ------------------------------------------------------------------
test('R5: the route with the gate scripts NOT replaced fails safely on the local address: source unavailable, no executor, no claim', async (t) => {
  const stateDir = tmpDir();
  t.after(() => cleanup(stateDir));
  const rt = countingRoute(stateDir);
  // deliberately NOT replaced: PRECHECK_PICKUP_SCRIPT and PRECHECK_CLAIM_SCRIPT -> the real pickup.js / claim.js
  delete rt.env.PRECHECK_PICKUP_SCRIPT;
  delete rt.env.PRECHECK_CLAIM_SCRIPT;
  assert.match(fs.readFileSync(rt.env.JIRA_CREDENTIALS_FILE, 'utf8'), /127\.0\.0\.1/, 'premise: the credentials point to a local address');
  assert.doesNotMatch(fs.readFileSync(rt.env.JIRA_CREDENTIALS_FILE, 'utf8'), /atlassian/i);
  const res = await rt.run();
  assert.equal(res.rc, 4, 'the real pickup cannot reach its source: unavailable. ' + res.stderr + res.stdout);
  assert.ok(!fs.existsSync(rt.marker), 'no executor');
  assert.equal(rt.claimCalls(), 0, 'the stub gate was not involved at all');
});
