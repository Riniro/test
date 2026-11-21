// settlement-guard-mandatory.test.js
//
// These tests exercise the real entry points: the CLI process
// (settlement-guard.js) and settle.js, each with its own temporary state
// directory, its own HOME, and a stubbed `orca` executable.  Nothing here
// reads or writes the real ~/.claude-coordinator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'settlement-guard.js');
const SETTLE = join(ROOT, 'tools', 'coordinator', 'settle.js');
const GUARD_URL = pathToFileURL(join(ROOT, 'tools', 'settlement-guard.js')).href;
const NL = String.fromCharCode(10);

const STUB_SOURCE = [
  "import fs from 'node:fs';",
  'const args = process.argv.slice(2);',
  'fs.appendFileSync(process.env.STUB_LOG, args.join(" ") + String.fromCharCode(10));',
  'const cfg = JSON.parse(fs.readFileSync(process.env.STUB_CONFIG, "utf8"));',
  'if (args.includes("worker-list")) {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { workers: cfg.workers || [] } }));',
  '  process.exit(0);',
  '}',
  'if (args.includes("worker-stop")) { process.exit(cfg.stopExit || 0); }',
  'process.exit(0);',
].join(NL);

/** One isolated sandbox: state dir, HOME, orca stub, call log. */
function sandbox(t, workers, stopExit) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-mandatory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateDir = join(dir, 'state');
  const home = join(dir, 'home');
  const worktree = join(dir, 'worktree');
  for (const d of [stateDir, home, worktree]) mkdirSync(d, { recursive: true });

  const stub = join(dir, 'orca-stub.js');
  writeFileSync(stub, STUB_SOURCE, 'utf8');

  const configPath = join(dir, 'stub-config.json');
  const logPath = join(dir, 'stub-calls.log');
  writeFileSync(configPath, JSON.stringify({ workers: workers || [], stopExit: stopExit || 0 }), 'utf8');
  writeFileSync(logPath, '', 'utf8');

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    COORDINATOR_STATE_DIR: stateDir,
    SETTLE_ORCA_EXEC: process.execPath,
    SETTLE_ORCA_PREFIX_ARGS_JSON: JSON.stringify([stub]),
    STUB_CONFIG: configPath,
    STUB_LOG: logPath,
  };

  const journalPath = join(stateDir, 'default', 'settlements.json');

  return {
    dir, stateDir, home, worktree, env, configPath, logPath, journalPath,
    setWorkers(next, nextStopExit) {
      writeFileSync(configPath, JSON.stringify({
        workers: next,
        stopExit: nextStopExit === undefined ? (stopExit || 0) : nextStopExit,
      }), 'utf8');
    },
    stopCalls() {
      return readFileSync(logPath, 'utf8').split(NL)
        .filter((line) => line.includes('worker-stop')).length;
    },
    journal() {
      return JSON.parse(readFileSync(journalPath, 'utf8'));
    },
    writeJournal(obj) {
      mkdirSync(join(stateDir, 'default'), { recursive: true });
      writeFileSync(journalPath, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
    },
  };
}

function runCli(box, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: box.env, encoding: 'utf8', timeout: 60000,
  });
}

function runSettle(box, args) {
  return spawnSync(process.execPath, [SETTLE, ...args], {
    env: box.env, encoding: 'utf8', timeout: 60000,
  });
}

function worker(dispatchId, taskId, state, workerState) {
  return {
    dispatchId, taskId, state,
    workerState: workerState === undefined ? null : workerState,
    dispatchStatus: state,
  };
}

const DISPATCH = 'ctx_mandatory';
const TASK = 'task_mandatory';
const RUN = 'run_mandatory';

function settleArgs(box, extra) {
  return [
    '--run', RUN, '--task', TASK, '--dispatch', DISPATCH,
    '--worktree', box.worktree, '--deadline-ms', '1500', '--poll-ms', '400',
    ...(extra || []),
  ];
}

// ---------------------------------------------------------------------------
// 1. The CLI is a real process
// ---------------------------------------------------------------------------

test('CLI: процесс запускается и печатает использование без аргументов', (t) => {
  const box = sandbox(t, []);
  const r = spawnSync(process.execPath, [CLI], { env: box.env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: node settlement-guard.js dispose/);
  assert.equal(r.stderr.includes('TypeError'), false);
});

test('CLI: неизвестная команда и отсутствующий обязательный флаг — код 2', (t) => {
  const box = sandbox(t, []);
  const bad = runCli(box, ['bogus']);
  assert.equal(bad.status, 2);
  const missing = runCli(box, ['dispose', '--dispatch', DISPATCH]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--run is required/);
});

// ---------------------------------------------------------------------------
// 2. Full cycle through the real entry points
// ---------------------------------------------------------------------------

test('полный цикл: settle.js записывает, CLI распоряжается ресурсами один раз', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);

  const settled = runSettle(box, settleArgs(box));
  assert.ok([0, 20, 21, 22].includes(settled.status), settled.stdout + settled.stderr);
  assert.ok(existsSync(box.journalPath));

  const disposed = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(disposed.status, 0, disposed.stdout + disposed.stderr);
  assert.equal(box.stopCalls(), 1);
  assert.equal(box.journal()[DISPATCH].completedAction.status, 'completed');
});

test('повторная доставка: второй вызов — no-op, worker-stop не повторяется', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  runSettle(box, settleArgs(box));

  const first = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(first.status, 0);
  const second = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /nothing to do/);
  assert.equal(box.stopCalls(), 1);
});

// ---------------------------------------------------------------------------
// 3. The main criterion, through settle.js itself
// ---------------------------------------------------------------------------

test('settle.js: смена вердикта не стирает completedAction, остановка не повторяется', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);

  const first = runSettle(box, settleArgs(box));
  assert.ok([0, 20, 21, 22].includes(first.status), first.stdout + first.stderr);
  const firstVerdict = box.journal()[DISPATCH].verdict;

  const disposed = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(disposed.status, 0, disposed.stdout + disposed.stderr);
  assert.equal(box.stopCalls(), 1);

  // The same dispatch observed again, now without a record in the run's
  // worker list: the verdict changes and settle.js rewrites the entry.
  box.setWorkers([]);
  const second = runSettle(box, settleArgs(box));
  assert.ok([0, 20, 21, 22].includes(second.status), second.stdout + second.stderr);

  const entry = box.journal()[DISPATCH];
  assert.notEqual(entry.verdict, firstVerdict, 'вердикт должен был смениться');
  assert.ok(entry.reasons.includes('VERDICT_CHANGED'));
  assert.ok(entry.completedAction, 'completedAction стёрт перезаписью наблюдения');
  assert.equal(entry.completedAction.status, 'completed');

  const again = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to do/);
  assert.equal(box.stopCalls(), 1, 'worker-stop вызван повторно после смены вердикта');
});

test('старая отметка без status не разрешает новую остановку', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  runSettle(box, settleArgs(box));

  const journal = box.journal();
  journal[DISPATCH].completedAction = {
    name: 'dispose-resources',
    verdict: 'SETTLED_BY_WORKER',
    at: new Date().toISOString(),
    eventId: null,
  };
  box.writeJournal(journal);

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /no recognised status/);
  assert.equal(box.stopCalls(), 0, 'остановка выполнена по записи с неизвестным исходом');
});

// ---------------------------------------------------------------------------
// 4. Corrupt journal, on both write paths
// ---------------------------------------------------------------------------

test('повреждённый журнал: settle.js его не перезаписывает', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  const broken = '{"keep-1": {"verdict": "SETTLED_BY_WORKER", "completedAction": {"status": "completed"}}, BROKEN';
  box.writeJournal(broken);

  const r = runSettle(box, settleArgs(box));
  assert.equal(r.status, 24, r.stdout + r.stderr);
  assert.equal(readFileSync(box.journalPath, 'utf8'), broken);
});

test('повреждённый журнал: CLI его не перезаписывает и ничего не останавливает', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  const broken = '{"keep-1": {"completedAction": {"status": "completed"}}, BROKEN';
  box.writeJournal(broken);

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 24, r.stdout + r.stderr);
  assert.equal(readFileSync(box.journalPath, 'utf8'), broken);
  assert.equal(box.stopCalls(), 0);
});

// ---------------------------------------------------------------------------
// 5. Two processes, and a busy lock
// ---------------------------------------------------------------------------

const WRITER_SOURCE = [
  'import { guardedSettlements } from ' + JSON.stringify(GUARD_URL) + ';',
  'const key = process.argv[2];',
  'const holdMs = Number(process.argv[3]);',
  'const res = guardedSettlements({ repoKey: null, lockRequired: true, mutateFn: (journal) => {',
  '  const end = Date.now() + holdMs;',
  '  while (Date.now() < end) { /* hold the read-write window open */ }',
  '  journal[key] = { verdict: "WORK_PRESENT_UNSETTLED", evidence: {} };',
  '} });',
  'process.stdout.write(String(res.code));',
].join(NL);

const HOLDER_SOURCE = [
  'import { acquireSettlementLock } from ' + JSON.stringify(GUARD_URL) + ';',
  'const res = acquireSettlementLock(null);',
  'if (!res.ok) { process.stdout.write("BUSY"); process.exit(9); }',
  'process.stdout.write("HELD");',
  'setInterval(() => {}, 1000);',
].join(NL);

test('два процесса пишут по разным dispatchId — обе записи сохраняются', (t) => {
  const box = sandbox(t, []);
  box.writeJournal({ 'pre-existing': { verdict: 'SEED' } });

  const writer = join(box.dir, 'writer.js');
  writeFileSync(writer, WRITER_SOURCE, 'utf8');

  const a = spawn(process.execPath, [writer, 'ctx_a', '250'], { env: box.env });
  const b = spawn(process.execPath, [writer, 'ctx_b', '250'], { env: box.env });

  return Promise.all([a, b].map((child) => new Promise((resolve) => {
    child.on('exit', resolve);
  }))).then(() => {
    const journal = box.journal();
    assert.ok(journal['pre-existing'], 'исходная запись потеряна');
    assert.ok(journal['ctx_a'], 'запись первого процесса потеряна');
    assert.ok(journal['ctx_b'], 'запись второго процесса потеряна');
  });
});

/** Start a child that holds the settlements lock; resolve once it is held. */
function startHolder(box) {
  const holder = join(box.dir, 'holder.js');
  writeFileSync(holder, HOLDER_SOURCE, 'utf8');
  const child = spawn(process.execPath, [holder], { env: box.env });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('HELD')) resolve(child);
      if (out.includes('BUSY')) reject(new Error('holder could not take the lock'));
    });
    child.on('exit', () => { if (!out.includes('HELD')) reject(new Error('holder exited early')); });
  });
}

test('занятая блокировка: код 23 и worker-stop не вызывается', async (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  runSettle(box, settleArgs(box));
  const before = readFileSync(box.journalPath, 'utf8');

  const holder = await startHolder(box);
  try {
    const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
    assert.equal(r.status, 23, r.stdout + r.stderr);
    assert.match(r.stdout, /worker-stop was not called/);
    assert.equal(box.stopCalls(), 0);
    assert.equal(readFileSync(box.journalPath, 'utf8'), before, 'журнал изменён при занятой блокировке');
  } finally {
    holder.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// 6. Deadline and ownership
// ---------------------------------------------------------------------------

test('дедлайн: живой dispatch останавливается, шаг остаётся unsettled', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'running', null)]);

  const settled = runSettle(box, settleArgs(box));
  assert.notEqual(settled.status, 0);
  const before = box.journal()[DISPATCH];
  assert.notEqual(before.verdict, 'SETTLED_BY_WORKER');

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK, '--deadline-exceeded']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(box.stopCalls(), 1);

  const after = box.journal()[DISPATCH];
  assert.equal(after.verdict, before.verdict, 'вердикт подменён распоряжением ресурсами');
  assert.equal(after.evidence.workerDone.found, false, 'worker_done подделан');
  assert.equal(after.completedAction.status, 'completed');
  assert.equal(after.completedAction.verdict, before.verdict);
  // worker-list gives no message id, so the absence of one is recorded as an
  // absence; a (dispatchId, verdict) pair must never stand in for it.
  assert.equal(after.completedAction.eventId, null);
});

test('без дедлайна живой dispatch не останавливается', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'running', null)]);
  runSettle(box, settleArgs(box));

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /no deadline was reached/);
  assert.equal(box.stopCalls(), 0);
});

test('принадлежность: dispatch отсутствует в списке своего запуска — эскалация без остановки', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  runSettle(box, settleArgs(box));

  box.setWorkers([worker('ctx_someone_else', 'task_other', 'succeeded', 'succeeded')]);
  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /not in the worker list/);
  assert.equal(box.stopCalls(), 0);
});

test('принадлежность: taskId расходится с журнальной записью — эскалация без остановки', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'succeeded', 'succeeded')]);
  runSettle(box, settleArgs(box));

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', 'task_claimed_by_caller']);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /does not match the journal entry/);
  assert.equal(box.stopCalls(), 0);
});

// ---------------------------------------------------------------------------
// 7. Interruption between the stop and the result record
// ---------------------------------------------------------------------------

test('обрыв после остановки: подтверждённое завершение — успешный no-op без повторной остановки', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'stopped', null)]);
  runSettle(box, settleArgs(box));

  const journal = box.journal();
  journal[DISPATCH].completedAction = {
    name: 'dispose-resources', status: 'pending', trigger: 'result',
    at: new Date().toISOString(), eventId: null,
  };
  box.writeJournal(journal);

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(box.stopCalls(), 0, 'остановка повторена после обрыва');
  assert.equal(box.journal()[DISPATCH].completedAction.status, 'completed');
});

test('обрыв после остановки: исход неизвестен — эскалация без повторной остановки', (t) => {
  const box = sandbox(t, [worker(DISPATCH, TASK, 'running', null)]);
  runSettle(box, settleArgs(box));

  const journal = box.journal();
  journal[DISPATCH].completedAction = {
    name: 'dispose-resources', status: 'pending', trigger: 'result',
    at: new Date().toISOString(), eventId: null,
  };
  box.writeJournal(journal);

  const r = runCli(box, ['dispose', '--dispatch', DISPATCH, '--run', RUN, '--task', TASK]);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /the stop is not repeated/);
  assert.equal(box.stopCalls(), 0);
  assert.equal(box.journal()[DISPATCH].completedAction.status, 'pending');
});

// ---------------------------------------------------------------------------
// 8. Ordinary interruption releases the lock
// ---------------------------------------------------------------------------

test('SIGTERM удерживающему процессу освобождает блокировку', {
  skip: process.platform === 'win32'
    ? 'Windows не доставляет SIGTERM обработчику Node; там восстановление операторское, см. RECOVERY_AFTER_CRASH'
    : false,
}, async (t) => {
  const box = sandbox(t, []);
  const lockDir = join(box.stateDir, 'settlements-guard', 'lock');

  const holder = await startHolder(box);
  assert.ok(existsSync(lockDir), 'блокировка не взята');

  await new Promise((resolve) => {
    holder.on('exit', resolve);
    holder.kill('SIGTERM');
  });

  assert.equal(existsSync(lockDir), false, 'штатное прерывание оставило блокировку');

  const writer = join(box.dir, 'writer.js');
  writeFileSync(writer, WRITER_SOURCE, 'utf8');
  const after = spawnSync(process.execPath, [writer, 'ctx_after_signal', '10'], {
    env: box.env, encoding: 'utf8',
  });
  assert.equal(after.stdout, '0', 'следующая запись не смогла взять блокировку');
});
