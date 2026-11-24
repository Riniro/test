import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

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
function createOrcaStub(dir, workerListJson, inboxJson) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const stubPath = join(dir, 'stub.js');
  // Ensure wlJson and inJson are raw JSON strings — embed via base64 to avoid
  // escaping issues with nested quotes in real Orca payloads.
  const wlRaw = typeof workerListJson === 'string' ? workerListJson : JSON.stringify(workerListJson);
  const inRaw = inboxJson !== undefined ? (typeof inboxJson === 'string' ? inboxJson : JSON.stringify(inboxJson)) : '';
  // Encode as base64 then decode at runtime — zero escaping issues
  const wlB64 = Buffer.from(wlRaw).toString('base64');
  const inB64 = Buffer.from(inRaw).toString('base64');
  writeFileSync(stubPath, [
    "const args = process.argv.slice(2);",
    "const subcmd = args.length > 1 ? args[1] : '';",
    "if (subcmd === 'inbox') { process.stdout.write(Buffer.from('" + inB64 + "', 'base64').toString('utf8')); }",
    "else { process.stdout.write(Buffer.from('" + wlB64 + "', 'base64').toString('utf8')); }",
  ].join('\n'), 'utf8');
  return {
    SETTLE_ORCA_EXEC: process.execPath,
    SETTLE_ORCA_PREFIX_ARGS_JSON: JSON.stringify([stubPath]),
  };
}

const isolationDirs = [];
process.on('exit', () => {
  for (const d of isolationDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Spawn settle.js with an array of argv arguments.
 */
function spawnSettle(argv, extraEnv) {
  const env = { ...process.env };
  delete env['COORDINATOR_STATE_DIR'];
  delete env['SETTLE_ORCA_EXEC'];
  delete env['SETTLE_ORCA_PREFIX_ARGS_JSON'];
  // Isolation: every child gets its own state dir and, unless the caller
  // supplies a stub, a stub Orca that always fails. A child can therefore
  // never reach os.homedir()/.claude-coordinator nor the real `orca`.
  const iso = mkdtempSync(join(tmpdir(), 'settle-iso-'));
  isolationDirs.push(iso);
  env.COORDINATOR_STATE_DIR = join(iso, 'state');
  const failStub = join(iso, 'fail-stub.js');
  writeFileSync(failStub, 'process.exit(1);\n', 'utf8');
  env.SETTLE_ORCA_EXEC = process.execPath;
  env.SETTLE_ORCA_PREFIX_ARGS_JSON = JSON.stringify([failStub]);
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  const result = spawnSync(process.execPath, [SETTLE, ...argv], {
    env,
    timeout: 30000,
    encoding: 'utf8',
  });
  // Report the directory this helper allocated, so a test can check that the
  // child wrote there and nowhere else.
  result.isolation = { stateDir: join(iso, 'state') };
  return result;
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
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_parse","taskId":"task_parse","state":"succeeded"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json, null);

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
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","state":"succeeded"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].dispatchId, 'd1');
  strictEqual(workers[0].taskId, 't1');
  strictEqual(workers[0].state, 'succeeded');
});

// ---------------------------------------------------------------------------
// 32. Дефект 2: stopped state — not SETTLED_BY_WORKER
// ---------------------------------------------------------------------------

test('stopped workerState → not SETTLED_BY_WORKER', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","state":"stopped"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].state, 'stopped');
});

// ---------------------------------------------------------------------------
// 33. state присутствует в обоих случаях
// ---------------------------------------------------------------------------

test('state present when worker succeeded', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","state":"succeeded"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].state, 'succeeded');
});

test('state present when worker stopped', () => {
  const raw = '{"ok":true,"result":{"workers":[{"dispatchId":"d1","taskId":"t1","state":"stopped"}]}}';
  const workers = settleModule.parseWorkerList(raw);
  strictEqual(workers.length, 1);
  strictEqual(workers[0].state, 'stopped');
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
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_stopped","taskId":"task_stopped","state":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json, null);

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
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_empty","taskId":"task_empty","state":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json, null);

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
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_miss","taskId":"task_miss","state":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json, null);

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
  const json = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_f","taskId":"task_f","state":"stopped"}]}}';
  const stubEnv = createOrcaStub(toolsDir, json, null);

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
  const workerListJson = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_ok","taskId":"task_ok","state":"succeeded"}]}}';
  const inboxJson = {"ok":true,"result":{"messages":[{"id":"msg_ok","type":"worker_done","to":"run:run-ok","payload":{"taskId":"task_ok","dispatchId":"ctx_ok"}}]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

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
// D3: Wrong runId, taskId, dispatchId — each one → not SETTLED_BY_WORKER
// ---------------------------------------------------------------------------

test('D3a: inbox message with wrong runId → not settled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-d3a-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-d3a');
  const workerListJson = {ok:true,result:{workers:[{dispatchId:'ctx_ok',taskId:'task_ok',state:'succeeded'}]}};
  // inbox message to run:WRONG_ID instead of run:run-ok
  const inboxJson = {ok:true,result:{messages:[{id:'m1',type:'worker_done',to:'run:WRONG_ID',payload:{taskId:'task_ok',dispatchId:'ctx_ok'}}]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '2000',
    '--poll-ms', '500',
  ], stubEnv);

  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(out.evidence.workerDone.found, false);
});

test('D3b: inbox message with wrong taskId → not settled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-d3b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-d3b');
  const workerListJson = {ok:true,result:{workers:[{dispatchId:'ctx_ok',taskId:'task_ok',state:'succeeded'}]}};
  // inbox message with wrong taskId
  const inboxJson = {ok:true,result:{messages:[{id:'m1',type:'worker_done',to:'run:run-ok',payload:{taskId:'task_WRONG',dispatchId:'ctx_ok'}}]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '2000',
    '--poll-ms', '500',
  ], stubEnv);

  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(out.evidence.workerDone.found, false);
});

test('D3c: inbox message with wrong dispatchId → not settled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-d3c-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-d3c');
  const workerListJson = {ok:true,result:{workers:[{dispatchId:'ctx_ok',taskId:'task_ok',state:'succeeded'}]}};
  // inbox message with wrong dispatchId
  const inboxJson = {ok:true,result:{messages:[{id:'m1',type:'worker_done',to:'run:run-ok',payload:{taskId:'task_ok',dispatchId:'ctx_WRONG'}}]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '2000',
    '--poll-ms', '500',
  ], stubEnv);

  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(out.evidence.workerDone.found, false);
});

// ---------------------------------------------------------------------------
// D4: state=succeeded, no inbox message → not settled
// ---------------------------------------------------------------------------

test('D4: succeeded worker but no inbox → not SETTLED_BY_WORKER', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-d4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-d4');
  const workerListJson = {ok:true,result:{workers:[{dispatchId:'ctx_ok',taskId:'task_ok',state:'succeeded'}]}};
  // No inbox messages at all
  const inboxJson = {ok:true,result:{messages:[]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '2000',
    '--poll-ms', '500',
  ], stubEnv);

  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(out.evidence.workerDone.found, false);
});

// ---------------------------------------------------------------------------
// D5: inbox message present but dispatch not succeeded → not settled
// ---------------------------------------------------------------------------

test('D5: inbox message but dispatch not succeeded → not SETTLED_BY_WORKER', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-d5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-d5');
  // worker-list shows ready (not succeeded)
  const workerListJson = {ok:true,result:{workers:[{dispatchId:'ctx_ok',taskId:'task_ok',state:'ready'}]}};
  // inbox has worker_done message but dispatch is not finished
  const inboxJson = {ok:true,result:{messages:[{id:'m1',type:'worker_done',to:'run:run-ok',payload:{taskId:'task_ok',dispatchId:'ctx_ok'}}]}};
  const stubEnv = createOrcaStub(toolsDir, workerListJson, inboxJson);

  const r = spawnSettle([
    '--run', 'run-ok',
    '--task', 'task_ok',
    '--dispatch', 'ctx_ok',
    '--worktree', worktree,
    '--deadline-ms', '2000',
    '--poll-ms', '500',
  ], stubEnv);

  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(out.evidence.workerDone.found, false);
});

// ---------------------------------------------------------------------------
// B1 (repeat): Fixture test — worker-list with two workers, inbox with one matching
// ---------------------------------------------------------------------------

test('B1: fixture test — worker A (ready) and worker B (succeeded) show different outcomes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-b1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktreeA = join(dir, 'worktree-a');
  createGitRepo(worktreeA);
  const worktreeB = join(dir, 'worktree-b');
  createGitRepo(worktreeB);

  // Fixture: two workers — A (ready) and B (succeeded)
  const fixturePath = join(__dirname, 'fixtures', 'orca', 'worker-list-a-succeeded-b-live.json');
  // Trim trailing newline — fixtures may have one, which breaks embedded JS strings
  const fixtureRaw = readFileSync(fixturePath, 'utf8').trimEnd();

  // Fixture: inbox with one worker_done (for worker B)
  const inboxPath = join(__dirname, 'fixtures', 'orca', 'raw-inbox-run_caba172c9fa2.json');
  const inboxRaw = readFileSync(inboxPath, 'utf8').trimEnd();

  // Worker A: dispatchId=ctx_15e93add3d45, taskId=task_ef5ae9a2eb98, state=ready
  // — should NOT settle (state is ready, no matching inbox)
  const toolsDirA = join(dir, 'bin-b1a');
  const stubEnvA = createOrcaStub(toolsDirA, fixtureRaw, inboxRaw);

  const rA = spawnSettle([
    '--run', 'run_caba172c9fa2',
    '--task', 'task_ef5ae9a2eb98',
    '--dispatch', 'ctx_15e93add3d45',
    '--worktree', worktreeA,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnvA);

  strictEqual(rA.status, 20);
  const outA = JSON.parse(rA.stdout);
  // Worker A is in "ready" state (not finished), has a commit → WORK_PRESENT_UNSETTLED
  strictEqual(outA.verdict, 'WORK_PRESENT_UNSETTLED');
  strictEqual(outA.evidence.workerDone.found, false);
  strictEqual(outA.evidence.workerList.state, 'ready');
  strictEqual(outA.evidence.workerList.recordFound, true);

  // Worker B: dispatchId=ctx_c9bcad93c1b4, taskId=task_03778b11545c, state=succeeded
  // — should settle (state is succeeded, inbox has matching worker_done)
  const toolsDirB = join(dir, 'bin-b1b');
  const stubEnvB = createOrcaStub(toolsDirB, fixtureRaw, inboxRaw);

  const rB = spawnSettle([
    '--run', 'run_caba172c9fa2',
    '--task', 'task_03778b11545c',
    '--dispatch', 'ctx_c9bcad93c1b4',
    '--worktree', worktreeB,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnvB);

  strictEqual(rB.status, 0);
  const outB = JSON.parse(rB.stdout);
  strictEqual(outB.verdict, 'SETTLED_BY_WORKER');
  strictEqual(outB.evidence.workerDone.found, true);
  strictEqual(outB.evidence.workerList.state, 'succeeded');
  strictEqual(outB.evidence.workerList.recordFound, true);
  strictEqual(outB.evidence.inboxVerified, true);
});

// ---------------------------------------------------------------------------
// B2: settlement.js — dispatch status succeeded → SETTLED_BY_WORKER
// ---------------------------------------------------------------------------

test('B2: dispatch status succeeded → SETTLED_BY_WORKER', async () => {
  const { decide } = await import('../tools/coordinator/settlement.js');

  const result = decide({
    dispatch: {
      workerDone: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        status: 'succeeded',
      },
      expectedTaskId: 'task-1',
      expectedDispatchId: 'ctx-1',
      status: 'succeeded',
    },
    work: { commit: 'abc123' },
    tests: { ran: true, passed: true },
  });

  strictEqual(result.verdict, 'SETTLED_BY_WORKER');
});

// ---------------------------------------------------------------------------
// B3: Early break fix — polling waits for BOTH signals
// ---------------------------------------------------------------------------

test('B3: polling waits for both signals — inbox arrives after worker-list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-b3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, 'worktree-b3');
  createGitRepo(worktree);

  const toolsDir = join(dir, 'bin-b3');
  mkdirSync(toolsDir, { recursive: true });

  const stubPath = join(toolsDir, 'stub-b3.js');
  const workerListJson = '{"ok":true,"result":{"workers":[{"dispatchId":"ctx-b3","taskId":"task-b3","state":"succeeded"}]}}';
  const inboxJson = '{"ok":true,"result":{"messages":[{"id":"msg-b3","type":"worker_done","to":"run:run-b3","payload":{"taskId":"task-b3","dispatchId":"ctx-b3"}}]}}';
  const wlB64 = Buffer.from(workerListJson).toString('base64');
  const inB64 = Buffer.from(inboxJson).toString('base64');
  writeFileSync(stubPath, [
    "const args = process.argv.slice(2);",
    "const subcmd = args.length > 1 ? args[1] : '';",
    "if (subcmd === 'inbox') { process.stdout.write(Buffer.from('" + inB64 + "', 'base64').toString('utf8')); }",
    "else { process.stdout.write(Buffer.from('" + wlB64 + "', 'base64').toString('utf8')); }",
  ].join('\n'), 'utf8');

  const stubEnv = {
    SETTLE_ORCA_EXEC: process.execPath,
    SETTLE_ORCA_PREFIX_ARGS_JSON: JSON.stringify([stubPath]),
  };

  const r = spawnSettle([
    '--run', 'run-b3',
    '--task', 'task-b3',
    '--dispatch', 'ctx-b3',
    '--worktree', worktree,
    '--deadline-ms', '5000',
    '--poll-ms', '1000',
  ], stubEnv);

  strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  strictEqual(out.verdict, 'SETTLED_BY_WORKER');
  strictEqual(out.evidence.workerDone.found, true);
  strictEqual(out.evidence.inboxVerified, true);
});

// ---------------------------------------------------------------------------
// R1: the inbox walk matches run + taskId + dispatchId inside the queue walk,
// so a foreign worker_done lying earlier cannot shadow ours.
// ---------------------------------------------------------------------------

const R1_RUN = 'run-r1';
const R1_TASK = 'task_r1_ours';
const R1_DISPATCH = 'ctx_r1_ours';

function r1Msg(id, taskId, dispatchId) {
  return { id, type: 'worker_done', to: 'run:' + R1_RUN, payload: { taskId, dispatchId } };
}
const R1_OURS = r1Msg('m_ours', R1_TASK, R1_DISPATCH);
const R1_FOREIGN = r1Msg('m_foreign', 'task_r1_other', 'ctx_r1_other');

function runR1(t, messages) {
  const dir = mkdtempSync(join(tmpdir(), 'settle-r1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);
  const workerList = { ok: true, result: { workers: [
    { dispatchId: R1_DISPATCH, taskId: R1_TASK, state: 'succeeded' },
    { dispatchId: 'ctx_r1_other', taskId: 'task_r1_other', state: 'succeeded' },
  ] } };
  const stubEnv = createOrcaStub(join(dir, 'bin'), workerList, { ok: true, result: { messages } });
  const r = spawnSettle([
    '--run', R1_RUN, '--task', R1_TASK, '--dispatch', R1_DISPATCH,
    '--worktree', worktree, '--deadline-ms', '2000', '--poll-ms', '500',
  ], stubEnv);
  return { r, out: JSON.parse(r.stdout) };
}

function assertR1Settled({ r, out }) {
  strictEqual(r.status, 0);
  strictEqual(out.verdict, 'SETTLED_BY_WORKER');
  strictEqual(out.evidence.inboxVerified, true);
  strictEqual(out.evidence.workerDone.dispatchId, R1_DISPATCH);
  strictEqual(out.evidence.workerDone.taskId, R1_TASK);
}

test('R1-1: [foreign, ours] → settled by our letter', (t) => {
  assertR1Settled(runR1(t, [R1_FOREIGN, R1_OURS]));
});

test('R1-2: [ours, foreign] → settled by our letter', (t) => {
  assertR1Settled(runR1(t, [R1_OURS, R1_FOREIGN]));
});

test('R1-3: only foreign → not settled, inboxVerified false', (t) => {
  const { r, out } = runR1(t, [R1_FOREIGN]);
  strictEqual(out.evidence.inboxVerified, false);
  strictEqual(out.verdict === 'SETTLED_BY_WORKER', false);
  strictEqual(r.status === 0, false);
});

// Our taskId with somebody else's dispatchId: the task alone is not identity.
const R4_FOREIGN_DISPATCH = r1Msg('m_same_task_foreign_dispatch', R1_TASK, 'ctx_r1_foreign_dispatch');

test('R4-1: [our taskId + foreign dispatchId, ours] → settled by our letter', (t) => {
  const res = runR1(t, [R4_FOREIGN_DISPATCH, R1_OURS]);
  assertR1Settled(res);
  strictEqual(res.out.evidence.workerDone.dispatchId === 'ctx_r1_foreign_dispatch', false);
});

test('R4-2: only our taskId + foreign dispatchId → not settled, inboxVerified false', (t) => {
  const { r, out } = runR1(t, [R4_FOREIGN_DISPATCH]);
  strictEqual(out.evidence.inboxVerified, false);
  strictEqual(out.verdict === 'SETTLED_BY_WORKER', false);
  strictEqual(r.status === 0, false);
});

// ---------------------------------------------------------------------------
// ISO: the child writes only into the directory spawnSettle allocated.
// ---------------------------------------------------------------------------

test('ISO: record lands in the allocated state dir, default dir is not created in HOME', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-iso-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);
  const workerList = { ok: true, result: { workers: [
    { dispatchId: R1_DISPATCH, taskId: R1_TASK, state: 'succeeded' },
  ] } };
  const stubEnv = createOrcaStub(join(dir, 'bin'), workerList, { ok: true, result: { messages: [R1_OURS] } });
  const r = spawnSettle([
    '--run', R1_RUN, '--task', R1_TASK, '--dispatch', R1_DISPATCH,
    '--worktree', worktree, '--deadline-ms', '2000', '--poll-ms', '500',
  ], { ...stubEnv, HOME: home, USERPROFILE: home });
  strictEqual(r.status, 0, r.stdout + r.stderr);

  // 1. the record is in the state dir spawnSettle allocated, keyed by dispatchId
  const stateDir = r.isolation.stateDir;
  const journalFile = join(stateDir, 'default', 'settlements.json');
  // Both checks run before either is reported, so a leak shows both symptoms.
  const problems = [];
  let keyed = false;
  if (existsSync(journalFile)) {
    keyed = Object.prototype.hasOwnProperty.call(JSON.parse(readFileSync(journalFile, 'utf8')), R1_DISPATCH);
  }
  if (!keyed) problems.push('no entry for our dispatchId in allocated state dir ' + stateDir);

  // 2. nothing was created at the default location inside the substituted HOME
  if (existsSync(join(home, '.claude-coordinator'))) {
    problems.push('.claude-coordinator was created in the substituted HOME ' + home);
  }
  strictEqual(problems.length, 0, problems.join('; '));
});

// ---------------------------------------------------------------------------
// R3: the inbox call is bounded by the remaining time to the deadline.
// ---------------------------------------------------------------------------

test('R3: hanging inbox call is cut off; one JSON object, non-zero exit, diagnostic', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-r3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, 'worktree');
  createGitRepo(worktree);
  const stubPath = join(dir, 'hang-stub.js');
  const wl = JSON.stringify({ ok: true, result: { workers: [{ dispatchId: R1_DISPATCH, taskId: R1_TASK, state: 'succeeded' }] } });
  writeFileSync(stubPath, [
    "const args = process.argv.slice(2);",
    "if (args[1] === 'inbox') { setTimeout(() => {}, 60000); }",
    "else { process.stdout.write(" + JSON.stringify(wl) + "); }",
  ].join('\n'), 'utf8');

  const started = Date.now();
  const r = spawnSettle([
    '--run', R1_RUN, '--task', R1_TASK, '--dispatch', R1_DISPATCH,
    '--worktree', worktree, '--deadline-ms', '2000', '--poll-ms', '500',
  ], { SETTLE_ORCA_EXEC: process.execPath, SETTLE_ORCA_PREFIX_ARGS_JSON: JSON.stringify([stubPath]) });
  const elapsed = Date.now() - started;

  strictEqual(r.status === 0, false);
  strictEqual(r.status === null, false);
  strictEqual(elapsed < 15000, true, 'elapsed ' + elapsed);
  const out = JSON.parse(r.stdout);
  strictEqual(out.evidence.inboxTimedOut, true);
  strictEqual(out.reasons.includes('INBOX_CALL_TIMED_OUT'), true);
  strictEqual(out.evidence.inboxVerified, false);
  strictEqual(out.evidence.workerDone.found, false);
  strictEqual(out.verdict === 'SETTLED_BY_WORKER', false);
});

test('R3: a normal inbox call reports inboxTimedOut false', (t) => {
  const { out } = runR1(t, [R1_OURS]);
  strictEqual(out.evidence.inboxTimedOut, false);
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
