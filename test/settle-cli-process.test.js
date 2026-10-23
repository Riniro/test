import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  // Create a file and commit it
  fs.writeFileSync(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
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

// Helpers to get temp dirs
const tmpRoot = join(__dirname, '..', '.qwen', 'tmp', 'settle-test-' + Date.now());
function ensureTmpDir() {
  if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
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

test('UNVERIFIABLE when run does not exist but worktree has commit', () => {
  ensureTmpDir();
  const worktree = join(tmpRoot, 'worktree1');
  createGitRepo(worktree);
  const stateDir = join(tmpRoot, 'state1');

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

test('commit is null when worktree does not exist', () => {
  ensureTmpDir();

  const r = spawnSettle([
    '--run', 'nonexistent-run',
    '--task', 'task_xyz',
    '--dispatch', 'ctx_abc',
    '--worktree', join(tmpRoot, 'nonexistent-dir'),
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

test('deadlineExceeded with short deadline', () => {
  ensureTmpDir();

  const r = spawnSettle([
    '--run', 'nonexistent-run',
    '--task', 'task_xyz',
    '--dispatch', 'ctx_abc',
    '--worktree', join(tmpRoot, 'nonexistent-dir'),
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

test('alreadyRecorded on second run with same verdict', () => {
  ensureTmpDir();
  const stateDir = join(tmpRoot, 'state3');
  const worktree = join(tmpRoot, 'worktree3');
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
  const journalBefore = fs.readFileSync(journalPath, 'utf8');

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
  strictEqual(fs.readFileSync(journalPath, 'utf8'), journalBefore);
});

// ---------------------------------------------------------------------------
// 28. stdout разобра́ть JSON.parse без предварительной чистки
// ---------------------------------------------------------------------------

test('stdout is parseable JSON without cleanup', () => {
  ensureTmpDir();
  const worktree = join(tmpRoot, 'worktree4');
  createGitRepo(worktree);

  const r = spawnSettle([
    '--run', 'run-json-parse',
    '--task', 'task_parse',
    '--dispatch', 'ctx_parse',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ]);

  // No stderr output (only stdout)
  strictEqual(r.stderr, '');
  // stdout must be pure JSON
  const obj = JSON.parse(r.stdout);
  strictEqual(typeof obj, 'object');
});

// ---------------------------------------------------------------------------
// 29. recommendedRecovery не содержит lifecycle-мутаций
// ---------------------------------------------------------------------------

test('recommendedRecovery does not contain mutation commands', () => {
  ensureTmpDir();
  const worktree = join(tmpRoot, 'worktree5');
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
  const content = fs.readFileSync(SETTLE, 'utf8');
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
// Helper assertion
// ---------------------------------------------------------------------------

function strictEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw Object.assign(new Error(`${msg || ''} ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`), {
      actual, expected,
    });
  }
}
