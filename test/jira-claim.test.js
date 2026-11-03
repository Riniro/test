import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    if (req.method !== 'POST') { resolve(); return; }
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

      // Issue, comments (verdict lookup), mutation, readback: in that order.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
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

      // Issue, comments (verdict lookup), mutation, readback: in that order.
      const calls = fs.readFileSync(jiraLog, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(calls.map((c) => c.method + ' ' + c.path), [
        'GET /rest/api/2/issue/KAN-1',
        'GET /rest/api/2/issue/KAN-1/comment',
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
      assert.strictEqual(out.state, 'review_pending');
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
      'process.stdout.write(JSON.stringify([{ number: 42, state: "MERGED", title: "[KAN-1] Fix bug", headRefOid: "abc123" }]) + "\\n");',
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
      'process.stdout.write(JSON.stringify([{ number: 42, state: "MERGED", title: "[KAN-1] Fix bug", headRefOid: "abc123" }]) + "\\n");',
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

  // ------------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------------
  after(() => {
    // This after hook runs after all tests; no temp dirs to clean
    // because each test cleans up in its own finally block.
  });
});
