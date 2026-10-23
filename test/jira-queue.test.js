import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { strict as assert } from 'node:assert';
import { describe, it, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLI = join(REPO_ROOT, 'tools', 'jira', 'queue.js');

// -- helpers ----------------------------------------------------------

function startServer(onRequest) {
  return new Promise((resolve, reject) => {
    const server = createServer(onRequest);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : null;
      resolve({ server, port, close: () => new Promise((res) => server.close(res)) });
    });
  });
}

function makeCredsFile(site) {
  const dir = mkdtempSync(join(tmpdir(), 'jira-queue-test-'));
  const credPath = join(dir, 'creds.json');
  writeFileSync(credPath, JSON.stringify({
    site,
    email: 'test@example.com',
    token: 'synthetic-token-12345',
  }), 'utf8');
  return { dir, credPath };
}

/**
 * Run queue.js via async spawn. Resolves with { status, stdout, stderr }.
 * Kills the process on timeout.
 */
function runQueueAsync(credPath, extraArgs = [], timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--project', 'KAN', '--labels', 'test', ...extraArgs], {
      cwd: REPO_ROOT,
      env: { ...process.env, JIRA_CREDENTIALS_FILE: credPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    // If child errors (e.g. ENOENT), treat as code null
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, stdout: '', stderr: '' });
    });
  });
}

// -- usage errors — код 2 -------------------------------------------

describe('queue.js — usage errors (code 2)', () => {
  it('no arguments → code 2', () => {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2);
  });

  it('--project missing → code 2', () => {
    const result = spawnSync(process.execPath, [CLI, '--labels', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2);
  });

  it('--labels missing → code 2', () => {
    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2);
  });

  it('empty string labels → code 2', () => {
    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN', '--labels', ''], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2);
  });

  it('comma-only labels → code 2', () => {
    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN', '--labels', ',,'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2);
  });
});

// -- exit code 0 — issue found (real queue.js) -----------------------

describe('queue.js — issue found (code 0)', () => {
  let server;
  let closeServer;
  let credPath;
  let tmpDir;

  after(async () => {
    // Order: kill child, close server, remove temp dir
    if (closeServer) {
      await closeServer();
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('prints JSON with found=true when server returns issues', async () => {
    const { dir, credPath: cp } = makeCredsFile('');
    credPath = cp;
    tmpDir = dir;

    const { server: s, close: cs } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issues: [{ key: 'KAN-1', fields: { summary: 'Found issue', status: { name: 'Open' }, labels: ['test'] } }],
      }));
    });
    server = s;
    closeServer = cs;

    const port = s.address().port;
    writeFileSync(credPath, JSON.stringify({
      site: `http://127.0.0.1:${port}`,
      email: 'test@example.com',
      token: 'synthetic-token-12345',
    }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.issue.key, 'KAN-1');
    assert.strictEqual(out.count, 1);
  });
});

// -- exit code 3 — empty queue (real queue.js) -----------------------

describe('queue.js — empty queue (code 3)', () => {
  let server;
  let closeServer;
  let credPath;
  let tmpDir;

  after(async () => {
    if (closeServer) await closeServer();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('returns code 3 when server returns empty issues array', async () => {
    const { dir, credPath: cp } = makeCredsFile('');
    credPath = cp;
    tmpDir = dir;

    const { server: s, close: cs } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    server = s;
    closeServer = cs;

    const port = s.address().port;
    writeFileSync(credPath, JSON.stringify({
      site: `http://127.0.0.1:${port}`,
      email: 'test@example.com',
      token: 'synthetic-token-12345',
    }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 3);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.issue, null);
    assert.strictEqual(out.count, 0);
  });
});

// -- exit code 4 — source unavailable (real queue.js) ----------------

describe('queue.js — source unavailable (code 4)', () => {
  let server;
  let closeServer;
  let credPath;
  let tmpDir;

  after(async () => {
    if (closeServer) await closeServer();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('returns code 4 on 401 Unauthorized', async () => {
    const { dir, credPath: cp } = makeCredsFile('');
    credPath = cp;
    tmpDir = dir;

    const { server: s, close: cs } = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    });
    server = s;
    closeServer = cs;

    const port = s.address().port;
    writeFileSync(credPath, JSON.stringify({
      site: `http://127.0.0.1:${port}`,
      email: 'test@example.com',
      token: 'bad-token',
    }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.issue, null);
    assert.strictEqual(out.count, 0);
  });

  it('returns code 4 when port is closed (connection refused)', async () => {
    // No server started — just write credentials pointing to a closed port.
    const { dir, credPath: cp } = makeCredsFile('http://127.0.0.1:1');
    credPath = cp;
    tmpDir = dir;

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.issue, null);
    assert.strictEqual(out.count, 0);
  });
});

// -- code 3 vs code 4 differentiation --------------------------------

describe('queue.js — empty vs unavailable distinction', () => {
  let closeEmpty;
  let closeUnavailable;
  let tmpDir1;
  let tmpDir2;

  after(async () => {
    if (closeEmpty) await closeEmpty();
    if (closeUnavailable) await closeUnavailable();
    if (tmpDir1) {
      try { rmSync(tmpDir1, { recursive: true, force: true }); } catch { /* */ }
    }
    if (tmpDir2) {
      try { rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('empty queue (code 3) and unavailable source (code 4) produce different exit codes', async () => {
    // Empty queue — code 3
    const { dir: dir1, credPath: cred1 } = makeCredsFile('');
    tmpDir1 = dir1;
    const { server: s1, close: cs1 } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ issues: [] }));
    });
    closeEmpty = cs1;

    const port1 = s1.address().port;
    writeFileSync(cred1, JSON.stringify({
      site: `http://127.0.0.1:${port1}`,
      email: 'test@example.com',
      token: 'synthetic-token-12345',
    }), 'utf8');

    const emptyResult = await runQueueAsync(cred1);
    assert.strictEqual(emptyResult.status, 3, 'empty queue should yield exit code 3');

    // Unavailable — code 4
    const { dir: dir2, credPath: cred2 } = makeCredsFile('');
    tmpDir2 = dir2;
    const { server: s2, close: cs2 } = await startServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
    closeUnavailable = cs2;

    const port2 = s2.address().port;
    writeFileSync(cred2, JSON.stringify({
      site: `http://127.0.0.1:${port2}`,
      email: 'test@example.com',
      token: 'synthetic-token-12345',
    }), 'utf8');

    const unavailableResult = await runQueueAsync(cred2);
    assert.strictEqual(unavailableResult.status, 4, 'server error should yield exit code 4');
  });
});

// -- stdout is only JSON ---------------------------------------------

describe('queue.js — stdout contains only JSON', () => {
  let server;
  let closeServer;
  let credPath;
  let tmpDir;

  after(async () => {
    if (closeServer) await closeServer();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('no stderr on success', async () => {
    const { dir, credPath: cp } = makeCredsFile('');
    credPath = cp;
    tmpDir = dir;

    const { server: s, close: cs } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issues: [{ key: 'KAN-1', fields: { summary: 'X', status: { name: 'Open' }, labels: ['test'] } }],
      }));
    });
    server = s;
    closeServer = cs;

    const port = s.address().port;
    writeFileSync(credPath, JSON.stringify({
      site: `http://127.0.0.1:${port}`,
      email: 'test@example.com',
      token: 'synthetic-token-12345',
    }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, '');
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, true);
  });
});

// -- token never leaks into error messages ---------------------------

describe('queue.js — token never leaks', () => {
  let server;
  let closeServer;
  let credPath;
  let tmpDir;

  after(async () => {
    if (closeServer) await closeServer();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('401 error message does not contain token', async () => {
    const { dir, credPath: cp } = makeCredsFile('');
    credPath = cp;
    tmpDir = dir;

    const { server: s, close: cs } = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    });
    server = s;
    closeServer = cs;

    const port = s.address().port;
    const secretToken = 'my-super-secret-token';
    writeFileSync(credPath, JSON.stringify({
      site: `http://127.0.0.1:${port}`,
      email: 'test@example.com',
      token: secretToken,
    }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 4);
    assert.ok(!result.stderr.includes(secretToken), 'stderr should not contain token');
    assert.ok(!result.stdout.includes(secretToken), 'stdout should not contain token');
  });
});

// -- credentials file errors → code 4 --------------------------------

describe('queue.js — credentials file errors (code 4)', () => {
  it('returns code 4 when credentials file is missing', () => {
    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN', '--labels', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { JIRA_CREDENTIALS_FILE: '/tmp/nonexistent-creds-abc123.json' },
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.issue, null);
    assert.strictEqual(out.count, 0);
  });

  it('returns code 4 when credentials file has invalid JSON', async () => {
    const { dir, credPath } = makeCredsFile('');

    writeFileSync(credPath, '{ not json', 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
  });

  it('returns code 4 when credentials file is missing required field', async () => {
    const { dir, credPath } = makeCredsFile('');
    writeFileSync(credPath, JSON.stringify({ site: 'http://x.com', email: 'x@x.com' }), 'utf8');

    const result = await runQueueAsync(credPath);

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
  });
});
