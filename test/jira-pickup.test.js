import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { spawn, exec } from 'node:child_process';
import util from 'node:util';
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

// No fixture in this file models an ai-in-review issue, and a real Jira returns
// none for a label nobody carries. Answer that query explicitly so the catch-all
// branch of a stub cannot hand back the awaiting-merge issue instead.
function noInReviewFixture(req, res) {
  if (!(req.url || '').includes('ai-in-review')) return false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ issues: [] }));
  return true;
}

function writeCredsFile(dir, site) {
  const p = path.join(dir, 'jira-creds.json');
  fs.writeFileSync(p, JSON.stringify({ site, email: 'test@example.com', token: 'tok-123' }), 'utf8');
  return p;
}

function runSpawn(scriptPath, args, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const cmd = `"${process.execPath}" "${scriptPath}"${args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : ''}`;
    const ch = exec(cmd, { cwd: REPO_ROOT, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const status = err ? err.code : 0;
      resolve({ status, stdout: stdout || '', stderr: stderr || '' });
    });
    ch.on('error', () => resolve({ status: null, stdout: '', stderr: 'spawn error' }));
  });
}

// ==========================================================================
// parseCheckRuns
// ==========================================================================

describe('parseCheckRuns', () => {
  // Green is the claim.js definition: EVERY required check present, completed and successful.
  const U = (o = {}) => ({ name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', ...o });
  const W = (o = {}) => ({ name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success', ...o });
  test('empty → pending', () => assert.strictEqual(parseCheckRuns([]), 'pending'));
  test('queued required check → pending', () => assert.strictEqual(parseCheckRuns([U(), W({ status: 'queued', conclusion: null })]), 'pending'));
  test('in_progress required check → pending', () => assert.strictEqual(parseCheckRuns([U(), W({ status: 'in_progress', conclusion: null })]), 'pending'));
  test('all required completed success → green', () => assert.strictEqual(parseCheckRuns([U(), W()]), 'green'));
  test('one successful required check of two → pending, not green', () => assert.strictEqual(parseCheckRuns([U()]), 'pending'));
  test('required completed failure → failed', () => assert.strictEqual(parseCheckRuns([U(), W({ conclusion: 'failure' })]), 'failed'));
  test('timed_out → failed', () => assert.strictEqual(parseCheckRuns([U(), W({ conclusion: 'timed_out' })]), 'failed'));
  test('cancelled → failed', () => assert.strictEqual(parseCheckRuns([U(), W({ conclusion: 'cancelled' })]), 'failed'));
  test('a skipped required check is not green', () => assert.strictEqual(parseCheckRuns([U(), W({ conclusion: 'skipped' })]), 'failed'));
  test('one success and one queued → pending ("some success and no failure" is not green)', () => assert.strictEqual(parseCheckRuns([U(), W({ status: 'queued', conclusion: null })]), 'pending'));
  test('success + failure → failed', () => assert.strictEqual(parseCheckRuns([U(), W({ conclusion: 'failure' })]), 'failed'));
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
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":null,"mergeCommit":null}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":null,"mergeCommit":null})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] })+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      if (noInReviewFixture(req, res)) return;
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
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":null,"mergeCommit":null}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"OPEN","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":null,"mergeCommit":null})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] })+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      if (noInReviewFixture(req, res)) return;
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
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 2, check_runs: [{"name":"Tests (ubuntu-latest)","status":"completed","conclusion":"success"},{"name":"Tests (windows-latest)","status":"completed","conclusion":"success"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const result = await runPickupCli(stubPath, (req, res) => {
      if (noInReviewFixture(req, res)) return;
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

    const { server: srv3, close: cs3 } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    const port3 = srv3.address().port;
    const credPath3 = writeCredsFile(jiraDir3, `http://127.0.0.1:${port3}`);
    const env3 = { ...process.env, JIRA_CREDENTIALS_FILE: credPath3, COORDINATOR_STATE_DIR: sd3, PICKUP_GH_EXEC: stubPath3, PICKUP_GH_PREFIX_ARGS_JSON: '[]' };
    let r3;
    try {
      r3 = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env3, 10000);
      await cs3();
      assert.strictEqual(r3.status, 3);
      const o3 = JSON.parse(r3.stdout);
      assert.strictEqual(o3.reason, 'none');
    } finally {
      cleanup(jiraDir3);
      cleanup(sd3);
      cleanup(ghStubDir3);
    }

    // Code 4: source unavailable (closed port)
    const ghStubDir4 = mkTempDir('pick-gh4');
    const stubPath4 = path.join(ghStubDir4, 'gh.js');
    fs.writeFileSync(stubPath4, 'process.exit(0);');
    const jiraDir4 = mkTempDir('pick-j4');
    const sd4 = mkTempDir('pick-s4');
    const credPath4 = writeCredsFile(jiraDir4, 'http://127.0.0.1:1');
    const env4 = { ...process.env, JIRA_CREDENTIALS_FILE: credPath4, COORDINATOR_STATE_DIR: sd4, PICKUP_GH_EXEC: stubPath4, PICKUP_GH_PREFIX_ARGS_JSON: '[]' };
    let r4;
    try {
      r4 = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env4, 10000);
      assert.strictEqual(r4.status, 4);
      const o4 = JSON.parse(r4.stdout);
      assert.strictEqual(o4.reason, 'unavailable');
    } finally {
      cleanup(jiraDir4);
      cleanup(sd4);
      cleanup(ghStubDir4);
    }

    // Verify they are distinct
    assert.notStrictEqual(r3.status, r4.status);
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 2: missing --repo
  // ------------------------------------------------------------------------
  test('exit code 2 — missing --repo', async () => {
    const jiraDir = mkTempDir('pick-j2a');
    const sd = mkTempDir('pick-s2a');
    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    const port = srv.address().port;
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_PREFIX_ARGS_JSON: '[]',
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN'], env, 10000);
      assert.strictEqual(r.status, 2);
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 3, reason 'none': both Jira queues empty
  // ------------------------------------------------------------------------
  test('exit code 3 — reason none, both queues empty', async () => {
    const ghStubDir = mkTempDir('pick-gh-n');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, 'process.exit(0);');

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-jn');
    const sd = mkTempDir('pick-sn');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: '[]',
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'none');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 3, reason 'closing_ci_pending': fresh merge with in_progress CI
  // ------------------------------------------------------------------------
  test('merge fresh + CI in_progress → code 3, closing_ci_pending', async () => {
    const ghStubDir = mkTempDir('pick-ghp');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"'+ new Date(Date.now() - 5 * 60000).toISOString() +'","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"'+ new Date(Date.now() - 5 * 60000).toISOString() +'","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"status":"in_progress"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-jp');
    const sd = mkTempDir('pick-sp');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'closing_ci_pending');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 0, reason 'closing_ci_failed': merged PR, CI failure, no stored record
  // ------------------------------------------------------------------------
  test('merge + CI failure → code 0, closing_ci_failed', async () => {
    const ghStubDir = mkTempDir('pick-ghcf');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"name":"Tests (windows-latest)","status":"completed","conclusion":"failure"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
      }));
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-jcf');
    const sd = mkTempDir('pick-scf');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, true);
      assert.strictEqual(out.reason, 'closing_ci_failed');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 4, reason 'closing_ci_stuck': merged PR, CI in_progress, merge old
  // ------------------------------------------------------------------------
  test('merge stale + CI in_progress → code 4, closing_ci_stuck', async () => {
    const ghStubDir = mkTempDir('pick-ghstuck');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2020-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2020-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"status":"in_progress"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-jstuck');
    const sd = mkTempDir('pick-sstuck');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test', '--ci-grace-minutes', '30'], env, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'closing_ci_stuck');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 4, reason 'pr_unclear': two matching candidates
  // ------------------------------------------------------------------------
  test('pr_unclear — two candidates', async () => {
    const ghStubDir = mkTempDir('pick-ghuc');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}},{"number":43,"state":"MERGED","title":"[KAN-14] Another PR","url":"https://gh.test/Riniro/test/pull/43","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"def456"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] })+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-juc');
    const sd = mkTempDir('pick-suc');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'pr_unclear');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 4, reason 'pr_unclear': zero candidates
  // ------------------------------------------------------------------------
  test('pr_unclear — zero candidates', async () => {
    const ghStubDir = mkTempDir('pick-ghz');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] })+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const { server: srv, close: cs } = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      const url = req.url || '';
      if (url.includes('ai-ready')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
        }));
      }
    });
    const port = srv.address().port;
    const jiraDir = mkTempDir('pick-jz');
    const sd = mkTempDir('pick-sz');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      // zero candidates → nothing matched → reason is null → exit code 3 (none)
      assert.strictEqual(out.reason, 'none');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });

  // ------------------------------------------------------------------------
  // Missing exit-code 3, reason 'closing_ci_failed_handled': merged PR, CI
  // failure, mark-handled called as subprocess
  // ------------------------------------------------------------------------
  test('merge + CI failure + mark-handled → code 3, closing_ci_failed_handled', async () => {
    const tmpDir = mkTempDir('pick-ghh');

    // GH stub: same as closing_ci_failed but merged, stale merge, failure
    const stubPath = path.join(tmpDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"id":1001,"name":"Tests (windows-latest)","status":"completed","conclusion":"failure"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    // Create state dir for mark-handled + main pickup
    const stateDir = mkTempDir('pick-sh');
    const jiraDir = mkTempDir('pick-shj');

    // Phase 1: call mark-handled as subprocess
    const envMark = {
      ...process.env,
      COORDINATOR_STATE_DIR: stateDir,
    };
    const markResult = await runSpawn(CLI, [
      'mark-handled', '--repo', 'Riniro/test', '--issue', 'KAN-14',
      '--pr', '42', '--merge-sha', 'abc123', '--ci-run', '1001',
    ], envMark, 10000);
    assert.strictEqual(markResult.status, 0);
    const markOut = JSON.parse(markResult.stdout);
    assert.strictEqual(markOut.stored, true);

    try {
      // Phase 2: run pickup with GH stub + Jira mock
      const { server: srv, close: cs } = await startServer((req, res) => {
        if (noInReviewFixture(req, res)) return;
        const url = req.url || '';
        if (url.includes('ai-ready')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ issues: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
          }));
        }
      });
      const port = srv.address().port;
      const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
      const env = {
        ...process.env,
        JIRA_CREDENTIALS_FILE: credPath,
        COORDINATOR_STATE_DIR: stateDir,
        PICKUP_GH_EXEC: stubPath,
        PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      await cs();

      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'closing_ci_failed_handled');
    } finally {
      cleanup(tmpDir);
      cleanup(stateDir);
      cleanup(jiraDir);
    }
  });

  // ------------------------------------------------------------------------
  // Regression 1 — handled failure for one CI run must not suppress a different run
  // ------------------------------------------------------------------------
  test('handled failure 1001 must not suppress different run 1002', async () => {
    const tmpDir = mkTempDir('pick-r1');

    // Phase 1: mark 1001 as handled
    const stateDir = mkTempDir('pick-r1s');
    const envMark = { ...process.env, COORDINATOR_STATE_DIR: stateDir };
    const markResult = await runSpawn(CLI, [
      'mark-handled', '--repo', 'Riniro/test', '--issue', 'KAN-14',
      '--pr', '42', '--merge-sha', 'abc123', '--ci-run', '1001',
    ], envMark, 10000);
    assert.strictEqual(markResult.status, 0);
    const markOut = JSON.parse(markResult.stdout);
    assert.strictEqual(markOut.stored, true);

    let jiraDir1 = null;
    let jiraDir2 = null;

    try {
      // Phase 2a: same run 1001 fails → should be suppressed (existing behaviour)
      const stubPath1 = path.join(tmpDir, 'gh1.js');
      fs.writeFileSync(stubPath1, [
        'const a=process.argv.slice(2).join(" ");',
        'if (a.includes("pr list")) {',
        '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
        '} else if (a.includes("pr view")) {',
        '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
        '} else if (a.includes("check-runs")) {',
        '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"id":1001,"name":"Tests (windows-latest)","status":"completed","conclusion":"failure"}]})+ "\\n");',
        '} else {',
        '  process.stdout.write("[]"+ "\\n");',
        '}',
        'process.exit(0);',
      ].join('\n'));

      const { server: srv1, close: cs1 } = await startServer((req, res) => {
        if (noInReviewFixture(req, res)) return;
        const url = req.url || '';
        if (url.includes('ai-ready')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ issues: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
          }));
        }
      });
      const port1 = srv1.address().port;
      jiraDir1 = mkTempDir('pick-r1j');
      const credPath1 = writeCredsFile(jiraDir1, `http://127.0.0.1:${port1}`);
      const env1 = {
        ...process.env,
        JIRA_CREDENTIALS_FILE: credPath1,
        COORDINATOR_STATE_DIR: stateDir,
        PICKUP_GH_EXEC: stubPath1,
        PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      };
      const r1 = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env1, 10000);
      await cs1();
      assert.strictEqual(r1.status, 3);
      const out1 = JSON.parse(r1.stdout);
      assert.strictEqual(out1.reason, 'closing_ci_failed_handled');
      assert.strictEqual(out1.work, false);

      // Phase 2b: different run 1002 fails → should NOT be suppressed
      const stubPath2 = path.join(tmpDir, 'gh2.js');
      fs.writeFileSync(stubPath2, [
        'const a=process.argv.slice(2).join(" ");',
        'if (a.includes("pr list")) {',
        '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
        '} else if (a.includes("pr view")) {',
        '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
        '} else if (a.includes("check-runs")) {',
        '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"id":1002,"name":"Tests (windows-latest)","status":"completed","conclusion":"failure"}]})+ "\\n");',
        '} else {',
        '  process.stdout.write("[]"+ "\\n");',
        '}',
        'process.exit(0);',
      ].join('\n'));

      const { server: srv2, close: cs2 } = await startServer((req, res) => {
        if (noInReviewFixture(req, res)) return;
        const url = req.url || '';
        if (url.includes('ai-ready')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ issues: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
          }));
        }
      });
      const port2 = srv2.address().port;
      jiraDir2 = mkTempDir('pick-r1j2');
      const credPath2 = writeCredsFile(jiraDir2, `http://127.0.0.1:${port2}`);
      const env2 = {
        ...process.env,
        JIRA_CREDENTIALS_FILE: credPath2,
        COORDINATOR_STATE_DIR: stateDir,
        PICKUP_GH_EXEC: stubPath2,
        PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      };
      const r2 = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env2, 10000);
      await cs2();
      // This assertion will fail on current code: bug returns closing_ci_failed_handled
      assert.strictEqual(r2.status, 0);
      const out2 = JSON.parse(r2.stdout);
      assert.strictEqual(out2.reason, 'closing_ci_failed');
      assert.strictEqual(out2.work, true);
    } finally {
      cleanup(tmpDir);
      cleanup(stateDir);
      if (jiraDir1) cleanup(jiraDir1);
      if (jiraDir2) cleanup(jiraDir2);
    }
  });

  // ------------------------------------------------------------------------
  // Regression 2 — handled failure must not block picking ready work
  // ------------------------------------------------------------------------
  test('handled failure must not block ready pickup', async () => {
    const tmpDir = mkTempDir('pick-r2');

    // Phase 1: mark 1001 as handled
    const stateDir = mkTempDir('pick-r2s');
    const envMark = { ...process.env, COORDINATOR_STATE_DIR: stateDir };
    const markResult = await runSpawn(CLI, [
      'mark-handled', '--repo', 'Riniro/test', '--issue', 'KAN-14',
      '--pr', '42', '--merge-sha', 'abc123', '--ci-run', '1001',
    ], envMark, 10000);
    assert.strictEqual(markResult.status, 0);
    const markOut = JSON.parse(markResult.stdout);
    assert.strictEqual(markOut.stored, true);

    let jiraDir = null;

    try {
      // GH stub: merged PR with failed check run 1001 (already handled)
      const stubPath = path.join(tmpDir, 'gh.js');
      fs.writeFileSync(stubPath, [
        'const a=process.argv.slice(2).join(" ");',
        'if (a.includes("pr list")) {',
        '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
        '} else if (a.includes("pr view")) {',
        '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
        '} else if (a.includes("check-runs")) {',
        '  process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{"id":1001,"name":"Tests (windows-latest)","status":"completed","conclusion":"failure"}]})+ "\\n");',
        '} else {',
        '  process.stdout.write("[]"+ "\\n");',
        '}',
        'process.exit(0);',
      ].join('\n'));

      // Jira stub: ai-ready returns KAN-99, ai-awaiting-merge returns KAN-14
      const { server: srv, close: cs } = await startServer((req, res) => {
        if (noInReviewFixture(req, res)) return;
        const url = req.url || '';
        if (url.includes('ai-ready')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            issues: [{ key: 'KAN-99', fields: { summary: 'Ready task', labels: ['project-test', 'ai-ready'] } }],
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } }],
          }));
        }
      });
      const port = srv.address().port;
      jiraDir = mkTempDir('pick-r2j');
      const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
      const env = {
        ...process.env,
        JIRA_CREDENTIALS_FILE: credPath,
        COORDINATOR_STATE_DIR: stateDir,
        PICKUP_GH_EXEC: stubPath,
        PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      await cs();
      // This assertion will fail on current code: bug returns closing_ci_failed_handled with work=false
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, true);
      assert.strictEqual(out.reason, 'ready');
      assert.ok(out.issue);
      assert.strictEqual(out.issue.key, 'KAN-99');
    } finally {
      cleanup(tmpDir);
      cleanup(stateDir);
      if (jiraDir) cleanup(jiraDir);
    }
  });

  // ------------------------------------------------------------------------
  // Invariant: awaitingMerge > 0 ⇒ reason !== 'none'
  // ------------------------------------------------------------------------
  test('invariant awaitingMerge > 0 ⇒ reason is not none', async () => {
    // ai-ready issue exists, no awaiting-merge issues
    // This should set awaitingMerge to 0, ready to 1 — so reason = 'ready'
    // To test the invariant properly, we need awaitingMerge > 0 which means
    // an awaiting-merge issue exists. Let's have both awaiting-merge and ready.
    const ghStubDir = mkTempDir('pick-ghi');
    const stubPath = path.join(ghStubDir, 'gh.js');
    fs.writeFileSync(stubPath, [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":42,"state":"MERGED","title":"[KAN-14] Add pickup check","url":"https://gh.test/Riniro/test/pull/42","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2024-01-01T00:00:00Z","mergeCommit":{"oid":"abc123"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 2, check_runs: [{"name":"Tests (ubuntu-latest)","status":"completed","conclusion":"success"},{"name":"Tests (windows-latest)","status":"completed","conclusion":"success"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const srvObj = await startServer((req, res) => {
      if (noInReviewFixture(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issues: [
          { key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-awaiting-merge'] } },
          { key: 'KAN-20', fields: { summary: 'New feature', labels: ['project-test', 'ai-ready'] } },
        ],
      }));
    });
    const port = srvObj.port;
    const jiraDir = mkTempDir('pick-ji');
    const sd = mkTempDir('pick-si');
    const credPath = writeCredsFile(jiraDir, `http://127.0.0.1:${port}`);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      // When awaitingMerge > 0 and there's a closing item, we should get closing
      // not 'none'. The invariant is that awaitingMerge > 0 cannot produce 'none'.
      assert.notStrictEqual(out.reason, 'none');
    } finally {
      await srvObj.close();
      cleanup(jiraDir);
      cleanup(sd);
      cleanup(ghStubDir);
    }
  });
  // ------------------------------------------------------------------------
  // ai-in-review branch (reason: 'review') — contract: continuing started work
  // takes priority over picking up new work. gh is never needed on this branch.
  // ------------------------------------------------------------------------
  function noGhStub() {
    const d = mkTempDir('pick-gh-none');
    const stubPath = path.join(d, 'gh.js');
    fs.writeFileSync(stubPath, 'process.stdout.write("[]\\n");process.exit(0);');
    return { dir: d, stubPath };
  }

  test('ai-in-review issue → code 0, reason review, issue returned', async () => {
    const gh = noGhStub();
    try {
      const result = await runPickupCli(gh.stubPath, (req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('ai-in-review')) {
          res.end(JSON.stringify({ issues: [{ key: 'KAN-14', fields: { summary: 'Add pickup check', labels: ['project-test', 'ai-in-review'] } }] }));
        } else {
          res.end(JSON.stringify({ issues: [] }));
        }
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.work, true);
      assert.strictEqual(out.reason, 'review');
      assert.strictEqual(out.issue.key, 'KAN-14');
      assert.ok(out.issue.labels.includes('ai-in-review'));
      assert.strictEqual(out.pr, null);
      assert.strictEqual(out.counts.inReview, 1);
    } finally {
      cleanup(gh.dir);
    }
  });

  test('ai-in-review wins over ai-ready and ai-awaiting-merge', async () => {
    const gh = noGhStub();
    try {
      const result = await runPickupCli(gh.stubPath, (req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('ai-in-review')) {
          res.end(JSON.stringify({ issues: [{ key: 'KAN-14', fields: { summary: 'In review', labels: ['project-test', 'ai-in-review'] } }] }));
        } else if (url.includes('ai-ready')) {
          res.end(JSON.stringify({ issues: [{ key: 'KAN-20', fields: { summary: 'New', labels: ['project-test', 'ai-ready'] } }] }));
        } else {
          res.end(JSON.stringify({ issues: [{ key: 'KAN-9', fields: { summary: 'Waiting', labels: ['project-test', 'ai-awaiting-merge'] } }] }));
        }
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.reason, 'review');
      assert.strictEqual(out.issue.key, 'KAN-14', 'started work is continued, new work is not picked up');
      assert.strictEqual(out.counts.ready, 1);
      assert.strictEqual(out.counts.awaitingMerge, 1);
      assert.strictEqual(out.counts.inReview, 1);
    } finally {
      cleanup(gh.dir);
    }
  });

  test('ai-in-review query unauthorized → code 4, unavailable (not an empty queue)', async () => {
    const gh = noGhStub();
    try {
      const result = await runPickupCli(gh.stubPath, (req, res) => {
        const url = req.url || '';
        if (url.includes('ai-in-review')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
      });
      assert.strictEqual(result.status, 4);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.reason, 'unavailable');
      assert.strictEqual(out.counts.inReview, null);
    } finally {
      cleanup(gh.dir);
    }
  });
});

// ==========================================================================
// Fix round 2 — «Матрица очереди (pickup.js)»: priority is the action available
// NOW (close → continue review → new work), and an issue with nothing to do
// is skipped without stopping the queue.
// ==========================================================================

describe('queue priority matrix', () => {
  const MERGED = (key, n) => ({
    number: n, state: 'MERGED', title: '[' + key + '] work', url: 'https://gh.test/Riniro/test/pull/' + n,
    baseRefName: 'master', headRepository: { nameWithOwner: 'Riniro/test' },
    mergedAt: '2024-01-01T00:00:00Z', mergeCommit: { oid: 'm' + n },
  });
  const OPEN = (key, n) => ({ ...MERGED(key, n), state: 'OPEN', mergedAt: null, mergeCommit: null });
  const issue = (key, ...labels) => ({ key, fields: { summary: key + ' summary', labels: ['project-test', ...labels] } });

  /**
   * @param {{ awaiting?: object[], inReview?: object[], ready?: object[], prs?: Record<string, object[]> }} cfg
   */
  async function run(cfg) {
    const dir = mkTempDir('pick-q');
    const stub = path.join(dir, 'gh.js');
    const cfgPath = path.join(dir, 'cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg.prs || {}));
    fs.writeFileSync(stub, [
      'const fs = require("fs");',
      'const a = process.argv.slice(2);',
      'const prs = JSON.parse(fs.readFileSync(process.env.PQ_CFG, "utf8"));',
      'if (a[0] === "pr" && a[1] === "list") {',
      '  const key = a[a.indexOf("--search") + 1];',
      '  process.stdout.write(JSON.stringify(prs[key] || []));',
      '} else if (a[0] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 2, check_runs: [{ name: "Tests (ubuntu-latest)", status: "completed", conclusion: "success" }, { name: "Tests (windows-latest)", status: "completed", conclusion: "success" }] }));',
      '} else {',
      '  process.stdout.write("[]");',
      '}',
      'process.exit(0);',
    ].join('\n'));
    const jiraDir = mkTempDir('pick-qj');
    const sd = mkTempDir('pick-qs');
    const { server: srv, close } = await startServer((req, res) => {
      const url = req.url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let issues = [];
      if (url.includes('ai-in-review')) issues = cfg.inReview || [];
      else if (url.includes('ai-awaiting-merge')) issues = cfg.awaiting || [];
      else if (url.includes('ai-ready')) issues = cfg.ready || [];
      res.end(JSON.stringify({ issues }));
    });
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stub,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      PQ_CFG: cfgPath,
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      return { status: r.status, out: JSON.parse(r.stdout) };
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  }

  test('merged PR and an ai-in-review issue → the closing one is issued first', async () => {
    const { status, out } = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      inReview: [issue('KAN-2', 'ai-in-review')],
      prs: { 'KAN-1': [MERGED('KAN-1', 11)] },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(out.work, true);
    assert.strictEqual(out.reason, 'closing');
    assert.strictEqual(out.issue.key, 'KAN-1');
  });

  test('merged PR and an ai-ready issue → the closing one is issued first', async () => {
    const { status, out } = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      ready: [issue('KAN-3', 'ai-ready')],
      prs: { 'KAN-1': [MERGED('KAN-1', 11)] },
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(out.reason, 'closing');
    assert.strictEqual(out.issue.key, 'KAN-1');
  });

  test('ai-in-review issue and an ai-ready issue → continuing the review is issued first', async () => {
    const { status, out } = await run({
      inReview: [issue('KAN-2', 'ai-in-review')],
      ready: [issue('KAN-3', 'ai-ready')],
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(out.reason, 'review');
    assert.strictEqual(out.issue.key, 'KAN-2');
  });

  test('sole issue is an open PR with confirmed readiness → skipped, the queue is not stopped (code 3, not 4)', async () => {
    const { status, out } = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      prs: { 'KAN-1': [OPEN('KAN-1', 11)] },
    });
    assert.strictEqual(status, 3);
    assert.strictEqual(out.work, false);
    assert.strictEqual(out.reason, 'awaiting_merge');
    assert.strictEqual(out.issue, null);
  });

  test('issue with nothing to do first, available work after it → the available work is issued', async () => {
    // KAN-1 is an open PR waiting for a human: nothing to do. KAN-4 follows it with a merged PR.
    const closing = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge'), issue('KAN-4', 'ai-awaiting-merge')],
      prs: { 'KAN-1': [OPEN('KAN-1', 11)], 'KAN-4': [MERGED('KAN-4', 14)] },
    });
    assert.strictEqual(closing.status, 0);
    assert.strictEqual(closing.out.reason, 'closing');
    assert.strictEqual(closing.out.issue.key, 'KAN-4');

    // The same waiting issue does not hide a review in progress…
    const review = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      inReview: [issue('KAN-2', 'ai-in-review')],
      prs: { 'KAN-1': [OPEN('KAN-1', 11)] },
    });
    assert.strictEqual(review.status, 0);
    assert.strictEqual(review.out.reason, 'review');
    assert.strictEqual(review.out.issue.key, 'KAN-2');

    // …nor new work.
    const ready = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      ready: [issue('KAN-3', 'ai-ready')],
      prs: { 'KAN-1': [OPEN('KAN-1', 11)] },
    });
    assert.strictEqual(ready.status, 0);
    assert.strictEqual(ready.out.reason, 'ready');
    assert.strictEqual(ready.out.issue.key, 'KAN-3');
  });
});

describe('queue priority — gh unavailable', () => {
  test('awaiting-merge issue cannot be evaluated (gh down) and a review exists → unavailable, not a lower-priority issue', async () => {
    const dir = mkTempDir('pick-qg');
    const stub = path.join(dir, 'gh.js');
    fs.writeFileSync(stub, 'process.exit(1);');
    const jiraDir = mkTempDir('pick-qgj');
    const sd = mkTempDir('pick-qgs');
    const { server: srv, close } = await startServer((req, res) => {
      const url = req.url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const mk = (k, l) => ({ key: k, fields: { summary: k, labels: ['project-test', l] } });
      let issues = [];
      if (url.includes('ai-in-review')) issues = [mk('KAN-2', 'ai-in-review')];
      else if (url.includes('ai-awaiting-merge')) issues = [mk('KAN-1', 'ai-awaiting-merge')];
      res.end(JSON.stringify({ issues }));
    });
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stub,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      assert.strictEqual(r.status, 4);
      assert.strictEqual(JSON.parse(r.stdout).reason, 'unavailable');
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  });
});

// ==========================================================================
// Round 3 — mandatory sources, ambiguous PR, required checks, --repo binding
// ==========================================================================

describe('pickup round 3', () => {
  const UBUNTU = { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' };
  const WINDOWS = { name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' };
  const GREEN = [UBUNTU, WINDOWS];
  const MERGED = (key, n) => ({
    number: n, state: 'MERGED', title: '[' + key + '] work', url: 'https://gh.test/Riniro/test/pull/' + n,
    baseRefName: 'master', headRepository: { nameWithOwner: 'Riniro/test' },
    mergedAt: new Date(Date.now() - 5 * 60000).toISOString(), mergeCommit: { oid: 'm' + n },
  });
  const OPEN = (key, n) => ({ ...MERGED(key, n), state: 'OPEN', mergedAt: null, mergeCommit: null });
  const issue = (key, ...labels) => ({ key, fields: { summary: key + ' summary', labels: ['project-test', ...labels] } });

  // Configurable gh stub. cfg: list ({KEY: array|raw string}), listFail, view ({n: object|raw}), viewFail,
  // api ({ runs, raw, fail }), prLinks (stored issue→PR association). Every call is logged.
  const STUB = [
    'const fs = require("fs");',
    'const a = process.argv.slice(2);',
    'fs.appendFileSync(process.env.PQ_LOG, JSON.stringify(a) + "\\n");',
    'const cfg = JSON.parse(fs.readFileSync(process.env.PQ_CFG, "utf8"));',
    'const out = (x) => { process.stdout.write(typeof x === "string" ? x : JSON.stringify(x)); process.exit(0); };',
    'if (a[0] === "pr" && a[1] === "list") {',
    '  if (cfg.listFail) process.exit(1);',
    '  const v = (cfg.list || {})[a[a.indexOf("--search") + 1]];',
    '  out(v === undefined ? [] : v);',
    '}',
    'if (a[0] === "pr" && a[1] === "view") {',
    '  if (cfg.viewFail) process.exit(1);',
    '  const v = (cfg.view || {})[a[2]];',
    '  if (v === undefined) process.exit(1);',
    '  out(v);',
    '}',
    'if (a[0] === "api") {',
    '  const api = cfg.api || {};',
    '  if (api.fail) process.exit(1);',
    '  if (api.raw !== undefined) out(api.raw);',
    '  var page = 1;',
    '  a.forEach(function (x) { var m = /^page=(\\d+)$/.exec(x); if (m) page = Number(m[1]); });',
    '  if (api.pages && api.pages[page - 1] !== undefined) out(api.pages[page - 1]);',
    '  out({ total_count: (api.runs || []).length, check_runs: api.runs || [] });',
    '}',
    'process.exit(1);',
  ].join('\n');

  async function run(cfg, extraEnv = {}) {
    const dir = mkTempDir('pick-r3');
    const stub = path.join(dir, 'gh.js');
    const cfgPath = path.join(dir, 'cfg.json');
    const logPath = path.join(dir, 'log.jsonl');
    fs.writeFileSync(stub, STUB);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    fs.writeFileSync(logPath, '');
    const jiraDir = mkTempDir('pick-r3j');
    const sd = mkTempDir('pick-r3s');
    if (cfg.prLinks) fs.writeFileSync(path.join(sd, 'pickup-state.json'), JSON.stringify({ version: 1, records: [], prLinks: cfg.prLinks }));
    const jiraCalls = [];
    const { server: srv, close } = await startServer((req, res) => {
      jiraCalls.push(req.method + ' ' + (req.url || '').split('?')[0]);
      const url = req.url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let issues = [];
      if (url.includes('ai-in-review')) issues = cfg.inReview || [];
      else if (url.includes('ai-awaiting-merge')) issues = cfg.awaiting || [];
      else if (url.includes('ai-ready')) issues = cfg.ready || [];
      res.end(JSON.stringify({ issues }));
    });
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stub,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
      PQ_CFG: cfgPath,
      PQ_LOG: logPath,
    };
    delete env.CLAIM_REQUIRED_CHECKS;
    Object.assign(env, extraEnv);
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not json */ }
      const gh = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { status: r.status, out, gh, jiraCalls };
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  }

  const unavailable = (r) => {
    assert.strictEqual(r.status, 4);
    assert.strictEqual(r.out.reason, 'unavailable');
    assert.strictEqual(r.out.work, false);
  };

  // ---- R1 — check-runs is a mandatory source ----------------------------------------------------

  const withNeighbours = {
    awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
    inReview: [issue('KAN-2', 'ai-in-review')],
    ready: [issue('KAN-3', 'ai-ready')],
    list: { 'KAN-1': [MERGED('KAN-1', 11)] },
  };

  test('R1: merged PR, gh api exits 1, review and ready alongside → code 4 unavailable', async () => {
    unavailable(await run({ ...withNeighbours, api: { fail: true } }));
  });

  test('R1: merged PR, gh api prints <html> with code 0 → code 4 unavailable', async () => {
    unavailable(await run({ ...withNeighbours, api: { raw: '<html>oops</html>' } }));
  });

  test('R1: merged PR, gh api prints an empty body with code 0 → code 4 unavailable', async () => {
    unavailable(await run({ ...withNeighbours, api: { raw: '' } }));
  });

  test('R1: control — healthy gh api, all required green → closing', async () => {
    const r = await run({ ...withNeighbours, api: { runs: GREEN } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.reason, 'closing');
    assert.strictEqual(r.out.issue.key, 'KAN-1');
  });

  // ---- R2 — pr view / pr list are mandatory sources ---------------------------------------------

  test('R2: stored association, gh pr view exits 1, review alongside → code 4 unavailable', async () => {
    unavailable(await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')], inReview: [issue('KAN-2', 'ai-in-review')],
      prLinks: [{ issueKey: 'KAN-1', prNumber: 11 }], viewFail: true,
    }));
  });

  test('R2: stored association, gh pr view unreadable body (code 0) → code 4 unavailable', async () => {
    unavailable(await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')], ready: [issue('KAN-3', 'ai-ready')],
      prLinks: [{ issueKey: 'KAN-1', prNumber: 11 }], view: { 11: '<html></html>' },
    }));
  });

  test('R2: gh pr list prints <html> with code 0, review alongside → code 4 unavailable', async () => {
    unavailable(await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')], inReview: [issue('KAN-2', 'ai-in-review')],
      list: { 'KAN-1': '<html>oops</html>' },
    }));
  });

  test('R2: gh pr list prints an empty body or a non-list with code 0 → code 4 unavailable', async () => {
    for (const raw of ['', '{}', 'null']) {
      unavailable(await run({
        awaiting: [issue('KAN-1', 'ai-awaiting-merge')], ready: [issue('KAN-3', 'ai-ready')],
        list: { 'KAN-1': raw },
      }));
    }
  });

  test('R2: control — a proper empty list means "no PR": the ready issue is issued', async () => {
    const r = await run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], ready: [issue('KAN-3', 'ai-ready')], list: { 'KAN-1': [] } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.reason, 'ready');
  });

  // ---- R3 — an ambiguous PR is its own diagnostic outcome ---------------------------------------

  test('R3: two candidate PRs, review alongside → code 4 pr_unclear, no review', async () => {
    const r = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')], inReview: [issue('KAN-2', 'ai-in-review')],
      list: { 'KAN-1': [OPEN('KAN-1', 11), OPEN('KAN-1', 12)] },
    });
    assert.strictEqual(r.status, 4);
    assert.strictEqual(r.out.reason, 'pr_unclear');
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.issue.key, 'KAN-1');
  });

  test('R3: two candidate PRs, ready alongside → code 4 pr_unclear, no ready', async () => {
    const r = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')], ready: [issue('KAN-3', 'ai-ready')],
      list: { 'KAN-1': [OPEN('KAN-1', 11), MERGED('KAN-1', 12)] },
    });
    assert.strictEqual(r.status, 4);
    assert.strictEqual(r.out.reason, 'pr_unclear');
    assert.strictEqual(r.out.work, false);
  });

  // ---- R6 — closing needs EVERY required check ---------------------------------------------------

  const closingWith = (runs, extraEnv) => run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], list: { 'KAN-1': [MERGED('KAN-1', 11)] }, api: { runs } }, extraEnv);

  test('R6: a required check is missing → closing is not allowed', async () => {
    const r = await closingWith([UBUNTU]);
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.reason, 'closing_ci_pending');
    assert.strictEqual(r.status, 3);
  });

  test('R6: a required check is in_progress → closing is not allowed', async () => {
    const r = await closingWith([UBUNTU, { ...WINDOWS, status: 'in_progress', conclusion: null }]);
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.reason, 'closing_ci_pending');
  });

  test('R6: a required check is queued → closing is not allowed', async () => {
    const r = await closingWith([UBUNTU, { ...WINDOWS, status: 'queued', conclusion: null }]);
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.reason, 'closing_ci_pending');
  });

  test('R6: a required check failed → the handled-failure path (closing_ci_failed, work)', async () => {
    const r = await closingWith([UBUNTU, { ...WINDOWS, id: 77, conclusion: 'failure' }]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.work, true);
    assert.strictEqual(r.out.reason, 'closing_ci_failed');
  });

  test('R6: all required green → closing', async () => {
    const r = await closingWith(GREEN);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.reason, 'closing');
  });

  test('R6: one green optional check and no required ones → closing is not allowed', async () => {
    const r = await closingWith([{ name: 'lint', status: 'completed', conclusion: 'success' }]);
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.reason, 'closing_ci_pending');
  });

  test('R6: CLAIM_REQUIRED_CHECKS overrides the required set, same as claim.js', async () => {
    const lint = { name: 'lint', status: 'completed', conclusion: 'success' };
    const ok = await closingWith([lint], { CLAIM_REQUIRED_CHECKS: 'lint' });
    assert.strictEqual(ok.out.reason, 'closing');
    const missing = await closingWith([UBUNTU], { CLAIM_REQUIRED_CHECKS: 'lint' });
    assert.strictEqual(missing.out.work, false);
  });

  test('R6: parseCheckRuns maps required checks → green/pending/failed', () => {
    const req = ['a', 'b'];
    const ok = (n) => ({ name: n, status: 'completed', conclusion: 'success' });
    assert.strictEqual(parseCheckRuns([ok('a'), ok('b')], req), 'green');
    assert.strictEqual(parseCheckRuns([ok('a')], req), 'pending');
    assert.strictEqual(parseCheckRuns([ok('a'), { name: 'b', status: 'in_progress' }], req), 'pending');
    assert.strictEqual(parseCheckRuns([ok('a'), { name: 'b', status: 'completed', conclusion: 'failure' }], req), 'failed');
    assert.strictEqual(parseCheckRuns([ok('a'), { name: 'b', status: 'completed', conclusion: 'skipped' }], req), 'failed');
    assert.strictEqual(parseCheckRuns([ok('x')], req), 'pending');
    assert.strictEqual(parseCheckRuns([], req), 'pending');
    assert.strictEqual(parseCheckRuns(null, req), 'pending');
  });

  // ---- R6.1 — incomplete check-runs pagination must NOT allow closing ----------------------------------

  test('R6.1: incomplete answer (2 of 5, page 2 empty) → unavailable, not closing', async () => {
    const res = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      list: { 'KAN-1': [MERGED('KAN-1', 11)] },
      api: {
        pages: [
          { total_count: 5, check_runs: [UBUNTU, WINDOWS] },
          { total_count: 5, check_runs: [] },
        ],
      },
    });
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.reason, 'unavailable');
    assert.strictEqual(res.out.work, false);
  });

  test('R6.1: full green answer still allows closing', async () => {
    const res = await run({
      awaiting: [issue('KAN-1', 'ai-awaiting-merge')],
      list: { 'KAN-1': [MERGED('KAN-1', 11)] },
      api: {
        pages: [
          { total_count: 2, check_runs: [UBUNTU, WINDOWS] },
        ],
      },
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.work, true);
    assert.strictEqual(res.out.reason, 'closing');
  });

  // ---- R7 — --repo binds every gh call -----------------------------------------------------------

  test('R7: pr list is bound by --repo (key search path)', async () => {
    const r = await run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], list: { 'KAN-1': [OPEN('KAN-1', 11)] } });
    const lists = r.gh.filter((x) => x[0] === 'pr' && x[1] === 'list');
    assert.strictEqual(lists.length, 1);
    assert.strictEqual(lists[0][lists[0].indexOf('--repo') + 1], 'Riniro/test');
  });

  test('R7: pr view (stored association) is bound by --repo', async () => {
    const r = await run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], prLinks: [{ issueKey: 'KAN-1', prNumber: 11 }], view: { 11: OPEN('KAN-1', 11) } });
    const views = r.gh.filter((x) => x[0] === 'pr' && x[1] === 'view');
    assert.strictEqual(views.length, 1);
    assert.strictEqual(views[0][views[0].indexOf('--repo') + 1], 'Riniro/test');
  });

  test('R7: gh api carries repos/<repo>/ in the endpoint path', async () => {
    const r = await run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], list: { 'KAN-1': [MERGED('KAN-1', 11)] }, api: { runs: GREEN } });
    const apis = r.gh.filter((x) => x[0] === 'api');
    assert.ok(apis.length >= 1);
    for (const x of apis) assert.ok(x[1].startsWith('repos/Riniro/test/commits/m11/check-runs'), x[1]);
  });

  // ---- R8 — pickup never declares merge readiness -------------------------------------------------

  test('R8: open PR → work:false, no readiness claim in the output, no Jira writes', async () => {
    const r = await run({ awaiting: [issue('KAN-1', 'ai-awaiting-merge')], list: { 'KAN-1': [OPEN('KAN-1', 11)] } });
    assert.strictEqual(r.status, 3);
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.issue, null);
    assert.deepStrictEqual(Object.keys(r.out).sort(), ['counts', 'issue', 'pr', 'reason', 'work']);
    assert.deepStrictEqual(Object.keys(r.out.pr).sort(), ['mergeCommit', 'number', 'state', 'url']);
    assert.deepStrictEqual(Object.keys(r.out.counts).sort(), ['awaitingMerge', 'ready']);
    const text = JSON.stringify(r.out);
    assert.ok(!/ready_for_merge|readiness|confirmed|verdict|"ci"|accept/i.test(text), 'no readiness wording: ' + text);
    assert.deepStrictEqual(r.jiraCalls.filter((c) => !c.startsWith('GET ')), [], 'no Jira writes');
  });

  // ==========================================================================
  // KAN-18 — empty CLAIM_REQUIRED_CHECKS must NOT disable the CI gate
  // ==========================================================================

  describe('KAN-18: empty CLAIM_REQUIRED_CHECKS', () => {
    const EMPTY_VALUES = ['', '   ', ',', ' , , '];

    for (const val of EMPTY_VALUES) {
      test('empty CLAIM_REQUIRED_CHECKS ("' + val.replace(/"/g, '\\"') + '") → closing is not allowed', async () => {
        const r = await closingWith([], { CLAIM_REQUIRED_CHECKS: val });
        assert.notStrictEqual(r.out.reason, 'closing', 'empty CLAIM_REQUIRED_CHECKS must NOT produce closing');
        assert.ok(['closing_ci_pending', 'closing_ci_failed'].includes(r.out.reason),
          'expected ci_pending/ci_failed for empty required, got: ' + r.out.reason);
      });
    }

    // Control: a matching non-empty CLAIM_REQUIRED_CHECKS with all required present → closing IS allowed,
    // proving the variable reaches the product.
    test('control: matching non-empty CLAIM_REQUIRED_CHECKS + all present → closing', async () => {
      const r = await closingWith(GREEN, { CLAIM_REQUIRED_CHECKS: 'Tests (ubuntu-latest),Tests (windows-latest)' });
      assert.strictEqual(r.out.reason, 'closing');
    });
  });
});

// ==========================================================================
// R1 — a failed search with ANY code stops the queue (not a code whitelist)
// ==========================================================================

describe('search failure of any code is unavailable (R1)', () => {
  // Stub Jira: `failLabel` gets `failStatus`; others get `okIssues[label]` (or an empty list).
  // gh is a stub that records every call so "zero GitHub calls" is provable.
  async function runCase({ failLabel, failStatus, okIssues = {} }) {
    const dir = mkTempDir('pick-r1');
    const ghLog = path.join(dir, 'gh-calls.log');
    const stub = path.join(dir, 'gh.js');
    fs.writeFileSync(stub, `require('fs').appendFileSync(${JSON.stringify(ghLog)}, 'call\n'); process.stdout.write('[]');`);
    const jiraDir = mkTempDir('pick-r1j');
    const sd = mkTempDir('pick-r1s');
    const labels = ['ai-awaiting-merge', 'ai-ready', 'ai-in-review'];
    const { server: srv, close } = await startServer((req, res) => {
      const url = decodeURIComponent(req.url || '');
      const label = labels.find((l) => url.includes(l));
      if (label && label === failLabel) {
        res.writeHead(failStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errorMessages: ['x'] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const issues = (okIssues[label] || []).map((k) => ({ key: k, fields: { summary: k, labels: ['project-test', label] } }));
      res.end(JSON.stringify({ issues }));
    });
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stub,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      const ghCalls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length : 0;
      return { r, ghCalls };
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  }

  for (const [n, label] of [[1, 'ai-awaiting-merge'], [2, 'ai-ready'], [3, 'ai-in-review']]) {
    test(`R1.${n}: 404 on the ${label} search → exit 4 unavailable, zero GitHub calls`, async () => {
      const { r, ghCalls } = await runCase({ failLabel: label, failStatus: 404 });
      assert.strictEqual(r.status, 4, r.stdout + r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).reason, 'unavailable');
      assert.strictEqual(ghCalls, 0);
    });
  }

  for (const label of ['ai-awaiting-merge', 'ai-ready', 'ai-in-review']) {
    test(`R1.4: 500 on the ${label} search → exit 4 unavailable`, async () => {
      const { r } = await runCase({ failLabel: label, failStatus: 500 });
      assert.strictEqual(r.status, 4, r.stdout + r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).reason, 'unavailable');
    });
  }

  test('R1.5: successful empty lists on all three searches → exit 3 none', async () => {
    const { r } = await runCase({ failLabel: null });
    assert.strictEqual(r.status, 3, r.stdout + r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).reason, 'none');
  });

  test('R1.6: successful search with a ready issue → previous path (exit 0, the issue is picked)', async () => {
    const { r } = await runCase({ failLabel: null, okIssues: { 'ai-ready': ['KAN-7'] } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.work, true);
    assert.strictEqual(out.issue.key, 'KAN-7');
  });
});

// ==========================================================================
// KAN-14 regressions — real gh shapes must not bypass the filter
// ==========================================================================

describe('KAN-14 real-gh regression tests', () => {
  /**
   * Minimal run: one awaiting-merge issue, one merged PR in real-gh form,
   * check-runs stubbed.  All we need is the pickup path from the issue
   * through pr-list → pr-view → check-runs.
   */
  async function runKan14({ ghStub, jiraHandler }) {
    const dir = mkTempDir('pick-kan14');
    const stubPath = path.join(dir, 'gh.js');
    fs.writeFileSync(stubPath, ghStub);
    const jiraDir = mkTempDir('pick-kan14j');
    const sd = mkTempDir('pick-kan14s');
    const { server: srv, close } = await startServer(jiraHandler);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not json */ }
      return { status: r.status, out };
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  }

  /** Shared stub for merged PR: pr-list + pr-view return real-gh form. */
  const MERGED_STUB = [
    'const a=process.argv.slice(2).join(" ");',
    'if (a.includes("pr list")) {',
    '  process.stdout.write(JSON.stringify([{"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}}])+ "\\n");',
    '} else if (a.includes("pr view")) {',
    '  process.stdout.write(JSON.stringify({"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}})+ "\\n");',
    '} else if (a.includes("check-runs")) {',
    '  process.stdout.write(JSON.stringify({"total_count":2,"check_runs":[{"name":"Tests (ubuntu-latest)","status":"completed","conclusion":"success"},{"name":"Tests (windows-latest)","status":"completed","conclusion":"success"}]})+ "\\n");',
    '} else {',
    '  process.stdout.write("[]"+ "\\n");',
    '}',
    'process.exit(0);',
  ].join('\n');

  const JIRA_HANDLER = (req, res) => {
    if (req.url && req.url.includes('ai-in-review')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
      return;
    }
    if (req.url && req.url.includes('ai-ready')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issues: [{ key: 'KAN-16', fields: { summary: 'add a zero-duration formatDuration example', labels: ['project-test', 'ai-awaiting-merge'] } }],
    }));
  };

  // Regression 1: own-repo merged PR in real-gh form → reason "closing"
  test('R1: own-repo merged PR (real-gh form) → reason "closing"', async () => {
    const r = await runKan14({
      ghStub: MERGED_STUB,
      jiraHandler: JIRA_HANDLER,
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.work, true);
    assert.strictEqual(r.out.reason, 'closing');
    assert.strictEqual(r.out.issue.key, 'KAN-16');
  });

  // Regression 2: forked PR (different nameWithOwner) is rejected → no match for issue
  test('R2: forked PR (different nameWithOwner) is skipped → reason none', async () => {
    const forkedStub = [
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"fork-owner/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"fork-owner/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  process.stdout.write(JSON.stringify({ total_count: 2, check_runs: [{"name":"Tests (ubuntu-latest)","status":"completed","conclusion":"success"},{"name":"Tests (windows-latest)","status":"completed","conclusion":"success"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n');

    const r = await runKan14({
      ghStub: forkedStub,
      jiraHandler: JIRA_HANDLER,
    });
    // Forked PR is rejected → no match → no work
    assert.strictEqual(r.out.work, false);
    assert.strictEqual(r.out.reason, 'none');
  });

  // Regression 3: mergeCommit as object {oid} → check-runs called with the SHA string from oid
  test('R3: mergeCommit as object {oid} → check-runs called with oid value', async () => {
    const dir = mkTempDir('pick-kan14r3');
    const stubPath = path.join(dir, 'gh.js');
    // Capture shaCaptured by writing to a temp file (spawn doesn't inherit vars)
    const capturePath = path.join(dir, 'sha-capture.json');
    const stubWithCapture = [
      'const fs=require("fs");',
      'let shaCaptured=[];',
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{"oid":"ec6918dbbc300e9de4676823f6d17e99e778fe23"}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  shaCaptured.push(a);',
      '  fs.writeFileSync(' + JSON.stringify(capturePath) + ', JSON.stringify(shaCaptured));',
      '  process.stdout.write(JSON.stringify({ total_count: 2, check_runs: [{"name":"Tests (ubuntu-latest)","status":"completed","conclusion":"success"},{"name":"Tests (windows-latest)","status":"completed","conclusion":"success"}]})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n');
    fs.writeFileSync(stubPath, stubWithCapture);

    const jiraDir = mkTempDir('pick-kan14r3j');
    const sd = mkTempDir('pick-kan14r3s');
    const { server: srv, close } = await startServer(JIRA_HANDLER);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, true);
      assert.strictEqual(out.reason, 'closing');

      // Verify that check-runs was called with an argument containing the SHA
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.ok(captured.length >= 1, 'check-runs should have been called at least once');
      const arg = captured[0];
      // The SHA from oid should be in the arguments (as part of the check-runs request)
      assert.ok(arg.includes('ec6918dbbc300e9de4676823f6d17e99e778fe23'), 'SHA from mergeCommit.oid should appear in check-runs args: ' + arg);
      // The raw object {"oid":"..."} should NOT appear as a string arg
      assert.ok(!arg.includes('{"oid"'), 'raw object should not appear as string arg');
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  });

  // Regression 4: mergeCommit without oid → treated as no merge commit
  test('R4: mergeCommit as empty object {} → no check-runs call → reason none', async () => {
    const dir = mkTempDir('pick-kan14r4');
    const stubPath = path.join(dir, 'gh.js');
    const logPath = path.join(dir, 'check-runs.log');
    // Ensure the log file exists so fs.existsSync works even if nothing writes to it
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(stubPath, [
      'const fs=require("fs");',
      'const a=process.argv.slice(2).join(" ");',
      'if (a.includes("pr list")) {',
      '  process.stdout.write(JSON.stringify([{"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{}}])+ "\\n");',
      '} else if (a.includes("pr view")) {',
      '  process.stdout.write(JSON.stringify({"number":15,"state":"MERGED","title":"[KAN-16] add a zero-duration formatDuration example","url":"https://gh.test/Riniro/test/pull/15","baseRefName":"master","headRepository":{"nameWithOwner":"Riniro/test"},"mergedAt":"2026-11-25T01:09:30Z","mergeCommit":{}})+ "\\n");',
      '} else if (a.includes("check-runs")) {',
      '  fs.appendFileSync(' + JSON.stringify(logPath) + ', "called\\n");',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: []})+ "\\n");',
      '} else {',
      '  process.stdout.write("[]"+ "\\n");',
      '}',
      'process.exit(0);',
    ].join('\n'));

    const jiraDir = mkTempDir('pick-kan14r4j');
    const sd = mkTempDir('pick-kan14r4s');
    const { server: srv, close } = await startServer(JIRA_HANDLER);
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: writeCredsFile(jiraDir, 'http://127.0.0.1:' + srv.address().port),
      COORDINATOR_STATE_DIR: sd,
      PICKUP_GH_EXEC: stubPath,
      PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--repo', 'Riniro/test'], env, 15000);
      assert.strictEqual(r.status, 3); // reason none → exit 3
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.work, false);
      assert.strictEqual(out.reason, 'none');
      // No oid → no mergeSha → check-runs must NOT have been called
      assert.strictEqual(fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').trim().length, 0, 'check-runs must not be called when mergeCommit has no oid');
    } finally {
      await close();
      cleanup(jiraDir); cleanup(sd); cleanup(dir);
    }
  });
});
