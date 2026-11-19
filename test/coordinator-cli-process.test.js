// Интеграционные тесты НАСТОЯЩЕГО запуска CLI координатора.
//
// Эти тесты никогда не вызывают main() напрямую и не импортируют cli.js:
// они запускают `node tools/coordinator/cli.js ...` отдельным процессом,
// как это делает человек или автоматика.
//
// Синхронизация — по файлам-сигналам и по событию exit дочернего процесса,
// а не по фиксированным задержкам. Файлы-сигналы лежат в отдельном рабочем
// каталоге и не смешиваются с каталогом состояния координатора.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'coordinator', 'cli.js');

const READY_TIMEOUT_MS = 15000;
const POLL_MS = 50;

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* каталог мог быть уже удалён */ }
}

/** Ждёт появления файла, опрашивая его; возвращает false по истечении потолка. */
async function waitForFile(filePath, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

/**
 * Пишет во временный каталог дочерний скрипт, который сообщает о готовности
 * файлом readyFile и завершается, когда появится goFile.
 */
function writeLongLivedChild(scratch, readyFile, goFile) {
  const scriptPath = path.join(scratch, 'long-child.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
      `const goFile = ${JSON.stringify(goFile)};`,
      'const tick = () => {',
      '  if (fs.existsSync(goFile)) process.exit(0);',
      `  else setTimeout(tick, ${POLL_MS});`,
      '};',
      'tick();',
    ].join('\n'),
  );
  return scriptPath;
}

/** Пишет дочерний скрипт, который только создаёт файл-маркер. */
function writeMarkerChild(scratch, markerFile) {
  const scriptPath = path.join(scratch, 'marker-child.mjs');
  fs.writeFileSync(
    scriptPath,
    ["import fs from 'node:fs';", `fs.writeFileSync(${JSON.stringify(markerFile)}, 'ran');`].join('\n'),
  );
  return scriptPath;
}

/** Синхронный запуск настоящей команды CLI. */
function runCli(args, stateDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, COORDINATOR_STATE_DIR: stateDir },
  });
}

/** Фоновый запуск настоящей команды CLI; возвращает процесс и промис его кода. */
function startCli(args, stateDir) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, COORDINATOR_STATE_DIR: stateDir },
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

/**
 * Путь к каталогу блокировки внутри каталога состояния.
 * repoKey не выдумывается: берётся единственный подкаталог, созданный CLI.
 */
function lockDirOf(stateDir) {
  if (!fs.existsSync(stateDir)) return null;
  const dirs = fs.readdirSync(stateDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length === 0) return null;
  return path.join(stateDir, dirs[0].name, 'lock');
}

function lockHeld(stateDir) {
  const dir = lockDirOf(stateDir);
  return dir !== null && fs.existsSync(dir);
}

// ---------------------------------------------------------------------------
// 1. CLI запускает команду, передаёт аргументы и вывод, возвращает её код
// ---------------------------------------------------------------------------
test('CLI runs the child command, forwards args and output, returns its exit code', (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  const scratch = mkTmp('cli-proc-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });

  const childScript = path.join(scratch, 'echo-child.mjs');
  fs.writeFileSync(
    childScript,
    [
      "process.stdout.write('HELLO:' + process.argv[2] + '\\n');",
      "process.stderr.write('CHILD_STDERR\\n');",
      'process.exit(42);',
    ].join('\n'),
  );

  const result = runCli(['start', '--', process.execPath, childScript, 'ARG1'], stateDir);

  assert.equal(result.status, 42, 'CLI должен вернуть код дочернего процесса');
  assert.match(result.stdout, /HELLO:ARG1/, 'аргумент и stdout дочернего процесса должны пройти наружу');
  assert.match(result.stderr, /CHILD_STDERR/, 'stderr дочернего процесса должен пройти наружу');
});

// ---------------------------------------------------------------------------
// 2. Пока дочерняя команда работает, второй запуск получает BUSY
// ---------------------------------------------------------------------------
test('while the child is running, a second CLI run gets BUSY and does not start its command', async (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  const scratch = mkTmp('cli-proc-scratch-');
  const readyFile = path.join(scratch, 'ready');
  const goFile = path.join(scratch, 'go');
  const markerFile = path.join(scratch, 'second-ran');

  t.after(() => {
    try { fs.writeFileSync(goFile, 'x'); } catch { /* уже убрано */ }
    rmTmp(stateDir);
    rmTmp(scratch);
  });

  const longChild = writeLongLivedChild(scratch, readyFile, goFile);
  const markerChild = writeMarkerChild(scratch, markerFile);

  const first = startCli(['start', '--', process.execPath, longChild], stateDir);

  assert.ok(await waitForFile(readyFile), 'дочерняя команда должна подать сигнал готовности');
  assert.ok(lockHeld(stateDir), 'блокировка должна удерживаться, пока дочерняя команда работает');

  const second = runCli(['start', '--', process.execPath, markerChild], stateDir);

  assert.equal(second.status, 9, 'второй запуск должен вернуть 9');
  assert.match(second.stdout, /BUSY/, 'второй запуск должен напечатать BUSY');
  assert.ok(!fs.existsSync(markerFile), 'второй запуск не должен запускать свою команду');

  fs.writeFileSync(goFile, 'x');
  const firstExit = await first.exited;
  assert.equal(firstExit.code, 0, 'первый запуск должен завершиться штатно');
});

// ---------------------------------------------------------------------------
// 3. После штатного завершения блокировка освобождена
// ---------------------------------------------------------------------------
test('after a normal CLI completion the lock is released', (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  const scratch = mkTmp('cli-proc-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });

  const childScript = path.join(scratch, 'quick-child.mjs');
  fs.writeFileSync(childScript, 'process.exit(0);\n');

  const result = runCli(['start', '--', process.execPath, childScript], stateDir);

  assert.equal(result.status, 0);
  assert.ok(!lockHeld(stateDir), 'после штатного завершения каталог блокировки не должен существовать');
});

// ---------------------------------------------------------------------------
// 4. Ошибка запуска дочерней команды
// ---------------------------------------------------------------------------
test('a child command that cannot be started gives a non-zero code and releases the lock', (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  t.after(() => rmTmp(stateDir));

  const result = runCli(['start', '--', 'definitely-not-a-real-binary-xyz'], stateDir);

  assert.notEqual(result.status, 0, 'код возврата должен быть ненулевым');
  assert.ok(!lockHeld(stateDir), 'блокировка должна быть освобождена и при неудачном запуске');
});

// ---------------------------------------------------------------------------
// 5. Авария оболочки при живом дочернем процессе не разрешает второй запуск
// ---------------------------------------------------------------------------
test('a crashed CLI with a still-running child does not let a second coordinator start', async (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  const scratch = mkTmp('cli-proc-scratch-');
  const readyFile = path.join(scratch, 'ready');
  const goFile = path.join(scratch, 'go');
  const markerFile = path.join(scratch, 'second-ran');

  t.after(() => {
    // Отпускаем осиротевшую дочернюю команду, затем убираем временные каталоги.
    try { fs.writeFileSync(goFile, 'x'); } catch { /* уже убрано */ }
    rmTmp(stateDir);
    rmTmp(scratch);
  });

  const longChild = writeLongLivedChild(scratch, readyFile, goFile);
  const markerChild = writeMarkerChild(scratch, markerFile);

  const first = startCli(['start', '--', process.execPath, longChild], stateDir);

  assert.ok(await waitForFile(readyFile), 'дочерняя команда должна подать сигнал готовности');
  assert.ok(lockHeld(stateDir), 'блокировка должна удерживаться');

  // Жёстко убиваем ОБОЛОЧКУ, то есть процесс CLI. Дочернюю команду не трогаем.
  first.child.kill('SIGKILL');
  await first.exited; // ждём событие exit, а не фиксированную задержку

  assert.ok(lockHeld(stateDir), 'после аварии оболочки блокировка должна остаться захваченной');

  const second = runCli(['start', '--', process.execPath, markerChild], stateDir);

  assert.equal(second.status, 9, 'второй координатор должен получить 9');
  assert.match(second.stdout, /BUSY/, 'второй координатор должен увидеть BUSY');
  assert.ok(!fs.existsSync(markerFile), 'второй координатор не должен запускать свою команду');
});

// ---------------------------------------------------------------------------
// R3.2 / R3.3 / R3.4 — executable launch route: precheck, no start on a non-zero gate,
// result read by a NEW process. pickup/claim are stub PROCESSES, not mocked modules.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';

const CLI_URL = pathToFileURL(CLI).href;
const JOURNAL_URL = pathToFileURL(path.join(REPO_ROOT, 'tools', 'coordinator', 'journal.js')).href;

function runCliEnv(args, stateDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, COORDINATOR_STATE_DIR: stateDir, ...extraEnv },
  });
}

/** Stub pickup/claim processes: print PK_OUT/CL_OUT, exit with PK_CODE/CL_CODE, log their argv when they run. */
function writeStubs(scratch) {
  const pickup = path.join(scratch, 'pickup-stub.mjs');
  const claim = path.join(scratch, 'claim-stub.mjs');
  fs.writeFileSync(pickup, [
    "import fs from 'node:fs';",
    "if (process.env.PK_LOG) fs.appendFileSync(process.env.PK_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "process.stdout.write((process.env.PK_OUT || '') + '\\n');",
    'process.exit(Number(process.env.PK_CODE || 0));',
  ].join('\n'));
  fs.writeFileSync(claim, [
    "import fs from 'node:fs';",
    "if (process.env.CL_LOG) fs.appendFileSync(process.env.CL_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "process.stdout.write((process.env.CL_OUT || '') + '\\n');",
    'process.exit(Number(process.env.CL_CODE || 0));',
  ].join('\n'));
  return { pickup, claim };
}

const PR = { number: 42, state: 'OPEN', url: 'https://gh.test/o/r/pull/42', headSha: 'abc123def456' };
const PICKED = JSON.stringify({ work: true, reason: 'ready', issue: { key: 'KAN-14' }, pr: null, counts: {} });

function precheckEnv(scratch, { claimCode, claimOut, pkCode = 0, pkOut = PICKED }) {
  const stubs = writeStubs(scratch);
  return {
    PRECHECK_PICKUP_SCRIPT: stubs.pickup,
    PRECHECK_CLAIM_SCRIPT: stubs.claim,
    PK_CODE: String(pkCode), PK_OUT: pkOut,
    CL_CODE: String(claimCode), CL_OUT: JSON.stringify(claimOut),
    PK_LOG: path.join(scratch, 'pickup.log'),
    CL_LOG: path.join(scratch, 'claim.log'),
  };
}

/** Reads the journal claim in a FRESH process; returns it parsed. */
function readClaimInNewProcess(scratch, stateDir) {
  const script = path.join(scratch, 'read-claim.mjs');
  fs.writeFileSync(script, [
    `import { read } from ${JSON.stringify(JOURNAL_URL)};`,
    `import { resolveRepoKey } from ${JSON.stringify(CLI_URL)};`,
    `const repoKey = resolveRepoKey({ cwd: ${JSON.stringify(REPO_ROOT)} });`,
    `const r = read({ stateDir: ${JSON.stringify(stateDir)}, repoKey });`,
    'process.stdout.write(JSON.stringify(r.ok ? r.record.claim : { unreadable: r.reason }));',
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function seedClaim(scratch, stateDir, claim) {
  const script = path.join(scratch, 'seed-claim.mjs');
  fs.writeFileSync(script, [
    `import { write } from ${JSON.stringify(JOURNAL_URL)};`,
    `import { resolveRepoKey } from ${JSON.stringify(CLI_URL)};`,
    `const repoKey = resolveRepoKey({ cwd: ${JSON.stringify(REPO_ROOT)} });`,
    `write({ stateDir: ${JSON.stringify(stateDir)}, repoKey, patch: { claim: ${JSON.stringify(claim)} } });`,
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
}

const PRECHECK_ARGS = ['precheck', '--project', 'KAN', '--repo', 'o/r'];

const OK_CASES = [
  ['claimed', 'implement', null],
  ['review_pending', 'review', PR],
  ['closing', 'close', { ...PR, state: 'MERGED' }],
];

for (const [state, mode, pr] of OK_CASES) {
  test(`R3.2: claim 0 ${state}/${mode} → precheck 0, journal claim.state/mode match`, (t) => {
    const stateDir = mkTmp('cli-pc-state-');
    const scratch = mkTmp('cli-pc-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const env = precheckEnv(scratch, { claimCode: 0, claimOut: { success: true, state, reason: state, mode, pr } });
    const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const claim = readClaimInNewProcess(scratch, stateDir);
    assert.equal(claim.issueKey, 'KAN-14');
    assert.equal(claim.state, state);
    assert.equal(claim.mode, mode);
    assert.deepStrictEqual(claim.pr, pr ? { number: 42, url: PR.url, headSha: 'abc123def456' } : null);
    // the gate was asked about exactly the picked issue, with --adopt-existing
    assert.match(fs.readFileSync(env.CL_LOG, 'utf8'), /--issue KAN-14 .*--adopt-existing/);
  });
}

for (const [code, state] of [[2, 'not_found'], [3, 'blocked'], [3, 'not_ready'], [4, 'awaiting_merge'], [4, 'work_exists'],
  [5, 'readback_failed'], [6, 'source_unavailable'], [7, 'mutation_failed']]) {
  test(`R3.2: claim ${code} ${state} → precheck returns ${code} and the journal holds the actual state`, (t) => {
    const stateDir = mkTmp('cli-pc-state-');
    const scratch = mkTmp('cli-pc-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const env = precheckEnv(scratch, { claimCode: code, claimOut: { success: false, reason: state, state } });
    const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
    assert.equal(r.status, code, r.stdout + r.stderr);
    const claim = readClaimInNewProcess(scratch, stateDir);
    assert.equal(claim.state, state);
    assert.equal(claim.mode, null);
  });
}

test('R3.2: journal write fails (state dir is not writable) while claim = 0 → precheck 5', (t) => {
  const scratch = mkTmp('cli-pc-scratch-');
  t.after(() => rmTmp(scratch));
  // A FILE where the state directory should be: the journal cannot be created under it.
  const stateDir = path.join(scratch, 'state-is-a-file');
  fs.writeFileSync(stateDir, 'not a directory');
  const env = precheckEnv(scratch, { claimCode: 0, claimOut: { success: true, state: 'claimed', reason: 'claimed', mode: 'implement', pr: null } });
  const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
  assert.equal(r.status, 5, r.stdout + r.stderr);
});

for (const [pkCode, pkOut] of [[3, '{"work":false,"reason":"none","issue":null}'], [4, '{"work":false,"reason":"unavailable","issue":null}'], [2, '']]) {
  test(`R3.2: pickup ${pkCode} → precheck ${pkCode}, journal untouched, claim stub never called`, (t) => {
    const stateDir = mkTmp('cli-pc-state-');
    const scratch = mkTmp('cli-pc-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const env = precheckEnv(scratch, { pkCode, pkOut, claimCode: 0, claimOut: { state: 'claimed', mode: 'implement' } });
    const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
    assert.equal(r.status, pkCode, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(env.CL_LOG), 'the gate must not be called');
    assert.ok(!fs.existsSync(stateDir) || fs.readdirSync(stateDir).length === 0, 'journal must not be created');
  });
}

test('R3.2: pickup 0 without an issue key is not a permit: precheck 4, gate not called', (t) => {
  const stateDir = mkTmp('cli-pc-state-');
  const scratch = mkTmp('cli-pc-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
  const env = precheckEnv(scratch, { pkOut: '{"work":true,"issue":null}', claimCode: 0, claimOut: { state: 'claimed', mode: 'implement' } });
  const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
  assert.equal(r.status, 4);
  assert.ok(!fs.existsSync(env.CL_LOG));
});

// R3.3 — a non-startable claim in the journal means zero executor processes.
for (const state of ['source_unavailable', 'blocked', 'not_ready', 'awaiting_merge', 'work_exists', 'readback_failed', 'mutation_failed']) {
  test(`R3.3: journal claim.state = ${state} → start spawns no child (no marker file)`, (t) => {
    const stateDir = mkTmp('cli-st-state-');
    const scratch = mkTmp('cli-st-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const markerFile = path.join(scratch, 'marker');
    const markerChild = writeMarkerChild(scratch, markerFile);
    seedClaim(scratch, stateDir, { issueKey: 'KAN-14', state, mode: null, pr: null });
    const r = runCliEnv(['start', '--', process.execPath, markerChild], stateDir);
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(markerFile), 'the executor must not have been started');
  });
}

for (const state of ['review_pending', 'claimed', 'closing']) {
  test(`R3.3: journal claim.state = ${state} → the child is started (marker created)`, (t) => {
    const stateDir = mkTmp('cli-st-state-');
    const scratch = mkTmp('cli-st-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const markerFile = path.join(scratch, 'marker');
    const markerChild = writeMarkerChild(scratch, markerFile);
    seedClaim(scratch, stateDir, { issueKey: 'KAN-14', state, mode: 'review', pr: null });
    const r = runCliEnv(['start', '--', process.execPath, markerChild], stateDir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(markerFile));
  });
}

test('R3.3: journal without claim → start behaves as before (child runs)', (t) => {
  const stateDir = mkTmp('cli-st-state-');
  const scratch = mkTmp('cli-st-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
  const markerFile = path.join(scratch, 'marker');
  const r = runCliEnv(['start', '--', process.execPath, writeMarkerChild(scratch, markerFile)], stateDir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(markerFile));
});

// R3.4 — the record survives the process that made it
test('R3.4: precheck process exits; a SECOND process reads claim.issueKey/state/mode', (t) => {
  const stateDir = mkTmp('cli-pc-state-');
  const scratch = mkTmp('cli-pc-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
  const env = precheckEnv(scratch, { claimCode: 0, claimOut: { success: true, state: 'review_pending', reason: 'review_pending', mode: 'review', pr: PR } });
  const first = runCliEnv(PRECHECK_ARGS, stateDir, env); // spawnSync: the first process has exited when it returns
  assert.equal(first.status, 0, first.stderr);
  const script = path.join(scratch, 'print-claim.mjs');
  fs.writeFileSync(script, [
    `import { read } from ${JSON.stringify(JOURNAL_URL)};`,
    `import { resolveRepoKey } from ${JSON.stringify(CLI_URL)};`,
    `const r = read({ stateDir: ${JSON.stringify(stateDir)}, repoKey: resolveRepoKey({ cwd: ${JSON.stringify(REPO_ROOT)} }) });`,
    'console.log([r.record.claim.issueKey, r.record.claim.state, r.record.claim.mode].join(","));',
  ].join('\n'));
  const second = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), 'KAN-14,review_pending,review');
});

// R3.5 on the route: code 0 is read together with `mode`; a pair that gives no permission is not a pass.
for (const [state, mode] of [['claimed', 'review'], ['review_pending', 'implement'], ['closing', 'implement'], ['work_exists', null]]) {
  test(`R3.5: claim 0 with ${state}/${mode} is not a permit → precheck 5`, (t) => {
    const stateDir = mkTmp('cli-pc-state-');
    const scratch = mkTmp('cli-pc-scratch-');
    t.after(() => { rmTmp(stateDir); rmTmp(scratch); });
    const env = precheckEnv(scratch, { claimCode: 0, claimOut: { success: true, state, reason: state, mode, pr: null } });
    const r = runCliEnv(PRECHECK_ARGS, stateDir, env);
    assert.equal(r.status, 5, r.stdout + r.stderr);
  });
}
