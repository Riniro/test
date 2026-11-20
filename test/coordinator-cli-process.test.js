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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { safeCredentialsEnv, writeStubs, liveEnv, liveOfCandidate } from './helpers/route-env.js';

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
function runCli(args, stateDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir, ...extraEnv },
  });
}

/** Фоновый запуск настоящей команды CLI; возвращает процесс и промис его кода. */
function startCli(args, stateDir, extraEnv = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir, ...extraEnv },
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

  const env = prepareRoute(scratch, stateDir);
  const result = runCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, childScript, 'ARG1'], stateDir, env);

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

  const first = startCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, longChild], stateDir, prepareRoute(scratch, stateDir));

  assert.ok(await waitForFile(readyFile), 'дочерняя команда должна подать сигнал готовности');
  assert.ok(lockHeld(stateDir), 'блокировка должна удерживаться, пока дочерняя команда работает');

  const secondEnv = claimEnv(scratch, { extra: { CL_LOG: path.join(scratch, 'second-claim.log') } });
  const second = runCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, markerChild], stateDir, secondEnv);
  assert.ok(!fs.existsSync(path.join(scratch, 'second-claim.log')), 'the second start must not reach the gate (no label mutation)');
  assert.equal(claimCalls(scratch).length, 1, 'only the first start claimed');

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

  const result = runCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, childScript], stateDir, prepareRoute(scratch, stateDir));

  assert.equal(result.status, 0);
  assert.ok(!lockHeld(stateDir), 'после штатного завершения каталог блокировки не должен существовать');
});

// ---------------------------------------------------------------------------
// 4. Ошибка запуска дочерней команды
// ---------------------------------------------------------------------------
test('a child command that cannot be started gives a non-zero code and releases the lock', (t) => {
  const stateDir = mkTmp('cli-proc-state-');
  const scratch = mkTmp('cli-proc-scratch-');
  t.after(() => { rmTmp(stateDir); rmTmp(scratch); });

  const result = runCli(['start', ...ROUTE_FLAGS(), '--', 'definitely-not-a-real-binary-xyz'], stateDir, prepareRoute(scratch, stateDir));

  assert.equal(result.status, 127, 'код возврата — 127: команда не запустилась');
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

  const first = startCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, longChild], stateDir, prepareRoute(scratch, stateDir));

  assert.ok(await waitForFile(readyFile), 'дочерняя команда должна подать сигнал готовности');
  assert.ok(lockHeld(stateDir), 'блокировка должна удерживаться');

  // Жёстко убиваем ОБОЛОЧКУ, то есть процесс CLI. Дочернюю команду не трогаем.
  first.child.kill('SIGKILL');
  await first.exited; // ждём событие exit, а не фиксированную задержку

  assert.ok(lockHeld(stateDir), 'после аварии оболочки блокировка должна остаться захваченной');

  const secondEnv = claimEnv(scratch, { extra: { CL_LOG: path.join(scratch, 'second-claim.log') } });
  const second = runCli(['start', ...ROUTE_FLAGS(), '--', process.execPath, markerChild], stateDir, secondEnv);
  assert.ok(!fs.existsSync(path.join(scratch, 'second-claim.log')), 'the second start must not reach the gate (no label mutation)');
  assert.equal(claimCalls(scratch).length, 1, 'only the first start claimed');

  assert.equal(second.status, 9, 'второй координатор должен получить 9');
  assert.match(second.stdout, /BUSY/, 'второй координатор должен увидеть BUSY');
  assert.ok(!fs.existsSync(markerFile), 'второй координатор не должен запускать свою команду');
});

// ---------------------------------------------------------------------------
// Stage 5 — the launch route: precheck selects a CANDIDATE without claiming; `start` takes the lock,
// re-checks, claims under the lock and only then launches the executor.
// pickup/claim/gh are stub PROCESSES. Races are modelled by an explicitly held lock and by stubbed
// gate answers, never by hoping two processes collide.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';

const CLI_URL = pathToFileURL(CLI).href;
const JOURNAL_URL = pathToFileURL(path.join(REPO_ROOT, 'tools', 'coordinator', 'journal.js')).href;

function runCliEnv(args, stateDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...safeCredentialsEnv(), COORDINATOR_STATE_DIR: stateDir, ...extraEnv },
  });
}

/** Runs a snippet in a FRESH process that can import the journal and resolveRepoKey. */
function freshProcess(scratch, name, body) {
  const script = path.join(scratch, name);
  fs.writeFileSync(script, [
    `import { read, write } from ${JSON.stringify(JOURNAL_URL)};`,
    `import { resolveRepoKey } from ${JSON.stringify(CLI_URL)};`,
    `const repoKey = resolveRepoKey({ cwd: ${JSON.stringify(REPO_ROOT)} });`,
    body,
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The whole journal record as read by a new process, or { unreadable } . */
function readRecord(scratch, stateDir) {
  const out = freshProcess(scratch, 'read-record.mjs', [
    `const r = read({ stateDir: ${JSON.stringify(stateDir)}, repoKey });`,
    'process.stdout.write(JSON.stringify(r.ok ? r.record : { unreadable: r.reason }));',
  ].join('\n'));
  return JSON.parse(out);
}

function seedPatch(scratch, stateDir, patch) {
  freshProcess(scratch, 'seed-patch.mjs',
    `write({ stateDir: ${JSON.stringify(stateDir)}, repoKey, patch: ${JSON.stringify(patch)} });`);
}

function repoKeyOf(scratch) {
  return freshProcess(scratch, 'repo-key.mjs', 'process.stdout.write(repoKey);');
}

/** Puts a lock with a live owner (this test process) where the CLI will look for it. */
function holdLock(scratch, stateDir) {
  const lockPath = path.join(stateDir, repoKeyOf(scratch), 'lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    token: 'held-by-test', pid: process.pid, host: os.hostname(), repoKey: 'k',
    acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), worktree: null,
  }));
  return lockPath;
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PR_URL = 'https://gh.test/o/r/pull/42';
const CLAIMED = { success: true, state: 'claimed', reason: 'claimed', mode: 'implement', pr: null };
const REVIEW = (number = 42, headSha = SHA_A) => ({
  success: true, state: 'review_pending', reason: 'review_pending', mode: 'review', pr: { number, state: 'OPEN', url: PR_URL, headSha },
});
const ROUTE_FLAGS = (issue = 'KAN-14', mode = 'implement') => ['--project', 'KAN', '--repo', 'o/r', '--issue', issue, '--mode', mode];

function freshCandidate(over = {}) {
  return { issueKey: 'KAN-14', mode: 'implement', pr: null, createdAt: new Date().toISOString(), ...over };
}

function agoIso(ms) { return new Date(Date.now() - ms).toISOString(); }

/**
 * Env for `start`: the claim gate AND the live re-read (pickup, gh) are stubs; CL_LOG counts the gate's
 * calls. `live` says what the re-read returns (default: a ready task without a PR).
 */
function claimEnv(scratch, { code = 0, out = CLAIMED, live = {}, extra = {} } = {}) {
  const stubs = writeStubs(scratch);
  return {
    ...liveEnv(scratch, live),
    PRECHECK_CLAIM_SCRIPT: stubs.claim,
    CL_CODE: String(code), CL_OUT: JSON.stringify(out),
    CL_LOG: path.join(scratch, 'claim.log'),
    ...extra,
  };
}

function claimCalls(scratch) {
  const f = path.join(scratch, 'claim.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

/** Seeds a fresh candidate and returns the env for `start`; the live re-read mirrors the candidate unless `live` overrides it. */
function prepareRoute(scratch, stateDir, { candidate = freshCandidate(), live = {}, ...claimOpts } = {}) {
  if (candidate !== null) seedPatch(scratch, stateDir, { candidate });
  return claimEnv(scratch, { ...claimOpts, live: { ...liveOfCandidate(candidate), ...live } });
}

/** A child that records its environment, argv and the journal it can see at launch. */
function writeProbeChild(scratch, markerFile, journalFile) {
  const script = path.join(scratch, 'probe-child.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `const j = fs.existsSync(${JSON.stringify(journalFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(journalFile)}, 'utf8')) : null;`,
    `fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    '  issue: process.env.COORDINATOR_ISSUE_KEY, mode: process.env.COORDINATOR_MODE, createdAt: process.env.COORDINATOR_CLAIM_CREATED_AT,',
    '  journalClaim: j && j.claim,',
    '}));',
  ].join('\n'));
  return script;
}

/** Every refusal must leave no executor, no held lock. */
function assertRefused(r, { code, marker, stateDir }) {
  assert.equal(r.status, code, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(!fs.existsSync(marker), 'the executor must not have been started (marker file exists)');
  assert.ok(!lockHeld(stateDir), 'the lock must be released after a refusal');
}

function newCase(prefix = 'cli-rt-') {
  const stateDir = mkTmp(prefix + 'state-');
  const scratch = mkTmp(prefix + 'scratch-');
  const marker = path.join(scratch, 'marker');
  return { stateDir, scratch, marker, child: writeMarkerChild(scratch, marker), cleanup: () => { rmTmp(stateDir); rmTmp(scratch); } };
}

function runStart(c, env, { flags = ROUTE_FLAGS(), tail } = {}) {
  return runCliEnv(['start', ...flags, '--', ...(tail || [process.execPath, c.child])], c.stateDir, env);
}

// ---------------------------------------------------------------------------
// R1 / R5.11 — precheck: no claim, no label changes, a candidate in the journal
// ---------------------------------------------------------------------------
const PRECHECK_ARGS = ['precheck', '--project', 'KAN', '--repo', 'o/r'];

function precheckEnv(scratch, { pkCode = 0, pkOut, reason = 'ready', ghList = '[]', ghView = '{}', ghListCode = 0, ghViewCode = 0 } = {}) {
  const stubs = writeStubs(scratch);
  return {
    ...safeCredentialsEnv(),
    PRECHECK_PICKUP_SCRIPT: stubs.pickup,
    PRECHECK_CLAIM_SCRIPT: stubs.claim, // must never be called by precheck
    PICKUP_GH_EXEC: stubs.gh,
    PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    PK_CODE: String(pkCode),
    PK_OUT: pkOut === undefined ? JSON.stringify({ work: true, reason, issue: { key: 'KAN-14' }, pr: null, counts: {} }) : pkOut,
    CL_LOG: path.join(scratch, 'claim.log'), CL_CODE: '0', CL_OUT: JSON.stringify(CLAIMED),
    GH_LOG: path.join(scratch, 'gh.log'),
    GH_LIST: ghList, GH_VIEW: ghView, GH_LIST_CODE: String(ghListCode), GH_VIEW_CODE: String(ghViewCode),
  };
}

const OPEN_LIST = JSON.stringify([{ number: 42, state: 'OPEN', title: '[KAN-14] work', url: PR_URL }]);
const MERGED_LIST = JSON.stringify([{ number: 42, state: 'MERGED', title: '[KAN-14] work', url: PR_URL }]);
const VIEW_A = JSON.stringify({ number: 42, state: 'OPEN', headRefOid: SHA_A });

for (const [reason, mode, list, view, pr] of [
  ['ready', 'implement', '[]', '{}', null],
  ['review', 'review', OPEN_LIST, VIEW_A, { number: 42, url: PR_URL, headSha: SHA_A }],
  ['closing', 'close', MERGED_LIST, VIEW_A, { number: 42, url: PR_URL, headSha: SHA_A }],
  ['closing_ci_failed', 'close', MERGED_LIST, VIEW_A, { number: 42, url: PR_URL, headSha: SHA_A }],
]) {
  test(`R1/R5.11: pickup 0 reason=${reason} → code 0, candidate mode=${mode}, nothing claimed, nothing mutated`, (t) => {
    const c = newCase('cli-pc-');
    t.after(c.cleanup);
    const env = precheckEnv(c.scratch, { reason, ghList: list, ghView: view });
    const r = runCliEnv(PRECHECK_ARGS, c.stateDir, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // read by a NEW process
    const rec = readRecord(c.scratch, c.stateDir);
    assert.equal(rec.candidate.issueKey, 'KAN-14');
    assert.equal(rec.candidate.mode, mode);
    assert.deepStrictEqual(rec.candidate.pr, pr);
    assert.match(rec.candidate.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.now() - Date.parse(rec.candidate.createdAt)) < 60000);
    assert.equal(rec.claim, null, 'a candidate is not a captured result');

    // no gate call at all, and the only gh verbs are reads
    assert.ok(!fs.existsSync(env.CL_LOG), 'claim.js must not be called by precheck');
    const ghCalls = fs.existsSync(env.GH_LOG) ? fs.readFileSync(env.GH_LOG, 'utf8').split('\n').filter(Boolean) : [];
    assert.ok(ghCalls.every((l) => /^pr (list|view) /.test(l)), 'precheck may only read: ' + ghCalls.join(' | '));
  });
}

test('R1: PRECHECK_CLAIM_SCRIPT is not used by precheck (a stub that would claim is never run)', (t) => {
  const c = newCase('cli-pc-');
  t.after(c.cleanup);
  const env = precheckEnv(c.scratch, {});
  env.PRECHECK_CLAIM_SCRIPT = path.join(c.scratch, 'does-not-exist.mjs');
  const r = runCliEnv(PRECHECK_ARGS, c.stateDir, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('R1: the PR lookup keeps the keyInTitle filter (a PR of another issue is not ours)', (t) => {
  const c = newCase('cli-pc-');
  t.after(c.cleanup);
  const list = JSON.stringify([{ number: 7, state: 'OPEN', title: '[KAN-141] other work', url: 'u' }]);
  const r = runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, { ghList: list, ghView: VIEW_A }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readRecord(c.scratch, c.stateDir).candidate.pr, null);
});

test('R1: a PR lookup that FAILED is not "no PR": precheck returns 6 and writes no candidate', (t) => {
  for (const over of [{ ghListCode: 1 }, { ghList: 'not json' }, { ghList: '{"a":1}' }, { ghList: OPEN_LIST, ghViewCode: 1 }, { ghList: OPEN_LIST, ghView: 'null' }]) {
    const c = newCase('cli-pc-');
    try {
      const r = runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, over));
      assert.equal(r.status, 6, JSON.stringify(over) + r.stdout + r.stderr);
      assert.ok(!fs.existsSync(path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json')), 'no candidate may be written');
    } finally { c.cleanup(); }
  }
});

test('R1: pickup 0 with a reason outside the table is incomplete data: code 4, no candidate', (t) => {
  for (const reason of ['none', 'closing_ci_pending', 'weird', undefined]) {
    const c = newCase('cli-pc-');
    try {
      const pkOut = JSON.stringify({ work: true, ...(reason === undefined ? {} : { reason }), issue: { key: 'KAN-14' } });
      const r = runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, { pkOut }));
      assert.equal(r.status, 4, String(reason) + r.stderr);
      assert.ok(!fs.existsSync(path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json')));
    } finally { c.cleanup(); }
  }
});

test('R1: pickup 0 without an issue key: code 4, no candidate', (t) => {
  const c = newCase('cli-pc-');
  t.after(c.cleanup);
  const r = runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, { pkOut: '{"work":true,"reason":"ready","issue":null}' }));
  assert.equal(r.status, 4);
  assert.ok(!fs.existsSync(path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json')));
});

for (const [pkCode, pkOut] of [[3, '{"work":false,"reason":"none","issue":null}'], [4, '{"work":false,"reason":"unavailable","issue":null}'], [2, '']]) {
  test(`R1: pickup ${pkCode} is returned as is, the journal is untouched, nothing is called`, (t) => {
    const c = newCase('cli-pc-');
    t.after(c.cleanup);
    const env = precheckEnv(c.scratch, { pkCode, pkOut });
    const r = runCliEnv(PRECHECK_ARGS, c.stateDir, env);
    assert.equal(r.status, pkCode, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(env.CL_LOG));
    assert.ok(!fs.existsSync(env.GH_LOG), 'no PR lookup after a non-zero pickup');
    assert.ok(!fs.existsSync(c.stateDir) || fs.readdirSync(c.stateDir).length === 0, 'journal must not be created');
  });
}

test('R1: the candidate cannot be saved (state dir is a file) → precheck 5', (t) => {
  const scratch = mkTmp('cli-pc-scratch-');
  t.after(() => rmTmp(scratch));
  const stateDir = path.join(scratch, 'state-is-a-file');
  fs.writeFileSync(stateDir, 'not a directory');
  const r = runCliEnv(PRECHECK_ARGS, stateDir, precheckEnv(scratch, {}));
  assert.equal(r.status, 5, r.stdout + r.stderr);
});

test('R1: precheck does not touch an existing accepted result', (t) => {
  const c = newCase('cli-pc-');
  t.after(c.cleanup);
  const accepted = { issueKey: 'KAN-9', state: 'claimed', mode: 'implement', pr: null, createdAt: agoIso(1000) };
  seedPatch(c.scratch, c.stateDir, { claim: accepted });
  const r = runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, {}));
  assert.equal(r.status, 0, r.stderr);
  assert.deepStrictEqual(readRecord(c.scratch, c.stateDir).claim, accepted);
});

// ---------------------------------------------------------------------------
// R2 / R5 — start
// ---------------------------------------------------------------------------
test('R2: start without --project/--repo/--issue/--mode (or with an unknown mode) is code 2 with usage', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const base = ['--project', 'KAN', '--repo', 'o/r', '--issue', 'KAN-14', '--mode', 'implement'];
  const env = prepareRoute(c.scratch, c.stateDir);
  for (const drop of [0, 2, 4, 6]) {
    const flags = base.filter((_, i) => i !== drop && i !== drop + 1);
    const r = runStart(c, env, { flags });
    assertRefused(r, { code: 2, marker: c.marker, stateDir: c.stateDir });
    assert.match(r.stderr, /Usage/);
  }
  assertRefused(runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'nonsense') }), { code: 2, marker: c.marker, stateDir: c.stateDir });
  assertRefused(runStart(c, env, { tail: [] }), { code: 2, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R5.1: the lock is held; a second start gets 9, spawns no executor, mutates no label (gate calls = 0)', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  holdLock(c.scratch, c.stateDir);
  const r = runStart(c, env);
  assert.equal(r.status, 9, r.stdout + r.stderr);
  assert.match(r.stdout, /BUSY/);
  assert.ok(!fs.existsSync(c.marker), 'no executor');
  assert.equal(claimCalls(c.scratch).length, 0, 'the gate (the only label mutator) must not be called');
});

test('R5.10: lock before journal — a held lock with a MISSING journal is 9, not 15', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = claimEnv(c.scratch);
  // control: without the lock the same setup reaches the journal and is 15
  const control = runStart(c, env);
  assert.equal(control.status, 15, control.stderr);
  holdLock(c.scratch, c.stateDir);
  const r = runStart(c, env);
  assert.equal(r.status, 9, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(c.marker));
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R5.10: lock before journal — a held lock with a CORRUPT journal is 9, not 15', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = claimEnv(c.scratch);
  const jf = path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json');
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  fs.writeFileSync(jf, '{ this is not json');
  const control = runStart(c, env);
  assert.equal(control.status, 15, control.stderr);
  assert.ok(!lockHeld(c.stateDir));
  holdLock(c.scratch, c.stateDir);
  const r = runStart(c, env);
  assert.equal(r.status, 9, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(c.marker));
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R2: no candidate (absent, null, or not an object) → 15, gate not called, executor not started', (t) => {
  for (const candidate of [undefined, null, 'KAN-14', 7, ['KAN-14']]) {
    const c = newCase();
    try {
      const env = claimEnv(c.scratch);
      if (candidate !== undefined) seedPatch(c.scratch, c.stateDir, { candidate });
      assertRefused(runStart(c, env), { code: 15, marker: c.marker, stateDir: c.stateDir });
      assert.equal(claimCalls(c.scratch).length, 0, JSON.stringify(candidate));
    } finally { c.cleanup(); }
  }
});

test('R5.6: a candidate older than 5 minutes → 16, the gate is not called, no executor', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: freshCandidate({ createdAt: agoIso(5 * 60 * 1000 + 5000) }) });
  assertRefused(runStart(c, env), { code: 16, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R5.6: a candidate without a usable createdAt cannot be aged, so it does not start (16)', (t) => {
  for (const createdAt of [undefined, null, 'yesterday', 12345, new Date(Date.now() + 3600 * 1000).toISOString()]) {
    const c = newCase();
    try {
      const cand = freshCandidate();
      if (createdAt === undefined) delete cand.createdAt; else cand.createdAt = createdAt;
      const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand });
      assertRefused(runStart(c, env), { code: 16, marker: c.marker, stateDir: c.stateDir });
      assert.equal(claimCalls(c.scratch).length, 0);
    } finally { c.cleanup(); }
  }
});

test('R5.7: a journal write (stage) moves updatedAt but does not extend the candidate: still 16 after 5 minutes', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: freshCandidate({ createdAt: agoIso(6 * 60 * 1000) }) });
  seedPatch(c.scratch, c.stateDir, { stage: 'running' }); // updatedAt is now "now"
  const rec = readRecord(c.scratch, c.stateDir);
  assert.ok(Date.now() - Date.parse(rec.updatedAt) < 60000, 'premise: updatedAt is fresh');
  assert.ok(Date.now() - Date.parse(rec.candidate.createdAt) > 5 * 60 * 1000, 'premise: the candidate itself is old');
  assertRefused(runStart(c, env), { code: 16, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R2: --issue or --mode that differs from the candidate → 17, gate not called', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  assertRefused(runStart(c, env, { flags: ROUTE_FLAGS('KAN-15', 'implement') }), { code: 17, marker: c.marker, stateDir: c.stateDir });
  assertRefused(runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') }), { code: 17, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R2: the gate is asked about the CANDIDATE issue, with --adopt-existing', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  const r = runStart(c, env);
  assert.equal(r.status, 0, r.stderr);
  const calls = claimCalls(c.scratch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '--project KAN --issue KAN-14 --repo o/r --adopt-existing');
});

test('R5.2: the task is blocked between precheck and start → the gate says 3, no executor, no new accepted result', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { code: 3, out: { success: false, reason: 'blocked', state: 'blocked' } });
  assertRefused(runStart(c, env), { code: 3, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 1, 'the live check really ran');
  assert.equal(readRecord(c.scratch, c.stateDir).claim, null);
});

test('R5.8: a mandatory source failed (gate 6) → the route returns 6, no executor', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { code: 6, out: { success: false, reason: 'source_unavailable', state: 'source_unavailable' } });
  assertRefused(runStart(c, env), { code: 6, marker: c.marker, stateDir: c.stateDir });
  assert.equal(readRecord(c.scratch, c.stateDir).claim, null);
});

for (const [code, state] of [[2, 'not_found'], [3, 'not_ready'], [4, 'awaiting_merge'], [4, 'work_exists'], [5, 'readback_failed'], [7, 'mutation_failed']]) {
  test(`R2: gate ${code} ${state} is returned as is; no executor`, (t) => {
    const c = newCase();
    t.after(c.cleanup);
    const env = prepareRoute(c.scratch, c.stateDir, { code, out: { success: false, reason: state, state } });
    assertRefused(runStart(c, env), { code, marker: c.marker, stateDir: c.stateDir });
  });
}

// ---------------------------------------------------------------------------
// R2 (fix round) — "captured but not started" is a separate state, not an ordinary refusal.
// Everything below the claim leaves an orphanedClaim; labels are never put back by the route.
// ---------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function orphanRecord(c) { return readRecord(c.scratch, c.stateDir).orphanedClaim; }

/** The orphan is recorded, printed in the contract format, and nothing was started or put back. */
function assertOrphaned(c, r, { code, state, mode = 'implement', reason }) {
  assert.equal(r.status, code, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(!fs.existsSync(c.marker), 'the executor must not have been started');
  assert.ok(!lockHeld(c.stateDir), 'the lock must be released');
  const o = orphanRecord(c);
  assert.ok(o, 'orphanedClaim must be in the journal: ' + r.stderr);
  assert.deepStrictEqual(Object.keys(o).sort(), ['code', 'createdAt', 'issueKey', 'mode', 'reason', 'state']);
  assert.equal(o.issueKey, 'KAN-14');
  assert.equal(o.mode, mode);
  assert.equal(o.state, state);
  assert.equal(o.code, code);
  assert.match(o.createdAt, ISO_RE);
  assert.ok(Math.abs(Date.now() - Date.parse(o.createdAt)) < 60000);
  if (reason) assert.match(o.reason, reason);
  const line = `ORPHANED_CLAIM: KAN-14 ${mode} code=${code} ${o.reason}`;
  assert.ok(r.stderr.split('\n').includes(line), 'the contract line must be printed: ' + r.stderr);
  assert.doesNotMatch(r.stderr, /ORPHANED_CLAIM_UNRECORDED/, 'the record succeeded, so nothing is unrecorded');
  assert.equal(claimCalls(c.scratch).length, 1, 'the route never calls the gate again to put labels back');
}

for (const [state, mode] of [['claimed', 'review'], ['review_pending', 'implement'], ['closing', 'implement'], ['work_exists', null], ['unknown_state', 'implement']]) {
  test(`R5/R2: gate 0 with ${state}/${mode} is not a permit → 5, no executor, an orphanedClaim`, (t) => {
    const c = newCase();
    t.after(c.cleanup);
    const env = prepareRoute(c.scratch, c.stateDir, { out: { success: true, state, reason: state, mode, pr: null } });
    const r = runStart(c, env);
    // the orphan names the mode the gate answered with, or the candidate's when it answered none
    assertOrphaned(c, r, { code: 5, state, mode: mode === null ? 'implement' : mode, reason: /unusable state\/mode/ });
    assert.equal(readRecord(c.scratch, c.stateDir).claim, null, 'nothing is accepted');
  });
}

// ---------------------------------------------------------------------------
// R1 (fix round) — the live data is re-read BEFORE the claim, read-only. A discrepancy means the gate is
// never called, so nothing is mutated and no orphan is left.
// ---------------------------------------------------------------------------
/** Refused before the claim: gate calls = 0, nothing started, lock released, no accepted result, NO orphan. */
function assertRefusedBeforeClaim(c, r, code) {
  assertRefused(r, { code, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0, 'the gate (the only label mutator) must not be called');
  const rec = readRecord(c.scratch, c.stateDir);
  assert.equal(rec.claim, null, 'no accepted result');
  assert.equal(rec.orphanedClaim, null, 'nothing was captured, so no orphan');
}

test('R1: the re-read comes BEFORE the claim — pickup, PR list, PR view, then the gate (one shared call log)', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const seq = path.join(c.scratch, 'sequence.log');
  const cand = freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, out: REVIEW(42, SHA_A), extra: { PK_LOG: seq, GH_LOG: seq, CL_LOG: seq } });
  const r = runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(seq, 'utf8').split('\n').filter(Boolean);
  const kinds = lines.map((l) => (l.startsWith('--project KAN --issue') ? 'claim' : l.startsWith('--project') ? 'pickup' : l.startsWith('pr list') ? 'list' : l.startsWith('pr view') ? 'view' : l));
  assert.deepStrictEqual(kinds, ['pickup', 'list', 'view', 'claim']);
  assert.match(lines[0], /--json/);
});

test('R1: the re-read only reads — every gh verb is pr list / pr view, and the pickup is asked with the same flags as precheck', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const cand = freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, out: REVIEW(42, SHA_A) });
  assert.equal(runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') }).status, 0);
  const gh = fs.readFileSync(env.GH_LOG, 'utf8').split('\n').filter(Boolean);
  assert.ok(gh.length >= 2 && gh.every((l) => /^pr (list|view) /.test(l)), gh.join(' | '));
  assert.equal(fs.readFileSync(env.PK_LOG, 'utf8').trim(), '--project KAN --repo o/r --json');
});

test('R5.3/R1: candidate implement, the live pickup now says review (a PR appeared) → 18 naming both modes, the gate is NOT called, the new mode is not worked or recorded', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, {
    live: { mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } }, out: REVIEW(),
  });
  const r = runStart(c, env);
  assertRefusedBeforeClaim(c, r, 18);
  assert.match(r.stderr, /implement/);
  assert.match(r.stderr, /review/);
  assert.equal(fs.readFileSync(env.PK_LOG, 'utf8').trim().split('\n').length, 1, 'the live check ran');
  // and not even by re-targeting: the same call with --mode review is refused as a mismatch with the candidate
  assertRefused(runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') }), { code: 17, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0);
});

test('R5.4/R1: the PR head changed since precheck → 18 before the claim', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const cand = freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, live: { pr: { number: 42, url: PR_URL, headSha: SHA_B } }, out: REVIEW(42, SHA_B) });
  const r = runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') });
  assertRefusedBeforeClaim(c, r, 18);
  assert.match(r.stderr, /head/);
});

test('R5.5/R1: the linked PR changed (another number) → 18 before the claim', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const cand = freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, live: { pr: { number: 43, url: PR_URL, headSha: SHA_A } }, out: REVIEW(43, SHA_A) });
  const r = runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') });
  assertRefusedBeforeClaim(c, r, 18);
  assert.match(r.stderr, /#42/);
  assert.match(r.stderr, /#43/);
});

test('R1: the candidate had a PR but now none is found → 18 before the claim', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const cand = freshCandidate({ mode: 'implement', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, live: { pr: null }, out: CLAIMED });
  assertRefusedBeforeClaim(c, runStart(c, env), 18);
});

test('R1: the mode is the same but a PR appeared that the candidate did not have → 18 before the claim', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { live: { pr: { number: 42, url: PR_URL, headSha: SHA_A } }, out: CLAIMED });
  assertRefusedBeforeClaim(c, runStart(c, env), 18);
});

test('R1: the lock on the task appeared after precheck — the pickup no longer returns it → 18, the gate is never called', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  // a blocked task is not returned by the pickup: it returns another issue (or the same task is gone)
  const env = prepareRoute(c.scratch, c.stateDir, { live: { issue: 'KAN-99' } });
  const r = runStart(c, env);
  assertRefusedBeforeClaim(c, r, 18);
  assert.match(r.stderr, /KAN-99/);
  assert.match(r.stderr, /KAN-14/);
});

test('R1: the live pickup returns 0 without an issue, or with a reason outside the table → 18, the gate is not called', (t) => {
  for (const pkOut of [
    JSON.stringify({ work: true, reason: 'ready', issue: null }),
    JSON.stringify({ work: true, reason: 'closing_ci_pending', issue: { key: 'KAN-14' } }),
    JSON.stringify({ work: true, reason: 'weird', issue: { key: 'KAN-14' } }),
    JSON.stringify({ work: true, issue: { key: 'KAN-14' } }),
  ]) {
    const c = newCase();
    try {
      const env = prepareRoute(c.scratch, c.stateDir, { live: { pkOut } });
      assertRefusedBeforeClaim(c, runStart(c, env), 18);
    } finally { c.cleanup(); }
  }
});

for (const [pkCode, pkOut] of [[3, '{"work":false,"reason":"none","issue":null}'], [4, '{"work":false,"reason":"unavailable","issue":null}'], [2, '']]) {
  test(`R1: the live pickup returns ${pkCode} → the route stops with that code, the gate is not called`, (t) => {
    const c = newCase();
    t.after(c.cleanup);
    const env = prepareRoute(c.scratch, c.stateDir, { live: { pkCode, pkOut } });
    const r = runStart(c, env);
    assertRefusedBeforeClaim(c, r, pkCode);
  });
}

test('R1: a live PR lookup that FAILED is not "no PR": 6, the gate is not called', (t) => {
  for (const extra of [{ GH_LIST_CODE: '1' }, { GH_LIST: 'not json' }, { GH_LIST: '{"a":1}' }]) {
    const c = newCase();
    try {
      const env = prepareRoute(c.scratch, c.stateDir, { extra });
      assertRefusedBeforeClaim(c, runStart(c, env), 6);
    } finally { c.cleanup(); }
  }
});

test('R2/R1 last line of defence: the live re-read agrees with the candidate but the GATE answers another mode → 18, and now it IS an orphan (the labels changed)', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, { out: REVIEW() }); // re-read: implement; gate: review
  const r = runStart(c, env);
  assertOrphaned(c, r, { code: 18, state: 'review_pending', mode: 'review', reason: /mode changed/ });
  assert.equal(readRecord(c.scratch, c.stateDir).claim, null, 'the other mode is not accepted');
});

test('R2/R1 last line of defence: the gate answers another PR head → 18 and an orphan', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const cand = freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } });
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, out: REVIEW(42, SHA_B) });
  const r = runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', 'review') });
  assertOrphaned(c, r, { code: 18, state: 'review_pending', mode: 'review', reason: /head/ });
});

test('R2: a head that was compared is reported headComparable:true; an unknown candidate head is reported false, not passed off as compared', (t) => {
  const withHead = newCase();
  const noHead = newCase();
  t.after(() => { withHead.cleanup(); noHead.cleanup(); });
  const flags = ROUTE_FLAGS('KAN-14', 'review');

  let env = prepareRoute(withHead.scratch, withHead.stateDir, {
    candidate: freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: SHA_A } }), out: REVIEW(42, SHA_A),
  });
  let r = runStart(withHead, env, { flags });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"headComparable":true/);

  // the candidate had no head: whatever head is found now, nothing was compared
  env = prepareRoute(noHead.scratch, noHead.stateDir, {
    candidate: freshCandidate({ mode: 'review', pr: { number: 42, url: PR_URL, headSha: null } }),
    live: { pr: { number: 42, url: PR_URL, headSha: SHA_B } }, out: REVIEW(42, SHA_B),
  });
  r = runStart(noHead, env, { flags });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"headComparable":false/);
  assert.doesNotMatch(r.stdout, /"headComparable":true/);
});

test('R5.9/R2: the accepted result cannot be saved (journal is unwritable under the lock) → 5, no executor; the orphan cannot be recorded EITHER, so it is printed and marked UNRECORDED', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir, {
    extra: { CL_SABOTAGE_JOURNAL: '' },
  });
  // the gate stub replaces journal.json with a directory right before it answers 0
  env.CL_SABOTAGE_JOURNAL = path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json');
  const r = runStart(c, env);
  assertRefused(r, { code: 5, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 1, 'the claim itself happened; only the saving failed');
  const lines = r.stderr.split('\n');
  assert.ok(lines.some((l) => /^ORPHANED_CLAIM: KAN-14 implement code=5 .*not saved/.test(l)), 'printed regardless of the journal: ' + r.stderr);
  assert.ok(lines.includes('ORPHANED_CLAIM_UNRECORDED'), 'the failed record is announced: ' + r.stderr);
});

test('R2: the executor cannot be started (ENOENT) → 127 AND an orphan; the gate is not called again', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  const r = runStart(c, env, { tail: ['definitely-not-a-real-binary-xyz'] });
  assertOrphaned(c, r, { code: 127, state: 'claimed', reason: /could not be started/ });
});

// ---------------------------------------------------------------------------
// R2 — while an orphanedClaim exists: precheck writes no candidate (14), start refuses before the claim (14)
// ---------------------------------------------------------------------------
const ORPHAN = { issueKey: 'KAN-14', mode: 'implement', state: 'claimed', code: 5, reason: 'seeded by the test', createdAt: new Date().toISOString() };

test('R2: an unresolved orphan → precheck returns 14, writes no candidate, asks no source', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  const old = freshCandidate({ issueKey: 'KAN-1', createdAt: agoIso(60000) });
  seedPatch(c.scratch, c.stateDir, { candidate: old, orphanedClaim: ORPHAN });
  const env = precheckEnv(c.scratch, {});
  const r = runCliEnv(PRECHECK_ARGS, c.stateDir, env);
  assert.equal(r.status, 14, r.stdout + r.stderr);
  assert.match(r.stderr, /orphaned claim/);
  assert.deepStrictEqual(readRecord(c.scratch, c.stateDir).candidate, old, 'the candidate was not rewritten');
  assert.ok(!fs.existsSync(env.GH_LOG), 'no PR lookup');
});

test('R2: an unresolved orphan → start returns 14 BEFORE the claim, even with a fresh matching candidate', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  const r = runStart(c, env);
  assertRefused(r, { code: 14, marker: c.marker, stateDir: c.stateDir });
  assert.equal(claimCalls(c.scratch).length, 0, 'the gate must not be called');
  assert.ok(!fs.existsSync(env.PK_LOG), 'not even the re-read ran');
  assert.deepStrictEqual(orphanRecord(c), ORPHAN, 'the record is untouched');
});

test('R2: an orphan of ANOTHER issue blocks the route just the same (the state of the repository is undefined)', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: { ...ORPHAN, issueKey: 'KAN-7' } });
  assertRefused(runStart(c, env), { code: 14, marker: c.marker, stateDir: c.stateDir });
  assert.equal(runCliEnv(PRECHECK_ARGS, c.stateDir, precheckEnv(c.scratch, {})).status, 14);
});

test('R2: the lock is taken before the orphan is read — a held lock is still 9', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  holdLock(c.scratch, c.stateDir);
  assert.equal(runStart(c, env).status, 9);
});

// ---------------------------------------------------------------------------
// R2 — clear-orphan: a human decision, the journal only, Jira untouched
// ---------------------------------------------------------------------------
const CLEAR = (issue = 'KAN-14') => ['clear-orphan', '--issue', issue, '--confirm', '--reason', 'looked at the labels, fine'];

test('R2: clear-orphan without --confirm or without --reason → 12, the record stays', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  for (const args of [
    ['clear-orphan', '--issue', 'KAN-14'],
    ['clear-orphan', '--issue', 'KAN-14', '--confirm'],
    ['clear-orphan', '--issue', 'KAN-14', '--reason', 'because'],
    ['clear-orphan', '--issue', 'KAN-14', '--confirm', '--reason', ''],
  ]) {
    const r = runCliEnv(args, c.stateDir);
    assert.equal(r.status, 12, args.join(' ') + r.stdout + r.stderr);
    assert.deepStrictEqual(orphanRecord(c), ORPHAN, 'nothing may be cleared without the confirmation');
  }
});

test('R2: clear-orphan --issue that does not match the record → 17, the record stays', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  const r = runCliEnv(CLEAR('KAN-15'), c.stateDir);
  assert.equal(r.status, 17, r.stdout + r.stderr);
  assert.deepStrictEqual(orphanRecord(c), ORPHAN);
});

test('R2: clear-orphan with no record → 0', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  assert.equal(runCliEnv(CLEAR(), c.stateDir).status, 0);
  seedPatch(c.scratch, c.stateDir, { stage: 'x' });
  assert.equal(runCliEnv(CLEAR(), c.stateDir).status, 0);
});

test('R2: clear-orphan removes the record, writes nothing to Jira (no gate, no pickup, no gh), and the route works again', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  assertRefused(runStart(c, env), { code: 14, marker: c.marker, stateDir: c.stateDir });
  const r = runCliEnv(CLEAR(), c.stateDir, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(orphanRecord(c), null);
  assert.equal(claimCalls(c.scratch).length, 0, 'the gate is not called by clear-orphan');
  assert.ok(!fs.existsSync(env.PK_LOG) && !fs.existsSync(env.GH_LOG), 'no source is asked');
  // the candidate is still fresh: the route may start now
  const again = runStart(c, env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(fs.existsSync(c.marker));
});

test('R2: status and recover show the orphanedClaim when there is one, and not when there is none', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  seedPatch(c.scratch, c.stateDir, { stage: 'running' });
  assert.doesNotMatch(runCliEnv(['status'], c.stateDir).stdout, /orphanedClaim/);
  assert.doesNotMatch(runCliEnv(['recover'], c.stateDir).stdout, /orphanedClaim/);
  seedPatch(c.scratch, c.stateDir, { orphanedClaim: ORPHAN });
  for (const cmd of ['status', 'recover']) {
    const out = runCliEnv([cmd], c.stateDir).stdout;
    assert.match(out, /orphanedClaim: \{/, cmd);
    assert.match(out, /seeded by the test/, cmd);
  }
});

test('R2: a journal of the previous format (no orphanedClaim) is not damaged and reads as null', (t) => {
  const c = newCase('cli-orph-');
  t.after(c.cleanup);
  seedPatch(c.scratch, c.stateDir, { stage: 'running' });
  const jf = path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json');
  const rec = JSON.parse(fs.readFileSync(jf, 'utf8'));
  delete rec.orphanedClaim; delete rec.claim; delete rec.candidate;
  const { checksum, ...body } = rec;
  const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  rec.checksum = crypto.createHash('sha256').update(JSON.stringify(sorted(body))).digest('hex');
  fs.writeFileSync(jf, JSON.stringify(rec));
  assert.equal(readRecord(c.scratch, c.stateDir).orphanedClaim, null);
  assert.equal(runCliEnv(['status'], c.stateDir).status, 0);
});

test('R2: success — accepted result saved BEFORE the executor, executor gets the task in the environment, argv untouched, lock released', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const candidateCreatedAt = agoIso(2000);
  const env = prepareRoute(c.scratch, c.stateDir, { candidate: freshCandidate({ createdAt: candidateCreatedAt }) });
  const journalFile = path.join(c.stateDir, repoKeyOf(c.scratch), 'journal.json');
  const probe = writeProbeChild(c.scratch, c.marker, journalFile);
  const r = runStart(c, env, { tail: [process.execPath, probe, 'A', '--issue', 'OTHER-1', '--mode', 'review'] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!lockHeld(c.stateDir));

  const seen = JSON.parse(fs.readFileSync(c.marker, 'utf8'));
  assert.deepStrictEqual(seen.argv, ['A', '--issue', 'OTHER-1', '--mode', 'review'], 'the command after -- is neither rewritten nor extended');
  assert.equal(seen.issue, 'KAN-14');
  assert.equal(seen.mode, 'implement');
  assert.ok(seen.journalClaim, 'the executor must find the accepted result already in the journal');
  assert.equal(seen.createdAt, seen.journalClaim.createdAt);
  assert.notEqual(seen.createdAt, candidateCreatedAt, 'the accepted result has its own creation time, not the candidate\'s');
  assert.deepStrictEqual(
    { issueKey: seen.journalClaim.issueKey, state: seen.journalClaim.state, mode: seen.journalClaim.mode, pr: seen.journalClaim.pr },
    { issueKey: 'KAN-14', state: 'claimed', mode: 'implement', pr: null },
  );
  assert.ok(Math.abs(Date.now() - Date.parse(seen.createdAt)) < 60000);
  assert.equal(readRecord(c.scratch, c.stateDir).claim.createdAt, seen.createdAt, 'createdAt is not rewritten afterwards');
});

test('R2: review and close routes launch too, with PR data in the accepted result', (t) => {
  for (const [mode, out] of [
    ['review', REVIEW(42, SHA_A)],
    ['close', { success: true, state: 'closing', reason: 'closing', mode: 'close', pr: { number: 42, state: 'MERGED', url: PR_URL, headSha: SHA_A } }],
  ]) {
    const c = newCase();
    try {
      const cand = freshCandidate({ mode, pr: { number: 42, url: PR_URL, headSha: SHA_A } });
      const env = prepareRoute(c.scratch, c.stateDir, { candidate: cand, out });
      const r = runStart(c, env, { flags: ROUTE_FLAGS('KAN-14', mode) });
      assert.equal(r.status, 0, mode + r.stdout + r.stderr);
      assert.deepStrictEqual(readRecord(c.scratch, c.stateDir).claim.pr, { number: 42, url: PR_URL, headSha: SHA_A });
      assert.ok(fs.existsSync(c.marker));
    } finally { c.cleanup(); }
  }
});

test('R2: secrets are not printed: the lock token never reaches stdout/stderr of start', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const env = prepareRoute(c.scratch, c.stateDir);
  const r = runStart(c, env);
  const lockPath = path.join(c.stateDir, repoKeyOf(c.scratch), 'lock');
  assert.ok(!fs.existsSync(lockPath));
  assert.doesNotMatch(r.stdout + r.stderr, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

// ---------------------------------------------------------------------------
// R3 / R5.12 — force-release on the real CLI
// ---------------------------------------------------------------------------
function plantOwnerFile(scratch, stateDir, owner) {
  const lockPath = path.join(stateDir, repoKeyOf(scratch), 'lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    token: 'SECRET-TOKEN-xyz', host: os.hostname(), repoKey: 'k', acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), worktree: null, ...owner,
  }));
  return lockPath;
}

function deadPidProc() {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

const FORCE = ['force-release', '--confirm', '--reason', 'operator checked'];

test('R5.12: force-release of a proven dead owner releases the lock (0)', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const lockPath = plantOwnerFile(c.scratch, c.stateDir, { pid: deadPidProc() });
  const r = runCliEnv(FORCE, c.stateDir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(lockPath));
});

test('R5.12: force-release of a live owner is refused with 19 and names what stayed unchecked; lock stays', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const lockPath = plantOwnerFile(c.scratch, c.stateDir, { pid: process.pid });
  const r = runCliEnv(FORCE, c.stateDir);
  assert.equal(r.status, 19, r.stdout + r.stderr);
  assert.match(r.stdout, /ownerState: alive/);
  assert.match(r.stdout, /unverified:/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET-TOKEN-xyz/, 'the token is never printed');
  assert.ok(fs.existsSync(lockPath));
});

test('R5.12: force-release of an undetermined (foreign host) owner is refused with 19; lock stays', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  const lockPath = plantOwnerFile(c.scratch, c.stateDir, { pid: deadPidProc(), host: os.hostname() + '-elsewhere' });
  const r = runCliEnv(FORCE, c.stateDir);
  assert.equal(r.status, 19, r.stdout + r.stderr);
  assert.match(r.stdout, /ownerState: undetermined/);
  assert.match(r.stdout, /host/);
  assert.ok(fs.existsSync(lockPath));
});

test('R3: force-release without --confirm/--reason is still 12; status shows ownerState', (t) => {
  const c = newCase();
  t.after(c.cleanup);
  plantOwnerFile(c.scratch, c.stateDir, { pid: process.pid });
  assert.equal(runCliEnv(['force-release'], c.stateDir).status, 12);
  const st = runCliEnv(['status'], c.stateDir);
  assert.match(st.stdout, /ownerState: alive/);
  assert.doesNotMatch(st.stdout, /SECRET-TOKEN-xyz/);
});

// ---------------------------------------------------------------------------
// R5 (fix round) — a mis-wired gate must not reach anything outside this machine.
// The REAL pickup.js runs (nothing replaces it); the credentials are the test ones and point to a local
// listener. Home directories are redirected to an empty folder, so even a credentials file that is
// looked up "by default" cannot be found.
// ---------------------------------------------------------------------------
import http from 'node:http';

test('R5: with the pickup/claim scripts NOT replaced, the route talks only to the local test address, with the TEST credentials, and stops', async (t) => {
  const c = newCase('cli-r5-');
  const credsDir = mkTmp('cli-r5-creds-');
  const emptyHome = mkTmp('cli-r5-home-');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization });
    req.resume();
    res.statusCode = 500;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); c.cleanup(); rmTmp(credsDir); rmTmp(emptyHome); });
  const { port } = server.address();

  const credsFile = path.join(credsDir, 'jira-creds.json');
  fs.writeFileSync(credsFile, JSON.stringify({ site: `http://127.0.0.1:${port}`, email: 'test@example.com', token: 'test-token-not-real' }));

  const env = prepareRoute(c.scratch, c.stateDir);
  delete env.PRECHECK_PICKUP_SCRIPT; // deliberately: the real pickup.js
  delete env.PRECHECK_CLAIM_SCRIPT;  // deliberately: the real claim.js
  const child = spawn(process.execPath, [CLI, 'start', ...ROUTE_FLAGS(), '--', process.execPath, c.child], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, JIRA_CREDENTIALS_FILE: credsFile, COORDINATOR_STATE_DIR: c.stateDir, HOME: emptyHome, USERPROFILE: emptyHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));

  assert.equal(code, 4, 'the source answered 500: unavailable, not "no work". ' + stdout + stderr);
  assert.ok(requests.length > 0, 'premise: the real pickup really ran and used the credentials file it was given');
  const expectedAuth = 'Basic ' + Buffer.from('test@example.com:test-token-not-real').toString('base64');
  for (const rq of requests) {
    assert.equal(rq.host, `127.0.0.1:${port}`, 'every request goes to the local address');
    assert.equal(rq.auth, expectedAuth, 'and carries the test credentials');
  }
  assert.ok(!fs.existsSync(c.marker), 'no executor');
  assert.equal(claimCalls(c.scratch).length, 0);
  assert.doesNotMatch(stdout + stderr, /test-token-not-real/, 'no secret is printed');
});

test('R5: every environment factory of these tests names a LOCAL credentials file (the safe default cannot be lost)', (t) => {
  const c = newCase('cli-r5-');
  t.after(c.cleanup);
  for (const env of [claimEnv(c.scratch), prepareRoute(c.scratch, c.stateDir), precheckEnv(c.scratch, {}), safeCredentialsEnv()]) {
    assert.ok(env.JIRA_CREDENTIALS_FILE, 'JIRA_CREDENTIALS_FILE is set explicitly');
    const creds = JSON.parse(fs.readFileSync(env.JIRA_CREDENTIALS_FILE, 'utf8'));
    assert.match(creds.site, /^http:\/\/127\.0\.0\.1:\d+$/, 'a local address');
    assert.equal(creds.token, 'test-token-not-real');
  }
});
