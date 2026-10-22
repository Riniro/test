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
