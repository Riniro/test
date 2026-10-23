import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'jira', 'pickup.js');

// Import the module — node:test caches it.
// On Windows, path.join produces a bare path that import() can't handle;
// convert to file:// URL first.
const pickupMod = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'jira', 'pickup.js')).href);
const parseCheckRuns = pickupMod.parseCheckRuns;
const keyInTitle = pickupMod.keyInTitle;
const determinePrStatus = pickupMod.determinePrStatus;
const readPickupState = pickupMod.readPickupState;
const addStoredFailure = pickupMod.addStoredFailure;
const findStoredFailure = pickupMod.findStoredFailure;
const removeStoredFailuresForIssue = pickupMod.removeStoredFailuresForIssue;

// ==========================================================================
// Helpers
// ==========================================================================

function mkTempDir(prefix) { return fs.mkdtempSync(path.join(tmpdir(), prefix + '-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' ? addr.port : null;
      resolve({ server: srv, port, close: () => new Promise((res) => srv.close(res)) });
    });
  });
}

function writeCredsFile(dir, site) {
  const p = path.join(dir, 'jira-creds.json');
  fs.writeFileSync(p, JSON.stringify({ site, email: 'test@example.com', token: 'tok-123' }), 'utf8');
  return p;
}

function runSpawn(scriptPath, args, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM' });
    const out = [], serr = [];
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    const t = setTimeout(() => { ch.kill(); settle({ status: null, stdout: 'timeout', stderr: 'timeout' }); }, timeoutMs);
    ch.stdout.on('data', (d) => { out.push(d); });
    ch.stderr.on('data', (d) => { serr.push(d); });
    ch.on('close', (code) => { clearTimeout(t); settle({ status: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(serr).toString('utf8') }); });
    ch.on('error', () => { clearTimeout(t); settle({ status: null, stdout: '', stderr: 'spawn error' }); });
  });
}

// ==========================================================================
// parseCheckRuns
// ==========================================================================

describe('parseCheckRuns', () => {
  test('empty → pending', () => assert.strictEqual(parseCheckRuns([]), 'pending'));
  test('queued → pending', () => assert.strictEqual(parseCheckRuns([{ status: 'queued' }]), 'pending'));
  test('in_progress → pending', () => assert.strictEqual(parseCheckRuns([{ status: 'in_progress' }]), 'pending'));
  test('completed success → green', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'success' }]), 'green'));
  test('completed failure → failed', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'failure' }]), 'failed'));
  test('timed_out → failed', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'timed_out' }]), 'failed'));
  test('cancelled → failed', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'cancelled' }]), 'failed'));
  test('skipped does not count as failure', () => assert.strictEqual(parseCheckRuns([{ status: 'skipped' }]), 'green'));
  test('mixed completed + queued → green', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'success' }, { status: 'queued' }]), 'green'));
  test('completed success + completed failure → failed', () => assert.strictEqual(parseCheckRuns([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'failed'));
});

// ==========================================================================
// keyInTitle
// ==========================================================================

describe('keyInTitle', () => {
  test('exact match', () => assert.strictEqual(keyInTitle('KAN-1', 'Fix KAN-1 bug'), true));
  test('no match: substring KAN-14', () => assert.strictEqual(keyInTitle('KAN-1', 'Fix KAN-14 bug'), false));
  test('no match: XKAN-1', () => assert.strictEqual(keyInTitle('KAN-1', 'Fix XKAN-1 bug'), false));
  test('boundary at start', () => assert.strictEqual(keyInTitle('KAN-1', 'KAN-1 fix'), true));
  test('standalone', () => assert.strictEqual(keyInTitle('KAN-1', 'KAN-1'), true));
  test('case-insensitive', () => { assert.strictEqual(keyInTitle('KAN-1', 'fix kan-1 bug'), true); assert.strictEqual(keyInTitle('kan-1', 'Fix KAN-1 bug'), true); });
});

// ==========================================================================
// determinePrStatus
// ==========================================================================

describe('determinePrStatus', () => {
  test('OPEN → awaiting_merge', () => {
    const r = determinePrStatus({ prState: 'OPEN', mergedAt: null, mergeCommit: null, ciStatus: 'green', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'awaiting_merge');
  });
  test('MERGED + green → closing', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: '2024-01-01T00:00:00Z', mergeCommit: 'abc', ciStatus: 'green', graceMinutes: 30 });
    assert.strictEqual(r.work, true); assert.strictEqual(r.reason, 'closing');
  });
  test('MERGED + failed → closing_ci_failed', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: '2024-01-01T00:00:00Z', mergeCommit: 'abc', ciStatus: 'failed', graceMinutes: 30 });
    assert.strictEqual(r.work, true); assert.strictEqual(r.reason, 'closing_ci_failed');
  });
  test('MERGED + pending within grace → closing_ci_pending', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: new Date(Date.now() - 5 * 60000).toISOString(), mergeCommit: 'abc', ciStatus: 'pending', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'closing_ci_pending');
  });
  test('MERGED + pending beyond grace → closing_ci_stuck', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: new Date(Date.now() - 60 * 60000).toISOString(), mergeCommit: 'abc', ciStatus: 'pending', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'closing_ci_stuck');
  });
  test('CLOSED → pr_unclear', () => {
    const r = determinePrStatus({ prState: 'CLOSED', mergedAt: null, mergeCommit: null, ciStatus: 'green', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'pr_unclear');
  });
  test('MERGED without mergedAt → no work', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: null, mergeCommit: 'abc', ciStatus: 'green', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'none');
  });
  test('MERGED without mergeCommit → no work', () => {
    const r = determinePrStatus({ prState: 'MERGED', mergedAt: '2024-01-01T00:00:00Z', mergeCommit: null, ciStatus: 'green', graceMinutes: 30 });
    assert.strictEqual(r.work, false); assert.strictEqual(r.reason, 'none');
  });
});

// ==========================================================================
// State file helpers
// ==========================================================================

describe('state file helpers', () => {
  test('read returns null for missing file', () => {
    const d = mkTempDir('st-null');
    assert.strictEqual(readPickupState({ COORDINATOR_STATE_DIR: d }), null);
    cleanup(d);
  });

  test('addStoredFailure writes record', () => {
    const d = mkTempDir('st-add');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    const s = readPickupState({ COORDINATOR_STATE_DIR: d });
    assert.strictEqual(s.records.length, 1);
    assert.strictEqual(s.records[0].pr, 42);
    assert.strictEqual(s.records[0].mergeSha, 'abc123');
    assert.strictEqual(s.records[0].ciRun, 'ci-1');
    cleanup(d);
  });

  test('idempotent', () => {
    const d = mkTempDir('st-idem');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    assert.strictEqual(readPickupState({ COORDINATOR_STATE_DIR: d }).records.length, 1);
    cleanup(d);
  });

  test('find matching', () => {
    const d = mkTempDir('st-find');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    assert.ok(findStoredFailure(readPickupState({ COORDINATOR_STATE_DIR: d }), 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1'));
    cleanup(d);
  });

  test('find non-matching → null', () => {
    const d = mkTempDir('st-nm');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    assert.strictEqual(findStoredFailure(readPickupState({ COORDINATOR_STATE_DIR: d }), 'Riniro/test', 'KAN-1', 99, 'abc123', 'ci-1'), null);
    cleanup(d);
  });

  test('remove by issue key', () => {
    const d = mkTempDir('st-rm');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-2', 43, 'def456', 'ci-2');
    removeStoredFailuresForIssue({ COORDINATOR_STATE_DIR: d }, 'KAN-1');
    assert.strictEqual(readPickupState({ COORDINATOR_STATE_DIR: d }).records.length, 1);
    cleanup(d);
  });

  test('corrupt file → null', () => {
    const d = mkTempDir('st-cor');
    fs.writeFileSync(path.join(d, 'pickup-state.json'), '{ bad', 'utf8');
    assert.strictEqual(readPickupState({ COORDINATOR_STATE_DIR: d }), null);
    cleanup(d);
  });

  test('change any of pr/mergeSha/ciRun → different', () => {
    const d = mkTempDir('st-ch');
    addStoredFailure({ COORDINATOR_STATE_DIR: d }, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-1');
    const st = readPickupState({ COORDINATOR_STATE_DIR: d });
    assert.strictEqual(findStoredFailure(st, 'Riniro/test', 'KAN-1', 99, 'abc123', 'ci-1'), null);
    assert.strictEqual(findStoredFailure(st, 'Riniro/test', 'KAN-1', 42, 'xyz', 'ci-1'), null);
    assert.strictEqual(findStoredFailure(st, 'Riniro/test', 'KAN-1', 42, 'abc123', 'ci-99'), null);
    cleanup(d);
  });
});

// ==========================================================================
// CLI process tests — pickup.js as real process with HTTP server + gh stub
// ==========================================================================

describe('CLI process tests', () => {
  let closeJira;
  let stateDir;

  after(async () => {
    if (closeJira) await closeJira();
    cleanup(stateDir);
  });

  /** Run pickup.js as a child process against a live HTTP server. */
  async function runPickupCli(ghStubPath, jiraHandler, extraArgs = [], graceMinutes = 30) {
    const jiraDir = mkTempDir('pick-j');
    const sd = mkTempDir('pick-s');
    const { server: srv, close: cs } = await startServer(jiraHandler);
    const port = srv.address().port;
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      // ghStubPath is a .js file; prefix with node to execute it
      PICKUP_GH_EXEC: ghStubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    const args = ['--project', 'KAN', '--repo', 'Riniro/test', ...extraArgs];
    const result = await runSpawn(CLI, args, env, 10000);
    await cs();
    cleanup(jiraDir);
    cleanup(sd);
    return result;
  }

  // ------------------------------------------------------------------------
  // Test 1: Only open PR, waiting for merge — code 3, awaiting_merge
  // ------------------------------------------------------------------------
  test('open PR → code 3, awaiting_merge', async () => {
    const ghStubDir = mkTempDir('pick-gh');
    const stubPath = path.join(ghStubDir, 'gh.js');
    // Stubs read process.argv (the CLI args), not stdin (which is 'ignore')
    // searchPrsByKey expects JSON array on stdout; fetchPrView expects JSON object
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":null,"mergeCommit":null}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":null,"mergeCommit":null})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify([])+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        // No ready issues — only awaiting-merge
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });

    assert.strictEqual(result.status, 3);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.work, false);
    assert.strictEqual(out.reason, 'awaiting_merge');
    assert.strictEqual(out.issue, null);
    cleanup(ghStubDir);
  });

  // ------------------------------------------------------------------------
  // Test 2: Open PR + ai-ready issue — code 0, ready
  // Open PR doesn't block new work.
  // ------------------------------------------------------------------------
  test('open PR plus ai-ready → code 0, ready', async () => {
    const ghStubDir = mkTempDir('pick-gh2');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":null,"mergeCommit":null}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":null,"mergeCommit":null})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify([])+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-20', fields: { summary: 'New feature', labels: ['project-test', 'ai-ready'] } }],
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });

    assert.strictEqual(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.work, true);
    assert.strictEqual(out.reason, 'ready');
    assert.ok(out.issue);
    assert.strictEqual(out.issue.key, 'KAN-20');
    assert.strictEqual(out.pr, null);
    cleanup(ghStubDir);
  });

  // ------------------------------------------------------------------------
  // Test 3: Confirmed merge with green push-CI — code 0, closing
  // ------------------------------------------------------------------------
  test('merge + green CI → code 0, closing', async () => {
    const ghStubDir = mkTempDir('pick-gh3');
    const stubPath = path.join(ghStubDir, 'gh.js');
    // searchPrsByKey → pr list (expect array); fetchPrView → pr view (expect object); fetchCheckRuns → api check-runs (expect array)
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":"abc123"}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"full_name":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":"abc123"})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify([{"status":"completed","conclusion":"success"}])+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
      }));
    });

    assert.strictEqual(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.work, true);
    assert.strictEqual(out.reason, 'closing');
    assert.ok(out.pr);
    assert.strictEqual(out.pr.number, 42);
    assert.strictEqual(out.pr.mergeCommit, 'abc123');
    cleanup(ghStubDir);
  });

  // ------------------------------------------------------------------------
  // Test 4: Source unavailable — code 4, unavailable
  // ------------------------------------------------------------------------
  test('unavailable source → code 4, unavailable', async () => {
    const ghStubDir = mkTempDir('pick-gh4');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, 'process.exit(0);');

    // No Jira server — credentials point to a closed port
    const jiraDir = mkTempDir('pick-j4');
    const sd = mkTempDir('pick-s4');
    const credPath = writeCredsFile(jiraDir, 'http://127.0.0.1:1');
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: '[]',
    };

    const result = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.reason, 'unavailable');
    assert.ok(out.counts);
    assert.strictEqual(out.counts.awaitingMerge, null);
    assert.strictEqual(out.counts.ready, null);

    cleanup(jiraDir);
    cleanup(sd);
    cleanup(ghStubDir);
  });

  // ------------------------------------------------------------------------
  // Verify code 3 vs code 4 are different
  // ------------------------------------------------------------------------
  test('code 3 (none) and code 4 (unavailable) are distinct', async () => {
    // Code 3: empty Jira queue (nothing to find)
    const ghStubDir3 = mkTempDir('pick-gh3');
    const stubPath3 = path.join(ghStubDir3, 'gh.js');
    fs.writeFileSync(stubPath3, 'process.exit(0);');
    const jiraDir3 = mkTempDir('pick-j3');
    const sd3 = mkTempDir('pick-s3');
    const credPath3 = writeCredsFile(jiraDir3, `http://127.0.0.1:${((await startServer(() => {})).port || 99999)}`);

    const { server: srv3, close: cs3 } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    const port3 = srv3.address().port;
    const credPath3b = writeCredsFile(jiraDir3, `http://127.0.0.1:${port3}`);

    const env3 = { ...process.env, JIRA_CREDENTIALS_FILE: credPath3b, COORDINATOR_STATE_DIR: sd3, PICKUP_GH_EXEC: stubPath3, PICKUP_GH_PREFIX_ARGS_JSON: '[]' };
    const r3 = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env3, 10000);
    await cs3();
    assert.strictEqual(r3.status, 3);
    cleanup(jiraDir3);
    cleanup(sd3);
    cleanup(ghStubDir3);
  });
});
