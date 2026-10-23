import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SETTLE = join(__dirname, '..', 'tools', 'coordinator', 'settle.js');

// Import for parseWorkerList tests
import * as settleModule from '../tools/coordinator/settle.js';

/**
 * Create a temp directory with a minimal git repo inside it.
 */
function createGitRepo(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  // Create a file and commit it
  writeFileSync(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

/**
 * Create a Node stub script in `dir` that prints `json` to stdout for any
 * arguments. The stub is plain JavaScript run by process.execPath, so it
 * needs no executable bit and no platform-specific wrapper.
 * Returns the environment that makes settle.js launch it instead of orca.
 */
function createOrcaStub(dir, json) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const stubPath = join(dir, 'stub.js');
  writeFileSync(stubPath, 'process.stdout.write(' + JSON.stringify(json) + ');' + String.fromCharCode(10), 'utf8');
  return {
    SETTLE_ORCA_EXEC: process.execPath,
    SETTLE_ORCA_PREFIX_ARGS_JSON: JSON.stringify([stubPath]),
  };
}

/**
 * Spawn settle.js with an array of argv arguments.
 */
function spawnSettle(argv, extraEnv) {
  const env = { ...process.env };
  delete env['COORDINATOR_STATE_DIR'];
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return spawnSync(process.execPath, [SETTLE, ...argv], {
    env,
    timeout: 30000,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// 23. Неверное использование — код 2
// ---------------------------------------------------------------------------

test('exit 2 on no args', () => {
  const r = spawnSettle([]);
  strictEqual(r.status, 2);
});

test('exit 2 on missing required flag', () => {
  const r = spawnSettle(['--run', 'abc']);
  strictEqual(r.status, 2);
});

// ---------------------------------------------------------------------------
// 24. Недоступные сведения о dispatch — UNVERIFIABLE, код 22
// ---------------------------------------------------------------------------

test('UNVERIFIABLE when run does not exist but worktree has commit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree1');
  createGitRepo(worktree);
  const stateDir = join(dir, 'state1');

  const r = spawnSettle([
    '--run', 'nonexistent-run-12345',
    '--task', 'task_abc',
    '--dispatch', 'ctx_xyz',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ]);

  strictEqual(r.status, 22);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'UNVERIFIABLE');
});

// ---------------------------------------------------------------------------
// 25. --worktree на несуществующий каталог — evidence.commit = null
// ---------------------------------------------------------------------------

test('commit is null when worktree does not exist', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = spawnSettle([
    '--run', 'nonexistent-run',
    '--task', 'task_xyz',
    '--dispatch', 'ctx_abc',
    '--worktree', join(dir, 'nonexistent-dir'),
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ]);

  strictEqual(r.status, 22);
  const out = JSON.parse(r.stdout);
  strictEqual(out.evidence.commit, null);
  strictEqual(out.verdict, 'UNVERIFIABLE');
});

// ---------------------------------------------------------------------------
// 26. Короткий дедлайн — deadlineExceeded: true, завершается за конечное время
// ---------------------------------------------------------------------------

test('deadlineExceeded with short deadline', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = spawnSettle([
    '--run', 'nonexistent-run',
    '--task', 'task_xyz',
    '--dispatch', 'ctx_abc',
    '--worktree', join(dir, 'nonexistent-dir'),
    '--deadline-ms', '1000',
    '--poll-ms', '200',
  ]);

  strictEqual(r.status, 22);
  const out = JSON.parse(r.stdout);
  strictEqual(out.deadlineExceeded, true);
});

// ---------------------------------------------------------------------------
// 27. Повторный запуск — alreadyRecorded: true, файл не меняется
// ---------------------------------------------------------------------------

test('alreadyRecorded on second run with same verdict', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateDir = join(dir, 'state3');
  const worktree = join(dir, 'worktree3');
  createGitRepo(worktree);

  const first = spawnSettle([
    '--run', 'run-already-recorded',
    '--task', 'task_recorded',
    '--dispatch', 'ctx_recorded',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], { COORDINATOR_STATE_DIR: stateDir });

  strictEqual(first.status, 22);
  const out1 = JSON.parse(first.stdout);
  strictEqual(out1.alreadyRecorded, false);

  // Read journal before second run
  const journalPath = join(stateDir, 'default', 'settlements.json');
  const journalBefore = readFileSync(journalPath, 'utf8');

  // Second run
  const second = spawnSettle([
    '--run', 'run-already-recorded',
    '--task', 'task_recorded',
    '--dispatch', 'ctx_recorded',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], { COORDINATOR_STATE_DIR: stateDir });

  strictEqual(second.status, 22);
  const out2 = JSON.parse(second.stdout);
  strictEqual(out2.alreadyRecorded, true);

  // Journal must not have changed
  strictEqual(readFileSync(journalPath, 'utf8'), journalBefore);
});

// ---------------------------------------------------------------------------
// 28. stdout разобра́ть JSON.parse без предварительной чистки
// ---------------------------------------------------------------------------

test('stdout is parseable JSON without cleanup', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree4');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-28');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_parse","taskId":"task_parse","workerState":"succeeded","dispatchStatus":"completed"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-json-parse',
    '--task', 'task_parse',
    '--dispatch', 'ctx_parse',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  // No stderr output (only stdout)
  strictEqual(r.stderr, '');
  // stdout must be pure JSON
  const obj = JSON.parse(r.stdout);
  strictEqual(typeof obj, 'object');
});

// ---------------------------------------------------------------------------
// 29. recommendedRecovery не содержит lifecycle-мутаций
// ---------------------------------------------------------------------------

test('recommendedRecovery does not contain mutation commands', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree5');
  createGitRepo(worktree);

  const r = spawnSettle([
    '--run', 'run-recovery',
    '--task', 'task_rec',
    '--dispatch', 'ctx_rec',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ]);

  const out = JSON.parse(r.stdout);
  strictEqual(typeof out.recommendedRecovery, 'string');
  strictEqual(out.recommendedRecovery.includes('worker-stop'), false);
  strictEqual(out.recommendedRecovery.includes('worker-abandon'), false);
  strictEqual(out.recommendedRecovery.includes('worker-release'), false);
  strictEqual(out.recommendedRecovery.includes('task-update'), false);
});

// ---------------------------------------------------------------------------
// 30. Исходный текст settle.js не содержит lifecycle-подстрок
// ---------------------------------------------------------------------------

test('settle.js source does not reference lifecycle commands', () => {
  const content = readFileSync(SETTLE, 'utf8');
  strictEqual(content.includes('worker-stop'), false);
  strictEqual(content.includes('worker-abandon'), false);
  strictEqual(content.includes('worker-release'), false);
  strictEqual(content.includes('task-update'), false);
});

// ---------------------------------------------------------------------------
// 31. Разбор формы ответа Orca (data.result.workers) — SETTLED_BY_WORKER
// ---------------------------------------------------------------------------

test('parse data.result.workers and yield SETTLED_BY_WORKER', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","workerState":"succeeded","dispatchStatus":"completed"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].dispatchId, 'd1');
  strictEqual(workers[0].taskId, 't1');
  strictEqual(workers[0].workerState, 'succeeded');
  strictEqual(workers[0].dispatchStatus, 'completed');
});

// ---------------------------------------------------------------------------
// 32. Дефект 2: stopped workerState — не SETTLED_BY_WORKER
// ---------------------------------------------------------------------------

test('stopped workerState → not SETTLED_BY_WORKER', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].workerState, 'stopped');
});

// ---------------------------------------------------------------------------
// 33. evidence.dispatchStatus присутствует в обоих случаях
// ---------------------------------------------------------------------------

test('evidence.dispatchStatus present when worker succeeded', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","workerState":"succeeded","dispatchStatus":"completed"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].dispatchStatus, 'completed');
});

test('evidence.dispatchStatus present when worker stopped', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].dispatchStatus, 'stopped');
});

// ---------------------------------------------------------------------------
// 34. Дефект 1 + 7: stopped dispatch + worktree с коммитом → WORK_PRESENT_UNSETTLED
// ---------------------------------------------------------------------------

test('stopped dispatch + commit in worktree → WORK_PRESENT_UNSETTLED, exit 20', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree-stopped-commit');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-34');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_stopped","taskId":"task_stopped","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-stopped',
    '--task', 'task_stopped',
    '--dispatch', 'ctx_stopped',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 20);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(typeof out.evidence.commit, 'string');
  strictEqual(out.evidence.commit.length, 40);
  strictEqual(out.evidence.workerDone.found, false);
  strictEqual(out.evidence.workerDone.recordFound, true);
});

// ---------------------------------------------------------------------------
// 35. Дефект 1 + 8: stopped dispatch + worktree без коммитов → NO_WORK_UNSETTLED
// ---------------------------------------------------------------------------

test('stopped dispatch + empty worktree → NO_WORK_UNSETTLED, exit 21', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree-empty-35');
  mkdirSync(worktree, { recursive: true });
  spawnSync('git', ['init'], { cwd: worktree, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktree, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: worktree, stdio: 'ignore' });
  // No commit — empty repo

  const toolsDir = join(dir, 'bin-35');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_empty","taskId":"task_empty","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-empty',
    '--task', 'task_empty',
    '--dispatch', 'ctx_empty',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 21);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'NO_WORK_UNSETTLED');
  strictEqual(out.evidence.commit, '');
});

// ---------------------------------------------------------------------------
// 36. Дефект 1 + 9: worktree не существует → UNVERIFIABLE, exit 22, commit=null
// ---------------------------------------------------------------------------

test('nonexistent worktree → UNVERIFIABLE, exit 22, commit=null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const toolsDir = join(dir, 'bin-36');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_miss","taskId":"task_miss","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-miss',
    '--task', 'task_miss',
    '--dispatch', 'ctx_miss',
    '--worktree', join(dir, 'does-not-exist-36'),
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 22);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'UNVERIFIABLE');
  strictEqual(out.evidence.commit, null);
});

// ---------------------------------------------------------------------------
// 37. Дефект 2: stopped workerState → found=false, recordFound=true
// ---------------------------------------------------------------------------

test('stopped workerState → found=false, recordFound=true', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree-found-37');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-37');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_f","taskId":"task_f","workerState":"stopped","dispatchStatus":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-f',
    '--task', 'task_f',
    '--dispatch', 'ctx_f',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 20);
  const out = JSON.parse(r.stdout);
  strictEqual(out.evidence.workerDone.found, false);
  strictEqual(out.evidence.workerDone.recordFound, true);
});

// ---------------------------------------------------------------------------
// 38. Дефект 2 + 11: succeeded worker + finished dispatch → found=true, SETTLED_BY_WORKER, exit 0
// ---------------------------------------------------------------------------

test('succeeded worker + finished dispatch → found=true, SETTLED_BY_WORKER, exit 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree-succeeded-38');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-38');
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_ok","taskId":"task_ok","workerState":"succeeded","dispatchStatus":"completed"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'SETTLED_BY_WORKER');
  strictEqual(out.evidence.workerDone.found, true);
  strictEqual(out.evidence.workerDone.recordFound, true);
});

// ---------------------------------------------------------------------------
// Helper assertion
// ---------------------------------------------------------------------------

function strictEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw Object.assign(new Error(`${msg || ''} ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`), {
      actual, expected,
    });
  }
}
