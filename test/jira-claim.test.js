import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allRequiredChecksGreen } from '../tools/jira/claim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'jira', 'claim.js');

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
    const cmd = `"${process.execPath}" "${scriptPath}"${args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : ''}`;
    const ch = exec(cmd, { cwd: REPO_ROOT, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const status = err ? err.code : 0;
      resolve({ status, stdout: stdout || '', stderr: stderr || '' });
    });
    ch.on('error', () => resolve({ status: null, stdout: '', stderr: 'spawn error' }));
  });
}

function envForCli(tempDir, port, stubPath) {
  const credPath = writeCredsFile(tempDir, `http://127.0.0.1:${port}`);
  return {
    ...process.env,
    JIRA_CREDENTIALS_FILE: credPath,
    COORDINATOR_STATE_DIR: path.join(tempDir, 'state'),
    PICKUP_GH_EXEC: stubPath,
    PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
  };
}

// ==========================================================================
// HTTP helpers — drain POST body to avoid hanging
// ==========================================================================

function drainBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') { resolve(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { resolve(body); });
    req.on('error', () => { resolve(''); });
  });
}

// ==========================================================================
// CLI process tests — claim.js
// ==========================================================================

describe('claim.js CLI', () => {
  // ------------------------------------------------------------------------
  // Exit code 2 — usage error: missing args
  // ------------------------------------------------------------------------
  test('missing --project → code 2, usage', async () => {
    const gh = mkTempDir('claim-gh');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const jiraDir = mkTempDir('claim-j');
    const { server: srv, close: cs } = await startServer(() => {});
    const port = srv.address().port;
    const env = envForCli(jiraDir, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 2);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'usage');
    } finally {
      await cs();
      cleanup(jiraDir);
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 2 — issue not found (404)
  // ------------------------------------------------------------------------
  test('issue not found → code 2, not_found', async () => {
    const gh = mkTempDir('claim-j2');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 2);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'not_found');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 3 — no ai-ready label
  // ------------------------------------------------------------------------
  test('missing ai-ready → code 3, not_ready', async () => {
    const gh = mkTempDir('claim-j3');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test'] },
      }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'not_ready');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 4 — work exists (OPEN PR)
  // ------------------------------------------------------------------------
  test('open PR → code 4, work_exists', async () => {
    const gh = mkTempDir('claim-j4');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'process.stdout.write(JSON.stringify(data) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer((req, res) => {
      // Jira should NOT be called — work_exists checks PR before any Jira mutation
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
      }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ])};
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'work_exists');
      assert.ok(out.pr);
      assert.strictEqual(out.pr.number, 42);
      assert.strictEqual(out.pr.state, 'OPEN');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 4 — work exists (MERGED PR)
  // ------------------------------------------------------------------------
  test('merged PR → code 4, work_exists', async () => {
    const gh = mkTempDir('claim-j4b');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const prList = JSON.stringify([
      { number: 42, state: 'MERGED', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
    ]);
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write(process.env.CLAIM_PR_LIST || "[]" + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        // Verify correct method (PUT for setLabels, POST for transition)
        if (req.method === 'PUT' || req.method === 'POST') {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
        }
      }
    });
    const port = srv.address().port;
    const envWithPr = { ...envForCli(gh, port, path.join(gh, 'gh.js')), CLAIM_PR_LIST: JSON.stringify([
      { number: 42, state: 'MERGED', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
    ])};
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'work_exists');
      assert.strictEqual(out.pr.state, 'MERGED');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 5 — readback_failed (readback returns old labels)
  // ------------------------------------------------------------------------
  test('readback_failed: GET, PUT, GET → code 5, readback_failed', async () => {
    const gh = mkTempDir('claim-j5');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write("[]" + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        // The mutation never sticks: ai-ready is still there on readback.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready', 'review'] },
        }));
        return;
      }
      await drainBody(req);
      if (req.method === 'PUT') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 5);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'readback_failed');

      // Read, mutate, read back: the failure is reached only after the mutation.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'PUT /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/issue/KAN-1',
      ]);

      // Without --adopt-existing claim.js lists PRs and never views one.
      const argvs = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(argvs.map((a) => a.slice(0, 2)), [['pr', 'list']]);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 6 — source unavailable
  // ------------------------------------------------------------------------
  test('source unavailable → code 6, source_unavailable', async () => {
    const gh = mkTempDir('claim-j6');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const credPath = writeCredsFile(gh, 'http://127.0.0.1:1');
    const env = {
      ...process.env,
      JIRA_CREDENTIALS_FILE: credPath,
      COORDINATOR_STATE_DIR: path.join(gh, 'state'),
      PICKUP_GH_EXEC: path.join(gh, 'gh.js'),
      PICKUP_GH_PREFIX_ARGS_JSON: '[]',
    };
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 6);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'source_unavailable');
    } finally {
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 0 — happy path: remove ai-ready, keep other labels, print summary
  // ------------------------------------------------------------------------
  test('successful claim → code 0, labels preserved', async () => {
    const gh = mkTempDir('claim-j0');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        // First call (read before mutation): ai-ready present
        if (!srv._mutated) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
          return;
        }
        // Readback after mutation: ai-ready gone, others intact
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'In Progress' }, labels: ['project-test', 'review'] },
        }));
      } else {
        await drainBody(req);
        srv._mutated = true;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.key, 'KAN-1');
      assert.deepStrictEqual(out.labelsBefore, ['project-test', 'review', 'ai-ready']);
      assert.deepStrictEqual(out.labelsAfter, ['project-test', 'review']);
      assert.ok(out.claimedAt);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 4 — no mutations when work_exists without --adopt-existing
  // ------------------------------------------------------------------------
  test('work_exists without --adopt-existing → no Jira mutations', async () => {
    let mutationCount = 0;
    const gh = mkTempDir('claim-j4m');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'process.stdout.write(JSON.stringify(data) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        mutationCount++;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ])};
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      assert.strictEqual(mutationCount, 0, 'Jira should not receive any mutation requests for work_exists without --adopt-existing');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // adopt-existing open PR: claim.js builds state=review_pending, mode=review, exitCode=0
  // ------------------------------------------------------------------------
  test('adopt-existing open PR → code 0, state: review_pending, mode: review', async () => {
    const gh = mkTempDir('claim-ja');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "abc123def456",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ])};
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.reason, 'review_pending');
      assert.strictEqual(out.adopted, true);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.mode, 'review');
      assert.deepStrictEqual(out.labelsBefore, ['project-test', 'review', 'ai-ready']);
      assert.deepStrictEqual(out.labelsAfter, ['project-test', 'review', 'ai-in-review']);
      assert.ok(out.pr);
      assert.strictEqual(out.pr.number, 42);

      // Issue, myself, comments (verdict lookup), mutation, readback: in that order.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/myself',
        'GET /rest/api/2/issue/KAN-1/comment',
        'PUT /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/issue/KAN-1',
      ]);

      // Verify gh stub received both pr list and pr view calls with separate argv
      const argvs = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
      const prListCall = argvs.find((a) => Array.isArray(a) && a[0] === 'pr' && a[1] === 'list');
      const prViewCall = argvs.find((a) => Array.isArray(a) && a[0] === 'pr' && a[1] === 'view');
      assert.ok(prListCall, 'gh stub should have been called with pr list');
      assert.ok(prViewCall, 'gh stub should have been called with pr view');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ------------------------------------------------------------------------
  // Exit code 5 — adopt-existing: readback_failed (ai-in-review still absent after mutation)
  // ------------------------------------------------------------------------
  test('adopt-existing readback_failed → code 5', async () => {
    const gh = mkTempDir('claim-jr');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "abc123def456",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        // Always return ai-ready still present (mutation didn't stick)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'MERGED', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ])};
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 5);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'readback_failed');

      // Merged PR: no verdict lookup (no /myself, no comments); issue, mutation, readback in that order.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'PUT /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/issue/KAN-1',
      ]);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ==========================================================================
  // Acceptance criteria — 11 tests per the change contract
  // ==========================================================================

  // AC1: ai-blocked + ai-ready, PR нет, без флага → код 3, state: "blocked"
  test('AC1: ai-blocked + ai-ready, no PR → code 3, state: blocked', async () => {
    const gh = mkTempDir('ac1');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready', 'ai-blocked'] },
      }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'blocked');
      assert.strictEqual(out.state, 'blocked');

      // Jira stub received only the issue read; no gh calls at all.
      const calls = [];
      // We don't have a jira-log in this test, but gh-log should be empty.
      assert.strictEqual(fs.existsSync(logPath), false, 'gh stub should not have been called');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC2: ai-blocked + открытый PR + --adopt-existing → код 3, state: "blocked", ноль мутаций
  test('AC2: ai-blocked + open PR + --adopt-existing → code 3, blocked, zero mutations', async () => {
    const gh = mkTempDir('ac2');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write(JSON.stringify([{ number: 42, state: "OPEN", title: "[KAN-1] Fix bug" }]) + "\\n");',
      'process.exit(0);',
    ].join(''));
    let mutationCount = 0;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready', 'ai-blocked'] },
        }));
      } else {
        await drainBody(req);
        mutationCount++;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 3);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'blocked');
      assert.strictEqual(out.state, 'blocked');
      assert.strictEqual(mutationCount, 0, 'ai-blocked must prevent any Jira mutations');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC3: PR найден, флага нет → код 4, state: "work_exists", ноль мутаций Jira
  test('AC3: PR found, no --adopt-existing → code 4, work_exists, zero mutations', async () => {
    const gh = mkTempDir('ac3');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    let mutationCount = 0;
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write(JSON.stringify([{ number: 42, state: "OPEN", title: "[KAN-1] Fix bug" }]) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        mutationCount++;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'work_exists');
      assert.strictEqual(out.state, 'work_exists'); // contract: state equals reason (was review_pending)
      assert.strictEqual(mutationCount, 0, 'work_exists without --adopt-existing must not mutate Jira');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC4: Влитый PR + --adopt-existing, метка ai-awaiting-merge была → код 0, state: "closing", mode: "close", labelsAfter содержит ai-awaiting-merge
  test('AC4: merged PR + --adopt-existing, ai-awaiting-merge present → code 0, closing, mode close, label preserved', async () => {
    const gh = mkTempDir('ac4');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var pr = { number: 42, state: "MERGED", title: "[KAN-1] Fix bug", headRefOid: "abc123" };',
      'process.stdout.write(JSON.stringify(process.argv[3] === "view" ? pr : [pr]));',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready', 'ai-awaiting-merge'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-awaiting-merge'] },
          }));
        }
      } else {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.state, 'closing');
      assert.strictEqual(out.mode, 'close');
      assert.strictEqual(out.reason, 'closing');
      assert.deepStrictEqual(out.labelsAfter, ['project-test', 'ai-awaiting-merge']);
      assert.ok(out.labelsAfter.includes('ai-awaiting-merge'), 'ai-awaiting-merge must be preserved in labelsAfter');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC5: Влитый PR + --adopt-existing, метки ai-awaiting-merge не было → код 0, метка поставлена
  test('AC5: merged PR + --adopt-existing, no ai-awaiting-merge → code 0, label set', async () => {
    const gh = mkTempDir('ac5');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var pr = { number: 42, state: "MERGED", title: "[KAN-1] Fix bug", headRefOid: "abc123" };',
      'process.stdout.write(JSON.stringify(process.argv[3] === "view" ? pr : [pr]));',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-awaiting-merge'] },
          }));
        }
      } else {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.state, 'closing');
      assert.strictEqual(out.mode, 'close');
      assert.deepStrictEqual(out.labelsAfter, ['project-test', 'ai-awaiting-merge']);
      assert.ok(out.labelsAfter.includes('ai-awaiting-merge'), 'ai-awaiting-merge must be set when absent');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC6: PUT меток вернул 500 → код 7, state: mutation_failed; после PUT чтения задачи не было
  test('AC6: PUT labels returns 500 → code 7, mutation_failed, no readback after PUT', async () => {
    const gh = mkTempDir('ac6');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]" + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
        return;
      }
      await drainBody(req);
      if (req.method === 'PUT') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 7);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'mutation_failed');

      // Call sequence: GET issue, PUT labels (500), then NO GET.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'PUT /rest/api/2/issue/KAN-1',
      ]);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC7: PUT прошёл, readback вернул старые метки → код 5, state: readback_failed
  test('AC7: PUT ok but readback returns old labels → code 5, readback_failed', async () => {
    const gh = mkTempDir('ac7');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]" + "\\n");',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        // Always returns ai-ready (mutation didn't stick)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
        return;
      }
      await drainBody(req);
      if (req.method === 'PUT') {
        mutationCalled = true;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 5);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'readback_failed');

      // Full sequence: GET issue, PUT, GET readback.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'PUT /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/issue/KAN-1',
      ]);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC8: --transition-id без --expect-status → код 2, state: usage, ноль запросов к Jira
  test('AC8: --transition-id without --expect-status → code 2, usage, zero Jira requests', async () => {
    const gh = mkTempDir('ac8');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    let mutationCount = 0;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        mutationCount++;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--transition-id', '5'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 2);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'usage');
      assert.strictEqual(mutationCount, 0, 'usage error must not send any Jira requests');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC9: --transition-id с --expect-status, статус не совпал → код 5, state: readback_failed
  test('AC9: transition with --expect-status, status mismatch → code 5, readback_failed', async () => {
    const gh = mkTempDir('ac9');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]" + "\\n");',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
          }));
        } else {
          // After transition: status is "In Progress", not "Done"
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'In Progress' }, labels: ['project-test'] },
          }));
        }
        return;
      }
      await drainBody(req);
      if (req.method === 'PUT') {
        mutationCalled = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--transition-id', '5', '--expect-status', 'Done'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 5);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'readback_failed');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC10: --transition-id с --expect-status, статус совпал → код 0, state: claimed
  test('AC10: transition with --expect-status, status matches → code 0, state: claimed', async () => {
    const gh = mkTempDir('ac10');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("[]" + "\\n");',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'ai-ready'] },
          }));
        } else {
          // After transition: status matches expected "Done"
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'Done' }, labels: ['project-test'] },
          }));
        }
        return;
      }
      await drainBody(req);
      if (req.method === 'PUT') {
        mutationCalled = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--transition-id', '5', '--expect-status', 'Done'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.state, 'claimed');
      assert.strictEqual(out.reason, 'claimed');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC11: Открытый PR без вердикта + --adopt-existing → код 0, state: review_pending, reason: review_pending, mode: review, labelsAfter содержит ai-in-review
  test('AC11: open PR without verdict + --adopt-existing → code 0, review_pending, reason review_pending, mode review, ai-in-review set', async () => {
    const gh = mkTempDir('ac11');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "abc123def456",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ])};
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.reason, 'review_pending');
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.mode, 'review');
      assert.ok(out.labelsAfter.includes('ai-in-review'), 'ai-in-review must be in labelsAfter');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ==========================================================================
  // Verdict SHA acceptance criteria — 8 tests per the change contract
  // ==========================================================================

  // AC1: Вердикт верного формата с ACCEPT, автор — accountId гейта → готовность по вердикту
  // подтверждена (проверяем readiness.verdictSha равен head PR).
  test('AC1: valid ACCEPT verdict from gate account → verdictSha equals head PR', async () => {
    const gh = mkTempDir('acv1');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{ id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + headSha + ' dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: gateAccountId } }],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.reason, 'review_pending');
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.mode, 'review');
      assert.strictEqual(out.readiness.verdictSha, headSha);
      assert.strictEqual(out.readiness.headSha, headSha);
      assert.strictEqual(out.readiness.ci, false);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC2: Тот же вердикт, но authorAccountId другого автора → verdictSha null, review_pending
  test('AC2: ACCEPT verdict from non-gate account → verdictSha null, review_pending', async () => {
    const gh = mkTempDir('acv2');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    const otherAccountId = 'other456';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{ id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + headSha + ' dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: otherAccountId } }],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.readiness.verdictSha, null);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC3: Строка без dispatch=/task=/run= → verdictSha null, review_pending
  test('AC3: verdict string missing identifiers → verdictSha null, review_pending', async () => {
    const gh = mkTempDir('acv3');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{ id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + headSha, author: { accountId: gateAccountId } }],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.readiness.verdictSha, null);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC4: Два комментария: сначала ACCEPT, затем CHANGES_REQUIRED по тому же SHA → review_pending
  test('AC4: ACCEPT then CHANGES_REQUIRED on same SHA → review_pending', async () => {
    const gh = mkTempDir('acv4');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [
              { id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + headSha + ' dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: gateAccountId } },
              { id: '2', body: 'AI-REVIEW-VERDICT: CHANGES_REQUIRED sha=' + headSha + ' dispatch=ctx_abc2 task=task_abc2 run=run_abc2', author: { accountId: gateAccountId } },
            ],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.readiness.verdictSha, headSha);
      assert.strictEqual(out.readiness.ci, null);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC5: Два комментария от учётной записи гейта: сначала CHANGES_REQUIRED, затем ACCEPT по тому же SHA → readiness.verdictSha равен head PR.
  test('AC5: CHANGES_REQUIRED then ACCEPT on same SHA → verdictSha equals head PR', async () => {
    const gh = mkTempDir('acv5');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [
              { id: '1', body: 'AI-REVIEW-VERDICT: CHANGES_REQUIRED sha=' + headSha + ' dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: gateAccountId } },
              { id: '2', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + headSha + ' dispatch=ctx_abc2 task=task_abc2 run=run_abc2', author: { accountId: gateAccountId } },
            ],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.readiness.verdictSha, headSha);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC6: ACCEPT верного формата, но sha не совпадает с head PR → verdictSha null, код 0, state: review_pending
  test('AC6: ACCEPT with mismatching sha → verdictSha null, review_pending', async () => {
    const gh = mkTempDir('acv6');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const gateAccountId = 'abc123';
    const verdictSha = '1234567890abcdef1234567890abcdef12345678';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    let mutationCalled = false;
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: gateAccountId }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [
              { id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + verdictSha + ' dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: gateAccountId } },
            ],
          }));
          return;
        }
        if (!mutationCalled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        }
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.readiness.verdictSha, null);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC7: /myself недоступен — отказ обязательного источника: код 6, без мутаций.
  // Прежнее ожидание (код 0, review_pending) подменяло отказ пустым результатом.
  test('AC7: GET /myself returns 500 → code 6, source_unavailable, zero mutations', async () => {
    const gh = mkTempDir('acv7');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01';
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'var data = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      'if (process.argv[2] === "pr" && process.argv[3] === "list") {',
      '  process.stdout.write(JSON.stringify(data) + "\\n");',
      '} else if (process.argv[2] === "pr" && process.argv[3] === "view") {',
      '  process.stdout.write(JSON.stringify({',
      '    number: data[0].number,',
      '    state: data[0].state,',
      '    headRefOid: "' + headSha + '",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else if (process.argv[2] === "api") {',
      '  process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n");',
      '}',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ comments: [] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
        }));
      } else {
        await drainBody(req);
        res.writeHead(204);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 6);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.reason, 'source_unavailable');
      assert.strictEqual(out.state, 'source_unavailable');
      // Zero mutations: no PUT, no POST — only reads reached Jira.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(calls.length > 0 && calls.every((c) => c.method === 'GET'), 'only GET requests: ' + JSON.stringify(calls));
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  after(() => {
    // This after hook runs after all tests; no temp dirs to clean
    // because each test cleans up in its own finally block.
  });
});

// ==========================================================================
// Mandatory check-runs gate — AC1–AC10
// ==========================================================================

describe('claim.js — mandatory check-runs gate', () => {
  // Helper: build an inline gh stub that writes check-runs from env var.
  // The existing passing adoptExisting tests use simple inline stubs that bypass routing:
  // they always write the expected JSON and exit. This helper does the same.
  // The check-runs JSON comes from CHECK_RUNS env var — but is now wrapped in the object form.
  function inlineCheckRunsStub() {
    return [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.argv.slice(2).some(function (a) { return a.slice(-11) === "/check-runs"; })) {',
      '  var raw = process.env.CHECK_RUNS || "{}";',
      '  try { var d = JSON.parse(raw); if (d && Array.isArray(d.check_runs)) process.stdout.write(raw + "\\n"); else process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n"); } catch { process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n"); }',
      '} else if (process.argv.indexOf("pr") !== -1 && process.argv.indexOf("list") !== -1) {',
      '  process.stdout.write(process.env.CLAIM_PR_LIST || "[]" + "\\n");',
      '} else if (process.argv.indexOf("pr") !== -1 && process.argv.indexOf("view") !== -1) {',
      '  process.stdout.write(JSON.stringify({',
      '    number: JSON.parse(process.env.CLAIM_PR_LIST || "[]")[0].number,',
      '    state: JSON.parse(process.env.CLAIM_PR_LIST || "[]")[0].state,',
      '    headRefOid: "abcdef0123456789abcdef0123456789abcdef01",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else {',
      '  process.stdout.write("[]" + "\\n");',
      '}',
      'process.exit(0);',
    ].join('');
  }

  // Helper: build gh argv stub that answers pr list, pr view, and check-runs
  // from environment variables — in the object form.
  function checkRunsArgvStub(envVarName) {
    return [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.argv.slice(2).some(function (a) { return a.slice(-11) === "/check-runs"; })) {',
      '  var raw = process.env.' + envVarName + ' || "{}";',
      '  try { var d = JSON.parse(raw); if (d && Array.isArray(d.check_runs)) process.stdout.write(raw + "\\n"); else process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n"); } catch { process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + "\\n"); }',
      '} else if (process.argv.indexOf("pr") !== -1 && process.argv.indexOf("list") !== -1) {',
      '  process.stdout.write(process.env.CLAIM_PR_LIST || "[]" + "\\n");',
      '} else if (process.argv.indexOf("pr") !== -1 && process.argv.indexOf("view") !== -1) {',
      '  var list = JSON.parse(process.env.CLAIM_PR_LIST || "[]");',
      '  process.stdout.write(JSON.stringify({',
      '    number: list[0] ? list[0].number : 1,',
      '    state: list[0] ? list[0].state : "OPEN",',
      '    headRefOid: "abcdef0123456789abcdef0123456789abcdef01",',
      '    statusCheckRollup: null',
      '  }) + "\\n");',
      '} else {',
      '  process.stdout.write("[]" + "\\n");',
      '}',
      'process.exit(0);',
    ].join('');
  }

  // Helper: build common server handler for adopt-existing flows.
  function adoptServer(mutationCalledRef) {
    const labelsRef = { current: ['project-test', 'review', 'ai-ready'] };
    return async function (req, res) {
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: 'gate123' }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{
              id: '1',
              body: 'AI-REVIEW-VERDICT: ACCEPT sha=abcdef0123456789abcdef0123456789abcdef01 dispatch=ctx_abc task=task_abc run=run_abc',
              author: { accountId: 'gate123' },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: labelsRef.current },
        }));
        return;
      }
      if (req.method === 'PUT') {
        const body = await drainBody(req);
        mutationCalledRef.value = true;
        // Track the labels actually written by the server so readback reflects them.
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.fields && Array.isArray(parsed.fields.labels)) {
              labelsRef.current = parsed.fields.labels;
            }
          } catch { /* ignore parse errors */ }
        }
        res.writeHead(204);
        res.end();
        return;
      }
      await drainBody(req);
      res.writeHead(200);
      res.end();
    };
  }

  const GATE_ACCOUNT = 'gate123';
  const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
  const BOTH_PASSING = JSON.stringify({
    total_count: 2,
    check_runs: [
      { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
    ],
  });

  // AC1: обе обязательные проверки completed/success → код 4, awaiting_merge
  test('AC1: both checks passed → code 4, awaiting_merge', async () => {
    const gh = mkTempDir('ac-ci1');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const envWithPr = { ...env, CHECK_RUNS: BOTH_PASSING, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.state, 'awaiting_merge');
      assert.strictEqual(out.reason, 'awaiting_merge');
      assert.ok(out.labelsAfter.includes('ai-awaiting-merge'));
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC2: одна completed/success, вторая in_progress → код 0, review_pending
  test('AC2: one in_progress → code 0, review_pending', async () => {
    const gh = mkTempDir('ac-ci2');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const bothOnePending = JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Tests (windows-latest)', status: 'in_progress', conclusion: null },
        ],
      });
      const envWithPr = { ...env, CHECK_RUNS: bothOnePending, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.strictEqual(out.success, true);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC3: одна completed/success, вторая отсутствует → код 0, review_pending
  test('AC3: missing check → code 0, review_pending', async () => {
    const gh = mkTempDir('ac-ci3');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const onlyOne = JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
        ],
      });
      const envWithPr = { ...env, CHECK_RUNS: onlyOne, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC4: одна completed/success, вторая completed/failure → код 0, review_pending
  test('AC4: one failure → code 0, review_pending', async () => {
    const gh = mkTempDir('ac-ci4');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const oneFail = JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'failure' },
        ],
      });
      const envWithPr = { ...env, CHECK_RUNS: oneFail, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC5: обе присутствуют, conclusion null при completed → код 0, review_pending
  test('AC5: conclusion null → code 0, review_pending', async () => {
    const gh = mkTempDir('ac-ci5');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const nullConc = JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: null },
          { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
        ],
      });
      const envWithPr = { ...env, CHECK_RUNS: nullConc, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC6: transition вернул 500 → код 7, mutation_failed
  test('AC6: transition 500 → code 7, mutation_failed', async () => {
    const gh = mkTempDir('ac-ci6');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    const jiraLog = path.join(gh, 'jira-calls.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      fs.appendFileSync(jiraLog, JSON.stringify({ method: req.method, path: req.url }) + '\n');
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{
              id: '1',
              body: 'AI-REVIEW-VERDICT: ACCEPT sha=abcdef0123456789abcdef0123456789abcdef01 dispatch=ctx_abc task=task_abc run=run_abc',
              author: { accountId: GATE_ACCOUNT },
            }],
          }));
          return;
        }
        if (!mutationCalled.value) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
          return;
        }
        // After mutation
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review'] },
        }));
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled.value = true;
        res.writeHead(204);
        res.end();
      } else if (req.method === 'POST') {
        await drainBody(req);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        await drainBody(req);
        res.writeHead(200);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      // The transition request exists only in the claim flow (no PR, ai-ready present):
      // the adopt-existing path never issues one.
      const envWithPr = { ...env, CHECK_RUNS: BOTH_PASSING, CLAIM_PR_LIST: '[]' };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--transition-id', '5', '--expect-status', 'In Review'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 7);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.state, 'mutation_failed');
      assert.strictEqual(out.reason, 'mutation_failed');

      // Call sequence: GET issue, PUT labels, GET readback, POST transition(500) — no readback after transition.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      const lastCall = calls[calls.length - 1];
      assert.strictEqual(lastCall.method, 'POST', 'last call should be transition');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC7: JSON каждого из тестов 1–6 содержит state, равный reason
  test('AC7: state equals reason in tests 1–6', async () => {
    const gh = mkTempDir('ac-ci7');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));

    const scenarios = [
      { desc: 'both passing', checkRuns: BOTH_PASSING, expectedCode: 4, expectedState: 'awaiting_merge' },
      { desc: 'one pending', checkRuns: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Tests (windows-latest)', status: 'in_progress', conclusion: null },
        ],
      }), expectedCode: 0, expectedState: 'review_pending' },
      { desc: 'missing', checkRuns: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
        ],
      }), expectedCode: 0, expectedState: 'review_pending' },
      { desc: 'failure', checkRuns: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'failure' },
        ],
      }), expectedCode: 0, expectedState: 'review_pending' },
      { desc: 'null conclusion', checkRuns: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: null },
          { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
        ],
      }), expectedCode: 0, expectedState: 'review_pending' },
    ];

    try {
    for (const sc of scenarios) {
      const envWithPr = { ...env, CHECK_RUNS: sc.checkRuns, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, sc.expectedCode, 'exit code for ' + sc.desc);
      const out = JSON.parse(r.stdout);
      assert.ok(out.state, 'state field present for ' + sc.desc);
      assert.strictEqual(out.state, out.reason, 'state equals reason for ' + sc.desc);
      assert.strictEqual(out.state, sc.expectedState, 'expected state for ' + sc.desc);
    }
    } finally {
      // Always close the server: an open handle keeps the whole test file from exiting.
      await cs();
      cleanup(gh);
    }
  });

  // AC8: state присутствует в выводе отказа без обращения к сети (код 2, usage)
  test('AC8: state present in usage refusal → code 2, state: usage', async () => {
    const gh = mkTempDir('ac-ci8');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var p = process.env.GH_ARGV_LOG;',
      'if (p) fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.exit(0);',
    ].join(''));
    const { server: srv, close: cs } = await startServer(() => {});
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const r = await runSpawn(CLI, ['--issue', 'KAN-1', '--repo', 'Riniro/test'], { ...env, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 2);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'usage');
      assert.strictEqual(out.state, out.reason);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC9: custom checks via CLAIM_REQUIRED_CHECKS
  test('AC9: CLAIM_REQUIRED_CHECKS overrides defaults', async () => {
    const gh = mkTempDir('ac-ci9');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{
              id: '1',
              body: 'AI-REVIEW-VERDICT: ACCEPT sha=abcdef0123456789abcdef0123456789abcdef01 dispatch=ctx_abc task=task_abc run=run_abc',
              author: { accountId: GATE_ACCOUNT },
            }],
          }));
          return;
        }
        if (!mutationCalled.value) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-awaiting-merge'] },
        }));
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled.value = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      // Only "Lint" passes — default "Tests" are missing, so should NOT be awaiting_merge
      const lintOnly = JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 3, name: 'Lint', status: 'completed', conclusion: 'success' },
        ],
      });
      const envWithPr = {
        ...env,
        CHECK_RUNS: lintOnly,
        CLAIM_REQUIRED_CHECKS: 'Lint',
        CLAIM_PR_LIST: JSON.stringify([
          { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
        ]),
      };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'awaiting_merge');
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // AC10: queued check → не passing
  test('AC10: queued → not passing', async () => {
    const gh = mkTempDir('ac-ci10');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(adoptServer(mutationCalled));
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const bothQueued = JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'queued', conclusion: null },
          { id: 2, name: 'Tests (windows-latest)', status: 'queued', conclusion: null },
        ],
      });
      const envWithPr = { ...env, CHECK_RUNS: bothQueued, CLAIM_PR_LIST: JSON.stringify([
        { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
      ]) };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'review_pending');
      assert.ok(out.state, 'state field present');
      assert.strictEqual(out.state, out.reason);
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // Chain: review_pending → awaiting_merge → closing on ONE task.
  // An existing PR must never lead to a re-implementation: no step reports mode "implement".
  test('chain review_pending → awaiting_merge → closing never yields mode implement', async () => {
    const gh = mkTempDir('ac-chain');
    const stateFile = path.join(gh, 'gh-state.json');
    const writeGh = (prState, checkRuns) => fs.writeFileSync(stateFile, JSON.stringify({ prState, checkRuns }));
    fs.writeFileSync(path.join(gh, 'gh.js'), [
      'var fs = require("fs");',
      'var st = JSON.parse(fs.readFileSync(process.env.GH_STATE_FILE, "utf8"));',
      'var a = process.argv.slice(2);',
      'if (a[0] === "pr" && a[1] === "list") {',
      '  process.stdout.write(JSON.stringify([{ number: 42, state: st.prState, title: "[KAN-1] Fix bug", url: "https://gh.test/Riniro/test/pull/42" }]));',
      '} else if (a[0] === "pr" && a[1] === "view") {',
      '  process.stdout.write(JSON.stringify({ number: 42, state: st.prState, headRefOid: "' + HEAD_SHA + '", statusCheckRollup: null }));',
      '} else if (a[0] === "api" && a[1].slice(-11) === "/check-runs") {',
      '  process.stdout.write(JSON.stringify({ total_count: st.checkRuns.total_count, check_runs: st.checkRuns.check_runs }));',
      '} else {',
      '  process.stdout.write("[]");',
      '}',
      'process.exit(0);',
    ].join(''));

    const jira = { labels: ['project-test', 'review', 'ai-ready'], comments: [] };
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.endsWith('/myself')) { res.end(JSON.stringify({ accountId: GATE_ACCOUNT })); return; }
        if (req.url.endsWith('/comment')) { res.end(JSON.stringify({ comments: jira.comments })); return; }
        res.end(JSON.stringify({ fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: jira.labels } }));
        return;
      }
      const body = await drainBody(req);
      if (req.method === 'PUT') {
        try { jira.labels = JSON.parse(body).fields.labels; } catch { /* keep */ }
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const port = srv.address().port;
    const env = { ...envForCli(gh, port, path.join(gh, 'gh.js')), GH_STATE_FILE: stateFile };
    const run = async () => {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], env, 10000);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    try {
      // Step 1: open PR, no verdict yet → review_pending
      writeGh('OPEN', JSON.parse(BOTH_PASSING));
      const s1 = await run();
      assert.strictEqual(s1.status, 0);
      assert.strictEqual(s1.out.state, 'review_pending');
      assert.strictEqual(s1.out.mode, 'review');
      assert.ok(s1.out.labelsAfter.includes('ai-in-review'));
      assert.ok(!s1.out.labelsAfter.includes('ai-ready'));

      // Step 2: verdict by the gate's account for the head SHA + both checks green → awaiting_merge
      jira.comments.push({
        id: '1',
        body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
        author: { accountId: GATE_ACCOUNT },
      });
      const s2 = await run();
      assert.strictEqual(s2.status, 4);
      assert.strictEqual(s2.out.state, 'awaiting_merge');
      assert.strictEqual(s2.out.readiness.ci, true);
      assert.ok(s2.out.labelsAfter.includes('ai-awaiting-merge'));
      assert.ok(!s2.out.labelsAfter.includes('ai-in-review'));

      // Step 3: human merged the PR → closing, label kept
      writeGh('MERGED', JSON.parse(BOTH_PASSING));
      const s3 = await run();
      assert.strictEqual(s3.status, 0);
      assert.strictEqual(s3.out.state, 'closing');
      assert.strictEqual(s3.out.mode, 'close');
      assert.ok(s3.out.labelsAfter.includes('ai-awaiting-merge'));

      for (const [i, s] of [s1, s2, s3].entries()) {
        assert.notStrictEqual(s.out.mode, 'implement', 'step ' + (i + 1) + ' must not re-implement');
        assert.ok(!s.out.labelsAfter.includes('ai-ready'), 'step ' + (i + 1) + ' must not leave ai-ready');
      }
    } finally {
      await cs();
      cleanup(gh);
    }
  });

  // ==========================================================================
  // KAN-18 — empty CLAIM_REQUIRED_CHECKS must NOT disable the CI gate
  // ==========================================================================

  describe('KAN-18: empty CLAIM_REQUIRED_CHECKS', () => {
    const EMPTY_VALUES = ['', '   ', ',', ' , , '];
    const GATE_ACCOUNT = 'gate123';
    const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

    // Each empty value: the test should produce review_pending (NOT awaiting_merge).
    // If the empty value is wrongly treated as "no checks required", it would yield awaiting_merge.
    for (const val of EMPTY_VALUES) {
    test('empty CLAIM_REQUIRED_CHECKS ("' + val.replace(/"/g, '\\"') + '") → review_pending, not awaiting_merge', async () => {
      const gh = mkTempDir('kan18-empty-claim-' + EMPTY_VALUES.indexOf(val));
      const logPath = path.join(gh, 'gh-argv.jsonl');
      fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
      let mutationCalled = { value: false };
      const { server: srv, close: cs } = await startServer(async (req, res) => {
        if (req.method === 'GET') {
          if (req.url.endsWith('/myself')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
            return;
          }
          if (req.url.endsWith('/comment')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              comments: [{
                id: '1',
                body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
                author: { accountId: GATE_ACCOUNT },
              }],
            }));
            return;
          }
          if (!mutationCalled.value) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        } else if (req.method === 'PUT') {
          await drainBody(req);
          mutationCalled.value = true;
          res.writeHead(204);
          res.end();
        } else {
          await drainBody(req);
          res.writeHead(200);
          res.end();
        }
      });
      const port = srv.address().port;
      const env = envForCli(gh, port, path.join(gh, 'gh.js'));
      try {
        const bothPassing = JSON.stringify({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
          ],
        });
        const envWithPr = {
          ...env,
          CHECK_RUNS: bothPassing,
          CLAIM_REQUIRED_CHECKS: val,
          CLAIM_PR_LIST: JSON.stringify([
            { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
          ]),
        };
        const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
        assert.strictEqual(r.status, 0);
        const out = JSON.parse(r.stdout);
        assert.notStrictEqual(out.state, 'awaiting_merge', 'empty CLAIM_REQUIRED_CHECKS must NOT result in awaiting_merge');
        assert.strictEqual(out.state, 'review_pending');
      } finally {
        await cs();
        cleanup(gh);
      }
    });
  }

  // Control: same adopt-existing configuration WITHOUT the variable → default required set applies,
  // both checks green → awaiting_merge. Proves the variable actually reaches the product.
  test('control: adopt-existing + GREEN, no variable → awaiting_merge', async () => {
    const gh = mkTempDir('kan18-ctrl-claim');
    const logPath = path.join(gh, 'gh-argv.jsonl');
    fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
    let mutationCalled = { value: false };
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
          return;
        }
        if (req.url.endsWith('/comment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comments: [{
              id: '1',
              body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
              author: { accountId: GATE_ACCOUNT },
            }],
          }));
          return;
        }
        if (!mutationCalled.value) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-awaiting-merge'] },
        }));
      } else if (req.method === 'PUT') {
        await drainBody(req);
        mutationCalled.value = true;
        res.writeHead(204);
        res.end();
      } else {
        await drainBody(req);
        res.writeHead(200);
        res.end();
      }
    });
    const port = srv.address().port;
    const env = envForCli(gh, port, path.join(gh, 'gh.js'));
    try {
      const bothPassing = JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
        ],
      });
      // NOTE: no CLAIM_REQUIRED_CHECKS key here — the product reads the default set.
      const envWithPr = {
        ...env,
        CHECK_RUNS: bothPassing,
        CLAIM_PR_LIST: JSON.stringify([
          { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
        ]),
      };
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
      assert.strictEqual(r.status, 4);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.state, 'awaiting_merge');
    } finally {
      await cs();
      cleanup(gh);
    }
  });
  });

  // ==========================================================================
  // KAN-20 — whitespace in CLAIM_REQUIRED_CHECKS: spaces/tabs/empty around comma are tolerated,
  //          spaces inside a name are not.
  // ==========================================================================

  describe('KAN-20: whitespace in CLAIM_REQUIRED_CHECKS', () => {
    const BOTH_PASSING = JSON.stringify({
      total_count: 2,
      check_runs: [
        { id: 1, name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
      ],
    });
    const SP = ' ';
    const TAB = '\t';

    // Values that SHOULD be tolerated — CI green, awaiting_merge (code 4)
    const TOLERATED = [
      SP + 'Tests (ubuntu-latest)' + SP + ',' + SP + 'Tests (windows-latest)' + SP,
      TAB + 'Tests (ubuntu-latest)' + TAB + ',' + TAB + 'Tests (windows-latest)' + TAB,
      'Tests (ubuntu-latest),' + SP + ',Tests (windows-latest)',
      'Tests (ubuntu-latest),,Tests (windows-latest)',
    ];

    // Value that should NOT be tolerated — space inside name, review_pending (code 0)
    const REJECTED = 'Tests' + SP + SP + '(ubuntu-latest),Tests (windows-latest)';

    // Control A: single-space inside name (no extra space) → should be awaiting_merge
    const CONTROL_A = 'Tests (ubuntu-latest),Tests (windows-latest)';

    // Control B: same rejected variable name but GH checks have matching double-space names → awaiting_merge
    const CONTROL_B_GH_DUB = 'Tests' + SP + SP + '(ubuntu-latest),Tests (windows-latest)';

    for (const val of TOLERATED) {
      test('tolerated whitespace in CLAIM_REQUIRED_CHECKS (' + JSON.stringify(val) + ') → awaiting_merge', async () => {
        const gh = mkTempDir('kan20-tol-claim');
        const logPath = path.join(gh, 'gh-argv.jsonl');
        fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
        let mutationCalled = { value: false };
        const { server: srv, close: cs } = await startServer(async (req, res) => {
          if (req.method === 'GET') {
            if (req.url.endsWith('/myself')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
              return;
            }
            if (req.url.endsWith('/comment')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                comments: [{
                  id: '1',
                  body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
                  author: { accountId: GATE_ACCOUNT },
                }],
              }));
              return;
            }
            if (!mutationCalled.value) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-awaiting-merge'] },
            }));
          } else if (req.method === 'PUT') {
            await drainBody(req);
            mutationCalled.value = true;
            res.writeHead(204);
            res.end();
          } else {
            await drainBody(req);
            res.writeHead(200);
            res.end();
          }
        });
        const port = srv.address().port;
        const env = envForCli(gh, port, path.join(gh, 'gh.js'));
        try {
          const envWithPr = {
            ...env,
            CHECK_RUNS: BOTH_PASSING,
            CLAIM_REQUIRED_CHECKS: val,
            CLAIM_PR_LIST: JSON.stringify([
              { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
            ]),
          };
          const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
          assert.strictEqual(r.status, 4);
          const out = JSON.parse(r.stdout);
          assert.strictEqual(out.state, 'awaiting_merge');
        } finally {
          await cs();
          cleanup(gh);
        }
      });
    }

    test('rejected space-inside-name in CLAIM_REQUIRED_CHECKS → review_pending, not awaiting_merge', async () => {
      const gh = mkTempDir('kan20-rej-claim');
      const logPath = path.join(gh, 'gh-argv.jsonl');
      fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
      let mutationCalled = { value: false };
      const { server: srv, close: cs } = await startServer(async (req, res) => {
        if (req.method === 'GET') {
          if (req.url.endsWith('/myself')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
            return;
          }
          if (req.url.endsWith('/comment')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              comments: [{
                id: '1',
                body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
                author: { accountId: GATE_ACCOUNT },
              }],
            }));
            return;
          }
          if (!mutationCalled.value) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-in-review'] },
          }));
        } else if (req.method === 'PUT') {
          await drainBody(req);
          mutationCalled.value = true;
          res.writeHead(204);
          res.end();
        } else {
          await drainBody(req);
          res.writeHead(200);
          res.end();
        }
      });
      const port = srv.address().port;
      const env = envForCli(gh, port, path.join(gh, 'gh.js'));
      try {
        const envWithPr = {
          ...env,
          CHECK_RUNS: BOTH_PASSING,
          CLAIM_REQUIRED_CHECKS: REJECTED,
          CLAIM_PR_LIST: JSON.stringify([
            { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
          ]),
        };
        const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
        assert.strictEqual(r.status, 0);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.state, 'review_pending');
        assert.notStrictEqual(out.state, 'awaiting_merge');
      } finally {
        await cs();
        cleanup(gh);
      }
    });

    // Control A: same as value 5 but without the extra space → should be awaiting_merge
    test('control A: single-space CLAIM_REQUIRED_CHECKS (no extra space) → awaiting_merge', async () => {
      const gh = mkTempDir('kan20-ca-claim');
      const logPath = path.join(gh, 'gh-argv.jsonl');
      fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
      let mutationCalled = { value: false };
      const { server: srv, close: cs } = await startServer(async (req, res) => {
        if (req.method === 'GET') {
          if (req.url.endsWith('/myself')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
            return;
          }
          if (req.url.endsWith('/comment')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              comments: [{
                id: '1',
                body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
                author: { accountId: GATE_ACCOUNT },
              }],
            }));
            return;
          }
          if (!mutationCalled.value) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-awaiting-merge'] },
          }));
        } else if (req.method === 'PUT') {
          await drainBody(req);
          mutationCalled.value = true;
          res.writeHead(204);
          res.end();
        } else {
          await drainBody(req);
          res.writeHead(200);
          res.end();
        }
      });
      const port = srv.address().port;
      const env = envForCli(gh, port, path.join(gh, 'gh.js'));
      try {
        const envWithPr = {
          ...env,
          CHECK_RUNS: BOTH_PASSING,
          CLAIM_REQUIRED_CHECKS: CONTROL_A,
          CLAIM_PR_LIST: JSON.stringify([
            { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
          ]),
        };
        const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], { ...envWithPr, GH_ARGV_LOG: logPath }, 10000);
        assert.strictEqual(r.status, 4);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.state, 'awaiting_merge');
      } finally {
        await cs();
        cleanup(gh);
      }
    });

    // Control B: rejected variable name but GH checks have matching double-space names → awaiting_merge
    test('control B: double-space in both variable AND check names → awaiting_merge', async () => {
      const gh = mkTempDir('kan20-cb-claim');
      const logPath = path.join(gh, 'gh-argv.jsonl');
      fs.writeFileSync(path.join(gh, 'gh.js'), checkRunsArgvStub('CHECK_RUNS'));
      let mutationCalled = { value: false };
      const { server: srv, close: cs } = await startServer(async (req, res) => {
        if (req.method === 'GET') {
          if (req.url.endsWith('/myself')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accountId: GATE_ACCOUNT }));
            return;
          }
          if (req.url.endsWith('/comment')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              comments: [{
                id: '1',
                body: 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD_SHA + ' dispatch=ctx_abc task=task_abc run=run_abc',
                author: { accountId: GATE_ACCOUNT },
              }],
            }));
            return;
          }
          if (!mutationCalled.value) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-ready'] },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            fields: { summary: 'Test issue', status: { name: 'To Do' }, labels: ['project-test', 'review', 'ai-awaiting-merge'] },
          }));
        } else if (req.method === 'PUT') {
          await drainBody(req);
          mutationCalled.value = true;
          res.writeHead(204);
          res.end();
        } else {
          await drainBody(req);
          res.writeHead(200);
          res.end();
        }
      });
      const port = srv.address().port;
      const env = envForCli(gh, port, path.join(gh, 'gh.js'));
      try {
        // Same as Control A but with double-space names in both env vars
        const doubleSpaceChecks = JSON.stringify({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'Tests' + SP + SP + '(ubuntu-latest)', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' },
          ],
        });
        const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], {
          ...env,
          CHECK_RUNS: doubleSpaceChecks,
          CLAIM_REQUIRED_CHECKS: 'Tests' + SP + SP + '(ubuntu-latest),Tests (windows-latest)',
          CLAIM_PR_LIST: JSON.stringify([
            { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' },
          ]),
          GH_ARGV_LOG: logPath,
        }, 10000);
        assert.strictEqual(r.status, 4, r.stdout);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.state, 'awaiting_merge');
      } finally {
        await cs();
        cleanup(gh);
      }
    });
  });

  after(() => {
    // No temp dirs to clean; each test cleans up in its own finally block.
  });
});

// ==========================================================================
// Fix round 2 — regression matrix rows added after the independent review.
// One shared harness: a configurable gh stub and a stateful Jira server that
// both log every request, so each test can assert WHICH calls happened.
// ==========================================================================

describe('claim.js — fix round 2', () => {
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  const ME = 'gate123';
  const UBUNTU = { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' };
  const WINDOWS = { name: 'Tests (windows-latest)', status: 'completed', conclusion: 'success' };
  const OPEN_PR = { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/Riniro/test/pull/42' };
  const MERGED_PR = { ...OPEN_PR, state: 'MERGED' };
  const GOOD_BASE = ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test'];

  function accept(sha = HEAD, v = 'ACCEPT', author = ME) {
    return {
      id: String(Math.random()),
      body: 'AI-REVIEW-VERDICT: ' + v + ' sha=' + sha + ' dispatch=ctx_abc task=task_abc run=run_abc',
      author: { accountId: author },
    };
  }

  const GH_STUB = [
    'var fs = require("fs");',
    'var a = process.argv.slice(2);',
    'fs.appendFileSync(process.env.GH_ARGV_LOG, JSON.stringify(a) + "\\n");',
    'var cfg = JSON.parse(fs.readFileSync(process.env.GH_CFG, "utf8"));',
    'function out(x) { process.stdout.write(typeof x === "string" ? x : JSON.stringify(x)); process.exit(0); }',
    // A failing gh may still have printed a plausible body: only the exit status says it failed.
    'function fail(plausible) { if (plausible !== undefined) process.stdout.write(JSON.stringify(plausible)); process.stderr.write("gh: boom"); process.exit(1); }',
    'if (a[0] === "pr" && a[1] === "list") { if (cfg.failList) fail(cfg.prs); if (cfg.rawList !== undefined) out(cfg.rawList); out(cfg.prs); }',
    'if (a[0] === "pr" && a[1] === "view") {',
    '  var view = { number: cfg.prs[0].number, state: cfg.prs[0].state, headRefOid: cfg.head, statusCheckRollup: null };',
    '  if (cfg.failView) fail(view);',
    '  out(view);',
    '}',
    'if (a[0] === "api") {',
    '  if (cfg.failChecks) fail({ total_count: cfg.checks.length, check_runs: cfg.checks });',
    '  var page = 1;',
    '  a.forEach(function (x) { var m = /^page=(\\d+)$/.exec(x); if (m) page = Number(m[1]); });',
    '  if (cfg.failPage === page) fail(cfg.pages[page - 1]);',
    '  if (cfg.raw !== undefined) out(cfg.raw);',
    '  if (cfg.endless) out({ total_count: 100000, check_runs: [{ name: "Tests (ubuntu-latest)", status: "completed", conclusion: "success" }] });',
    '  if (cfg.pages) out(cfg.pages[page - 1] || { total_count: cfg.total, check_runs: [] });',
    '  out({ total_count: cfg.checks.length, check_runs: cfg.checks });',
    '}',
    'out("[]");',
  ].join('\n');

  /**
   * Runs claim.js against the stubs. cfg: labels, status, prs, head, checks, pages, total,
   * failList/failView/failChecks/failPage/raw, comments, myselfCode/commentCode/putCode/postCode, afterStatus.
   */
  async function scenario(cfg, args) {
    const dir = mkTempDir('fr2');
    fs.writeFileSync(path.join(dir, 'gh.js'), GH_STUB);
    const ghCfg = path.join(dir, 'gh-cfg.json');
    const ghLog = path.join(dir, 'gh-argv.jsonl');
    fs.writeFileSync(ghCfg, JSON.stringify({
      prs: cfg.prs || [], head: cfg.head === undefined ? HEAD : cfg.head, checks: cfg.checks || [UBUNTU, WINDOWS],
      pages: cfg.pages, total: cfg.total, failList: cfg.failList, failView: cfg.failView,
      failChecks: cfg.failChecks, failPage: cfg.failPage, raw: cfg.raw, rawList: cfg.rawList, endless: cfg.endless,
    }));
    fs.writeFileSync(ghLog, '');
    const state = { labels: (cfg.labels || ['project-test', 'review', 'ai-ready']).slice(), status: cfg.status || 'To Do' };
    const jira = [];
    const { server: srv, close: cs } = await startServer(async (req, res) => {
      const body = await drainBody(req);
      jira.push({ method: req.method, url: req.url.split('?')[0], body: body || '' });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET') {
        if (req.url.endsWith('/myself')) return cfg.myselfCode >= 400 ? json(cfg.myselfCode, {}) : json(200, { accountId: ME });
        if (req.url.endsWith('/comment')) return cfg.commentCode >= 400 ? json(cfg.commentCode, {}) : json(200, { comments: cfg.comments || [] });
        return json(200, { fields: { summary: 'Test issue', status: { name: state.status }, labels: state.labels } });
      }
      if (req.method === 'PUT') {
        if (cfg.putCode >= 400) return json(cfg.putCode, { error: 'no' });
        try { state.labels = JSON.parse(body).fields.labels; } catch { /* keep */ }
        res.writeHead(204); res.end(); return;
      }
      if (cfg.postCode >= 400) return json(cfg.postCode, { error: 'no' });
      state.status = cfg.afterStatus || 'In Review';
      res.writeHead(204); res.end();
    });
    const env = { ...envForCli(dir, srv.address().port, path.join(dir, 'gh.js')), GH_CFG: ghCfg, GH_ARGV_LOG: ghLog, ...(cfg.env || {}) };
    try {
      const r = await runSpawn(CLI, args, env, 15000);
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not json */ }
      const gh = fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { status: r.status, out, jira, gh, state, seq: jira.map((c) => c.method + ' ' + c.url.replace('/rest/api/2', '')) };
    } finally {
      await cs();
      cleanup(dir);
    }
  }

  const writes = (res) => res.jira.filter((c) => c.method !== 'GET');
  const adopt = [...GOOD_BASE, '--adopt-existing'];
  const INITIAL_LABELS = ['project-test', 'review', 'ai-ready'];

  // ---- MAJOR 1 — gh unavailable / write auth refused ------------------------------------------

  test('M1: gh pr list unavailable → code 6 source_unavailable, no Jira writes', async () => {
    const res = await scenario({ prs: [OPEN_PR], failList: true }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.strictEqual(res.out.success, false);
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('M1: gh pr view unavailable (--adopt-existing) → code 6 source_unavailable, no Jira writes', async () => {
    const res = await scenario({ prs: [OPEN_PR], failView: true }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.ok(res.gh.some((a) => a[0] === 'pr' && a[1] === 'view'), 'pr view was attempted');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('M1: labels write refused with 401, no PR → code 6; nothing succeeded or followed', async () => {
    const res = await scenario({ prs: [], putCode: 401 }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', 'In Review']);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    // The PUT was sent and refused; nothing may follow it: no readback, no transition.
    assert.deepStrictEqual(res.seq, ['GET /issue/KAN-1', 'PUT /issue/KAN-1']);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS, 'Jira labels unchanged');
    assert.strictEqual(res.state.status, 'To Do');
  });

  test('M1: labels write refused with 401, open PR → code 6; nothing succeeded or followed', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [], putCode: 401 }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.strictEqual(res.seq[res.seq.length - 1], 'PUT /issue/KAN-1', 'the refused PUT is the last Jira request');
    assert.strictEqual(res.seq.filter((s) => s.startsWith('PUT')).length, 1);
    assert.ok(!res.seq.some((s) => s.startsWith('POST')), 'no transition');
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS, 'Jira labels unchanged');
  });

  // ---- MAJOR 2 — SHA case ------------------------------------------------------------------------

  test('M2: verdict SHA upper case, head lower case → code 4 awaiting_merge', async () => {
    const res = await scenario({ prs: [OPEN_PR], head: HEAD, comments: [accept(HEAD.toUpperCase())] }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
  });

  test('M2: verdict SHA lower case, head upper case → code 4 awaiting_merge', async () => {
    const res = await scenario({ prs: [OPEN_PR], head: HEAD.toUpperCase(), comments: [accept(HEAD)] }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
  });

  // ---- MAJOR 3 — a failed mandatory source is not an empty result -------------------------------

  test('M3: /myself unavailable → code 6, zero mutations', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], myselfCode: 500 }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('M3: comments unavailable → code 6, zero mutations', async () => {
    const res = await scenario({ prs: [OPEN_PR], commentCode: 500 }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('M3: gh api check-runs exits non-zero → code 6, zero mutations (not ci:false)', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], failChecks: true }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
    assert.strictEqual(res.state.status, 'To Do');
  });

  test('M3: gh api check-runs returns an unreadable body → code 6, zero mutations', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], raw: '<html>not json</html>' }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
  });

  test('M3: gh api check-runs returns an empty body → code 6, zero mutations', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], raw: '' }, adopt);
    assert.strictEqual(res.status, 6);
    assert.deepStrictEqual(writes(res), []);
  });

  test('M3: a successful answer without the required check still means ci:false, review_pending', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], checks: [UBUNTU] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.state, 'review_pending');
    assert.strictEqual(res.out.readiness.ci, false);
    assert.ok(res.state.labels.includes('ai-in-review'));
  });

  // ---- MINOR 4 — no duplicate labels ------------------------------------------------------------

  test('m4: closing with ai-awaiting-merge already set → the sent label set has no duplicates', async () => {
    const res = await scenario({ prs: [MERGED_PR], labels: ['project-test', 'ai-ready', 'ai-awaiting-merge'] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.state, 'closing');
    const puts = res.jira.filter((c) => c.method === 'PUT');
    assert.strictEqual(puts.length, 1);
    const sent = JSON.parse(puts[0].body).fields.labels;
    assert.deepStrictEqual(sent, ['project-test', 'ai-awaiting-merge']);
    assert.strictEqual(new Set(sent).size, sent.length);
  });

  // ---- MINOR 5 — work_exists carries no mode -----------------------------------------------------

  for (const pr of [OPEN_PR, MERGED_PR]) {
    test('m5: ' + pr.state + ' PR without --adopt-existing → code 4 work_exists, no mode, state kept', async () => {
      const res = await scenario({ prs: [pr] }, GOOD_BASE);
      assert.strictEqual(res.status, 4);
      assert.strictEqual(res.out.reason, 'work_exists');
      assert.strictEqual(res.out.state, 'work_exists');
      assert.ok(!('mode' in res.out), 'work_exists must not carry a mode: ' + JSON.stringify(res.out));
      assert.deepStrictEqual(writes(res), []);
    });
  }

  // ---- MINOR 6 — a merged PR needs no verdict, comments or CI -----------------------------------

  test('m6: merged PR → no /myself, no comments, no check-runs requests', async () => {
    const res = await scenario({ prs: [MERGED_PR], labels: ['project-test', 'ai-ready'] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.state, 'closing');
    assert.ok(!res.seq.some((s) => s.endsWith('/myself') || s.endsWith('/comment')), 'Jira calls: ' + res.seq.join(' | '));
    assert.ok(!res.gh.some((a) => a[0] === 'api'), 'no gh api call for a merged PR');
    assert.ok(res.state.labels.includes('ai-awaiting-merge'));
  });

  // ---- MINOR 7 — --repo, argument parsing, full check-run set -----------------------------------

  test('m7: --repo is present in every gh call', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()] }, adopt);
    assert.strictEqual(res.status, 4);
    const kinds = new Set(res.gh.map((a) => a[0] + ' ' + (a[0] === 'pr' ? a[1] : '')));
    assert.ok(kinds.has('pr list') && kinds.has('pr view') && kinds.has('api '), 'all three gh calls made: ' + [...kinds]);
    for (const a of res.gh) {
      if (a[0] === 'api') {
        // `gh api` has no --repo flag: the repository is part of the endpoint path.
        assert.ok(a.some((x) => x.startsWith('repos/Riniro/test/')), 'api call addresses the repo: ' + JSON.stringify(a));
      } else {
        const i = a.indexOf('--repo');
        assert.ok(i !== -1 && a[i + 1] === 'Riniro/test', 'missing --repo: ' + JSON.stringify(a));
      }
    }
  });

  test('m7: unknown flag → code 2 usage, zero Jira requests, zero gh calls', async () => {
    const res = await scenario({ prs: [] }, [...GOOD_BASE, '--bogus']);
    assert.strictEqual(res.status, 2);
    assert.strictEqual(res.out.reason, 'usage');
    assert.strictEqual(res.out.state, 'usage');
    assert.deepStrictEqual(res.jira, []);
    assert.deepStrictEqual(res.gh, []);
  });

  test('m7: unknown positional argument → code 2 usage, zero requests', async () => {
    const res = await scenario({ prs: [] }, [...GOOD_BASE, 'stray']);
    assert.strictEqual(res.status, 2);
    assert.strictEqual(res.out.reason, 'usage');
    assert.deepStrictEqual(res.jira, []);
  });

  test('m7: trailing flag without a value → code 2 usage, zero requests', async () => {
    for (const tail of ['--transition-id', '--expect-status', '--project', '--issue', '--repo']) {
      const base = tail === '--project' ? ['--issue', 'KAN-1', '--repo', 'Riniro/test']
        : tail === '--issue' ? ['--project', 'KAN', '--repo', 'Riniro/test']
          : tail === '--repo' ? ['--project', 'KAN', '--issue', 'KAN-1'] : GOOD_BASE;
      const res = await scenario({ prs: [] }, [...base, tail]);
      assert.strictEqual(res.status, 2, tail);
      assert.strictEqual(res.out.reason, 'usage', tail);
      assert.deepStrictEqual(res.jira, [], tail);
      assert.deepStrictEqual(res.gh, [], tail);
    }
  });

  test('m7: a flag followed by another flag (value missing) → code 2 usage, zero requests', async () => {
    const res = await scenario({ prs: [] }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', '--adopt-existing']);
    assert.strictEqual(res.status, 2);
    assert.strictEqual(res.out.reason, 'usage');
    assert.deepStrictEqual(res.jira, []);
  });

  const LINT = { name: 'lint', status: 'completed', conclusion: 'success' };

  test('m7: required check on the second page of check-runs is found → code 4 awaiting_merge', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 3, check_runs: [UBUNTU, LINT] },
        { total_count: 3, check_runs: [WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    assert.ok(res.gh.filter((a) => a[0] === 'api').length >= 2, 'more than one page requested');
  });

  test('m7: second page of check-runs unavailable → code 6, zero mutations', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()], failPage: 2,
      pages: [
        { total_count: 3, check_runs: [UBUNTU, LINT] },
        { total_count: 3, check_runs: [WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
  });

  // ---- MINOR 7 (continued): object-form and multi-page coverage for fetchCheckRunsForSha --------

  test('m7.1: single-page response with total_count smaller than actual items → still returns what was received', async () => {
    // total_count says 1 but the server actually sent 2 items — the product code should still return them.
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 1, check_runs: [UBUNTU, WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    // Only one page was requested since total_count < actual items.
    assert.ok(res.gh.filter((a) => a[0] === 'api').length === 1, 'only one page asked');
  });

  test('m7.2: single-page with total_count absent → returns check_runs, no paging loop', async () => {
    // Without total_count the product returns immediately after the first page.
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { check_runs: [UBUNTU, WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    assert.ok(res.gh.filter((a) => a[0] === 'api').length === 1, 'only one page asked when total_count absent');
  });

  test('m7.3: multi-page where required check is on page 2 → still found, code 4', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 4, check_runs: [UBUNTU, { name: 'build', status: 'completed', conclusion: 'success' }] },
        { total_count: 4, check_runs: [WINDOWS, { name: 'deploy', status: 'completed', conclusion: 'success' }] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    assert.ok(res.gh.filter((a) => a[0] === 'api').length === 2, 'two pages requested');
    // Assert both page calls contain the repo and SHA.
    const apiCalls = res.gh.filter((a) => a[0] === 'api');
    assert.ok(apiCalls[0].some((x) => x.includes('repos/Riniro/test')), 'page 1 has repo in path');
    assert.ok(apiCalls[1].some((x) => x.includes('repos/Riniro/test')), 'page 2 has repo in path');
  });

  test('m7.4: gh exit 1 on page 2 → code 6', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()], failPage: 2,
      pages: [
        { total_count: 2, check_runs: [UBUNTU] },
        { total_count: 2, check_runs: [WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
  });

  // ---- MINOR 7.5 — empty-page regression: incomplete answer must NOT confirm CI ----------------

  test('m7.5: incomplete answer (2 of 5, page 2 empty) → code 6 source_unavailable, no mutation', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 5, check_runs: [UBUNTU, WINDOWS] },
        { total_count: 5, check_runs: [] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
  });

  test('m7.5.2: full green answer on OPEN PR still enters awaiting_merge', async () => {
    // Control: when total_count matches actual items and both required are green, the gate works.
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 2, check_runs: [UBUNTU, WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
  });

  test('m7.5.3: empty page after collecting all claimed items → returns successfully', async () => {
    // If all claimed already, an empty page is not fetched (condition all.length >= total_count fires first).
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 2, check_runs: [UBUNTU, WINDOWS] },
        { total_count: 2, check_runs: [] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    // Only one page requested since all items already collected.
    assert.ok(res.gh.filter((a) => a[0] === 'api').length === 1, 'only one page asked when all collected');
  });

  // ---- MINOR 8 — no pointless PUT ------------------------------------------------------------------

  test('m8: awaiting_merge with labels already in the target state → no PUT, no readback', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], labels: ['project-test', 'review', 'ai-awaiting-merge'] }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.seq, ['GET /issue/KAN-1', 'GET /myself', 'GET /issue/KAN-1/comment']);
    assert.deepStrictEqual(res.out.labelsAfter, ['project-test', 'review', 'ai-awaiting-merge']);
  });

  test('m8: review_pending with ai-in-review already set → no PUT, no readback', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [], labels: ['project-test', 'ai-in-review'] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.state, 'review_pending');
    assert.deepStrictEqual(writes(res), []);
    assert.strictEqual(res.seq.filter((s) => s === 'GET /issue/KAN-1').length, 1, 'no readback of the issue');
  });

  test('m8: closing with ai-awaiting-merge already set → no PUT, no readback', async () => {
    const res = await scenario({ prs: [MERGED_PR], labels: ['project-test', 'ai-awaiting-merge'] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.state, 'closing');
    assert.deepStrictEqual(res.seq, ['GET /issue/KAN-1']);
  });

  test('m8: a changing label set is still written and read back', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], labels: ['project-test', 'ai-in-review'] }, adopt);
    assert.strictEqual(res.status, 4);
    assert.deepStrictEqual(res.seq, [
      'GET /issue/KAN-1', 'GET /myself', 'GET /issue/KAN-1/comment', 'PUT /issue/KAN-1', 'GET /issue/KAN-1',
    ]);
    assert.deepStrictEqual(res.out.labelsAfter, ['project-test', 'ai-awaiting-merge']);
  });

  // ---- MINOR 9 — readback order --------------------------------------------------------------------

  test('m9: labels readback follows the labels write, status readback follows the transition', async () => {
    const res = await scenario({ prs: [] }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', 'In Review']);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(res.seq, [
      'GET /issue/KAN-1',               // initial read
      'PUT /issue/KAN-1',               // labels written
      'GET /issue/KAN-1',               // labels readback — after the write
      'POST /issue/KAN-1/transitions',  // transition
      'GET /issue/KAN-1',               // status readback — after the transition
    ]);
    assert.strictEqual(res.out.statusAfter, 'In Review');
  });

  test('m9: adopt path — readback of labels is the request right after the write', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [] }, adopt);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(res.seq, [
      'GET /issue/KAN-1', 'GET /myself', 'GET /issue/KAN-1/comment', 'PUT /issue/KAN-1', 'GET /issue/KAN-1',
    ]);
  });

  // ==== Round 3 ======================================================================================

  // ---- R4 (M3) — an unreadable `gh pr list` answer is not "no PR" -----------------------------------

  for (const [label, raw] of [['empty stdout', ''], ['<html> body', '<html>oops</html>'], ['{} (not a list)', '{}'], ['null', 'null'], ['a string', '"x"']]) {
    test('R4: gh pr list code 0 with ' + label + ' → code 6 source_unavailable, zero Jira writes, ai-ready kept', async () => {
      const res = await scenario({ prs: [], rawList: raw }, GOOD_BASE);
      assert.strictEqual(res.status, 6);
      assert.strictEqual(res.out.reason, 'source_unavailable');
      assert.strictEqual(res.out.state, 'source_unavailable');
      assert.strictEqual(res.out.success, false);
      assert.deepStrictEqual(writes(res), []);
      assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
    });
  }

  test('R4: unreadable gh pr list stops the --adopt-existing path as well → code 6, zero writes', async () => {
    const res = await scenario({ prs: [], rawList: '<html>oops</html>' }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('R4: control — a proper empty list means "no PR" → code 0 claimed, ai-ready removed', async () => {
    const res = await scenario({ prs: [], rawList: '[]' }, GOOD_BASE);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.out.reason, 'claimed');
    assert.deepStrictEqual(res.state.labels, ['project-test', 'review']);
  });

  // ---- R5 (M4) — a failed labels write is checked on both paths ----------------------------------------

  test('R5: labels write 500, normal path → code 7 mutation_failed; no readback, no transition', async () => {
    const res = await scenario({ prs: [], putCode: 500 }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', 'In Review']);
    assert.strictEqual(res.status, 7);
    assert.strictEqual(res.out.reason, 'mutation_failed');
    assert.strictEqual(res.out.state, 'mutation_failed');
    assert.deepStrictEqual(res.seq, ['GET /issue/KAN-1', 'PUT /issue/KAN-1']);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
    assert.strictEqual(res.state.status, 'To Do');
  });

  test('R5: labels write 500, --adopt-existing path → code 7 mutation_failed; no readback', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [], putCode: 500 }, adopt);
    assert.strictEqual(res.status, 7);
    assert.strictEqual(res.out.reason, 'mutation_failed');
    assert.strictEqual(res.out.state, 'mutation_failed');
    assert.strictEqual(res.out.success, false);
    assert.strictEqual(res.seq[res.seq.length - 1], 'PUT /issue/KAN-1', 'the failed PUT is the last Jira request');
    assert.strictEqual(res.seq.filter((s) => s.startsWith('PUT')).length, 1);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('R5: labels write 401, merged PR on the --adopt-existing path → code 6; nothing followed', async () => {
    const res = await scenario({ prs: [MERGED_PR], putCode: 401 }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.seq[res.seq.length - 1], 'PUT /issue/KAN-1');
    assert.ok(!res.seq.some((s) => s.startsWith('POST')), 'no transition');
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  // ---- R9 — coverage of already implemented behaviour ----------------------------------------------------

  test('R9: check-runs answer without a check_runs array → code 6, zero writes (not ci:false)', async () => {
    for (const raw of ['{"total_count":1}', '{"check_runs":"x"}', 'null']) {
      const res = await scenario({ prs: [OPEN_PR], comments: [accept()], raw }, adopt);
      assert.strictEqual(res.status, 6, raw);
      assert.strictEqual(res.out.reason, 'source_unavailable', raw);
      assert.deepStrictEqual(writes(res), [], raw);
      assert.deepStrictEqual(res.state.labels, INITIAL_LABELS, raw);
    }
  });

  test('R9: page ceiling reached (total_count above what is served) → code 6, 50 pages asked, zero writes', async () => {
    const res = await scenario({ prs: [OPEN_PR], comments: [accept()], endless: true }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.gh.filter((a) => a[0] === 'api').length, 50);
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('R9: 401 on the transition request → code 6; labels were written, status unchanged, no readback after it', async () => {
    const res = await scenario({ prs: [], postCode: 401 }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', 'In Review']);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(res.seq, ['GET /issue/KAN-1', 'PUT /issue/KAN-1', 'GET /issue/KAN-1', 'POST /issue/KAN-1/transitions']);
    assert.strictEqual(res.state.status, 'To Do');
  });

  // ---- Edge cases: missing check_runs field and bare-array fallback ----------------------------

  test('missing check_runs field → source_unavailable (code 6)', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 2 }, // check_runs is missing
      ],
    }, adopt);
    assert.strictEqual(res.status, 6);
    assert.strictEqual(res.out.reason, 'source_unavailable');
    assert.strictEqual(res.out.state, 'source_unavailable');
    assert.deepStrictEqual(writes(res), []);
    assert.deepStrictEqual(res.state.labels, INITIAL_LABELS);
  });

  test('pagination: single-page object form → collects check_runs from page 1', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 2, check_runs: [UBUNTU, WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
  });

  test('pagination: multi-page (page 1 has 2, page 2 has 1) → collects all, succeeds', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      pages: [
        { total_count: 3, check_runs: [UBUNTU, LINT] },
        { total_count: 3, check_runs: [WINDOWS] },
      ],
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
    assert.ok(res.gh.filter((a) => a[0] === 'api').length > 1, 'pagination was attempted');
  });

  test('R9: --expect-status ignores case and surrounding spaces → code 0', async () => {
    for (const expected of ['in review', '  IN REVIEW  ', ' In Review']) {
      const res = await scenario({ prs: [] }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', expected]);
      assert.strictEqual(res.status, 0, JSON.stringify(expected));
      assert.strictEqual(res.out.reason, 'claimed');
    }
    const res = await scenario({ prs: [], afterStatus: '  in review ' }, [...GOOD_BASE, '--transition-id', '5', '--expect-status', 'IN REVIEW']);
    assert.strictEqual(res.status, 0, 'actual status with spaces and another case');
  });

  for (const missing of ['dispatch', 'task', 'run']) {
    test('R9: verdict line without ' + missing + '= is ignored → review_pending', async () => {
      const ids = { dispatch: 'ctx_abc', task: 'task_abc', run: 'run_abc' };
      delete ids[missing];
      const body = 'AI-REVIEW-VERDICT: ACCEPT sha=' + HEAD + ' ' + Object.entries(ids).map(([k, v]) => k + '=' + v).join(' ');
      const res = await scenario({ prs: [OPEN_PR], comments: [{ id: '1', body, author: { accountId: ME } }] }, adopt);
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.out.state, 'review_pending');
      assert.strictEqual(res.out.mode, 'review');
      assert.notStrictEqual(res.out.readiness.verdictSha, HEAD);
    });
  }

  // ---- Edge cases: missing check_runs field and bare-array fallback ----------------------------

  test('bare array fallback: product accepts flat list → success', async () => {
    const res = await scenario({
      prs: [OPEN_PR], comments: [accept()],
      raw: JSON.stringify([UBUNTU, WINDOWS]),
    }, adopt);
    assert.strictEqual(res.status, 4);
    assert.strictEqual(res.out.state, 'awaiting_merge');
    assert.strictEqual(res.out.readiness.ci, true);
  });
});

// ==========================================================================
// R2 / R3.5 — unusable `gh pr view` answers and `mode` next to code 0
// ==========================================================================

describe('claim.js — gh pr view usability and mode (R2, R3.5)', () => {
  // gh stub: `pr list` answers PR_LIST, `pr view` prints VIEW_RAW verbatim (any text, incl. "null").
  async function adopt({ pr, viewRaw, comments = [], labels = ['project-test', 'ai-ready'], after = ['project-test', 'ai-in-review'], noPr = false }) {
    const gh = mkTempDir('claim-r2');
    const ghStub = path.join(gh, 'gh.js');
    fs.writeFileSync(ghStub, [
      'var a = process.argv.slice(2);',
      'if (a[0] === "pr" && a[1] === "list") process.stdout.write(process.env.R2_LIST);',
      'else if (a[0] === "pr" && a[1] === "view") process.stdout.write(process.env.R2_VIEW);',
      'else if (a[0] === "api") process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success" }] }));',
      'process.exit(0);',
    ].join('\n'));
    const calls = [];
    const { server: srv, close } = await startServer(async (req, res) => {
      calls.push(req.method + ' ' + req.url);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.endsWith('/comment')) { res.end(JSON.stringify({ comments })); return; }
        if (req.url.endsWith('/myself')) { res.end(JSON.stringify({ accountId: 'acc-1' })); return; }
        const mutated = calls.some((c) => c.startsWith('PUT'));
        res.end(JSON.stringify({ fields: { summary: 'S', status: { name: 'To Do' }, labels: mutated ? after : labels } }));
      } else {
        await drainBody(req);
        res.writeHead(204); res.end();
      }
    });
    const env = envForCli(gh, srv.address().port, ghStub);
    env.R2_LIST = JSON.stringify(noPr ? [] : [pr]);
    env.R2_VIEW = viewRaw === undefined ? '' : viewRaw;
    try {
      const r = await runSpawn(CLI, ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'Riniro/test', '--adopt-existing'], env, 15000);
      const writes = calls.filter((c) => c.startsWith('PUT') || c.startsWith('POST'));
      return { r, writes, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
    } finally { await close(); cleanup(gh); }
  }
  const OPEN = { number: 42, state: 'OPEN', title: '[KAN-1] x', url: 'https://gh.test/Riniro/test/pull/42' };
  const MERGED = { ...OPEN, state: 'MERGED' };

  function assertSourceUnavailable({ r, writes, out }) {
    assert.strictEqual(r.status, 6, r.stdout + r.stderr);
    assert.ok(out, 'stdout must be valid JSON');
    assert.strictEqual(out.state, 'source_unavailable');
    assert.strictEqual(out.success, false);
    assert.deepStrictEqual(writes, [], 'no Jira writes');
    assert.ok(!/TypeError/.test(r.stderr));
  }

  test('R2.1: body null (exit 0 of gh) → code 6 source_unavailable, valid JSON, zero Jira writes', async () => {
    assertSourceUnavailable(await adopt({ pr: OPEN, viewRaw: 'null' }));
  });
  test('R2.2: body is a list → code 6', async () => {
    assertSourceUnavailable(await adopt({ pr: OPEN, viewRaw: '[{"number":42,"state":"OPEN"}]' }));
  });
  test('R2.3a: body is a string → code 6', async () => {
    assertSourceUnavailable(await adopt({ pr: OPEN, viewRaw: '"OPEN"' }));
  });
  test('R2.3b: body is a number → code 6', async () => {
    assertSourceUnavailable(await adopt({ pr: OPEN, viewRaw: '42' }));
  });
  test('R2.4a: empty object {} for an open PR → code 6, neither awaiting_merge nor closing', async () => {
    const x = await adopt({ pr: OPEN, viewRaw: '{}' });
    assertSourceUnavailable(x);
    assert.ok(!['awaiting_merge', 'closing'].includes(x.out.state));
  });
  test('R2.4b: empty object {} for a merged PR → code 6, not closing', async () => {
    const x = await adopt({ pr: MERGED, viewRaw: '{}' });
    assertSourceUnavailable(x);
    assert.notStrictEqual(x.out.state, 'closing');
  });
  test('R2.5: object with number/state but no headRefOid, ACCEPT for some SHA → code 0 review_pending only', async () => {
    const { r, out } = await adopt({
      pr: OPEN,
      viewRaw: JSON.stringify({ number: 42, state: 'OPEN' }),
      comments: [{ id: '1', body: 'AI-REVIEW-VERDICT: ACCEPT sha=abc123def456 dispatch=ctx_abc task=task_abc run=run_abc', author: { accountId: 'acc-1' } }],
    });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(out.state, 'review_pending');
    assert.notStrictEqual(out.state, 'awaiting_merge');
    assert.strictEqual(out.readiness.headSha, null);
  });
  test('R2.6: object with headRefOid → previous path (open PR, no verdict → review_pending with headSha)', async () => {
    const { r, out } = await adopt({ pr: OPEN, viewRaw: JSON.stringify({ number: 42, state: 'OPEN', headRefOid: 'abc123def456' }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(out.state, 'review_pending');
    assert.strictEqual(out.readiness.headSha, 'abc123def456');
  });

  // R3.5: code 0 is read together with mode; a found PR never yields implement.
  test('R3.5a: PR not found → code 0, mode implement', async () => {
    const { r, out } = await adopt({ noPr: true, viewRaw: '' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(out.state, 'claimed');
    assert.strictEqual(out.mode, 'implement');
  });
  test('R3.5b: open PR → code 0, mode review, never implement', async () => {
    const { r, out } = await adopt({ pr: OPEN, viewRaw: JSON.stringify({ number: 42, state: 'OPEN', headRefOid: 'abc123def456' }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(out.mode, 'review');
    assert.ok(!r.stdout.includes('implement'));
  });
  test('R3.5c: merged PR → code 0, mode close, never implement', async () => {
    const { r, out } = await adopt({ pr: MERGED, after: ['project-test', 'ai-awaiting-merge'], viewRaw: JSON.stringify({ number: 42, state: 'MERGED', headRefOid: 'abc123def456' }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(out.mode, 'close');
    assert.ok(!r.stdout.includes('implement'));
  });
});

// ==========================================================================
// allRequiredChecksGreen — duplicate check-run name tests (KAN-22)
// ==========================================================================

describe('allRequiredChecksGreen — duplicate check-run names (KAN-22)', () => {
  var REQUIRED_UB = ['Tests (ubuntu-latest)'];

  function ub(o) {
    return { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', ...o };
  }

  // AC1: fresh failure, old success → false
  test('AC1: fresh failure + old success → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2024-01-01T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2024-01-02T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // AC2: fresh success, old failure → true
  test('AC2: fresh success + old failure → true', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2024-01-01T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2024-01-02T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), true);
  });

  // AC3: fresh in_progress, old success → false
  test('AC3: fresh in_progress + old success → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2024-01-01T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'in_progress', started_at: '2024-01-02T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // AC4: no completed_at / started_at — order in response decides; failure later → false
  test('AC4: no time fields, failure later in array → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // AC4b: no completed_at / started_at — success later → true
  test('AC4b: no time fields, success later in array → true', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), true);
  });

  // AC5: garbage time string → treated as no time, index decides
  test('AC5: garbage time string does not throw → index decides', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: 'garbage' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: 'garbage' },
    ];
    assert.doesNotThrow(() => allRequiredChecksGreen(runs, REQUIRED_UB));
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // AC6: required.length === 0 → false
  test('AC6: empty required → false', () => {
    assert.strictEqual(allRequiredChecksGreen([ub()], []), false);
  });

  // AC7: runs not an array → false
  test('AC7: runs not array → false', () => {
    assert.strictEqual(allRequiredChecksGreen(null, REQUIRED_UB), false);
  });

  // AC8: missing required check → false
  test('AC8: missing required check → false', () => {
    assert.strictEqual(allRequiredChecksGreen([], REQUIRED_UB), false);
  });

  // Test that mutation back to .some breaks this test
  test('mutation check: reverting to .some would pass AC1', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2024-01-01T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2024-01-02T00:00:00Z' },
    ];
    // Simulate old .some logic: any matching completed+success → true
    var oldLogic = REQUIRED_UB.every((name) => runs.some(
      (r) => r && r.name === name && r.status === 'completed' && r.conclusion === 'success'
    ));
    assert.strictEqual(oldLogic, true, 'old .some logic would incorrectly return true');
  });

  // KAN-22 round 2: array order OPPOSITE to timestamp order — time must win
  // (a) fresh failure first in array (earlier index), old success second → false
  test('T1: fresh failure (index 0, later time), old success (index 1, earlier time) → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // (b) fresh success first in array, old failure second → true
  test('T2: fresh success (index 0, later time), old failure (index 1, earlier time) → true', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2026-01-01T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), true);
  });

  // (c) fresh in_progress first in array, old completed/success second → false
  test('T3: fresh in_progress (index 0, later started_at), old completed/success (index 1) → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'in_progress', started_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  // (d) only started_at for both completed records, order opposite to time
  test('T4: only started_at, fresh failure first → false', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', started_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
  });

  test('T5: only started_at, fresh success first → true', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', started_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' },
    ];
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), true);
  });

  // Mutation-catch: stripping time comparison from isFresher should make T1-T5 fail
  test('mutation check: time-only ordering makes T1 pass while .some would fail T1', () => {
    var runs = [
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'failure', completed_at: '2026-01-02T00:00:00Z' },
      { name: 'Tests (ubuntu-latest)', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    ];
    // Current: fresh failure → false (correct)
    assert.strictEqual(allRequiredChecksGreen(runs, REQUIRED_UB), false);
    // Old .some: any success → true (wrong)
    var oldLogic = REQUIRED_UB.every((name) => runs.some(
      (r) => r && r.name === name && r.status === 'completed' && r.conclusion === 'success'
    ));
    assert.strictEqual(oldLogic, true, 'old .some logic would incorrectly return true for T1');
  });
});
