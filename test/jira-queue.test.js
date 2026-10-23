import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'tools', 'jira', 'queue.js');
const WRAPPER = join(REPO_ROOT, 'tools', 'jira', 'queue-stub-wrapper.mjs');

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
});

// -- exit code 4 — source unavailable --------------------------------

describe('queue.js — source unavailable (code 4)', () => {
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

  it('returns code 4 when credentials file has invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-queue-test-'));
    const credPath = join(dir, 'bad.json');
    writeFileSync(credPath, '{ not json', 'utf8');

    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN', '--labels', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { JIRA_CREDENTIALS_FILE: credPath },
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns code 4 when credentials file is missing required field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-queue-test-'));
    const credPath = join(dir, 'bad.json');
    writeFileSync(credPath, JSON.stringify({ site: 'http://x.com', email: 'x@x.com' }), 'utf8');

    const result = spawnSync(process.execPath, [CLI, '--project', 'KAN', '--labels', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { JIRA_CREDENTIALS_FILE: credPath },
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 4);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// -- exit code 0 — issue found (via stub wrapper) ---------------------

describe('queue.js — stubbed success (code 0)', () => {
  it('prints JSON with found=true when issues exist', () => {
    const result = spawnSync(process.execPath, [WRAPPER, 'success', 'KAN', 'project-test,ai-ready'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.issue.key, 'KAN-42');
    assert.strictEqual(out.issue.summary, 'Test issue');
    assert.ok(Array.isArray(out.issue.labels));
  });
});

// -- exit code 3 — empty queue (via stub wrapper) ---------------------

describe('queue.js — empty queue (code 3)', () => {
  it('returns code 3 when no issues match', () => {
    const result = spawnSync(process.execPath, [WRAPPER, 'empty', 'KAN', 'nonexistent-tag'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 3);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, false);
    assert.strictEqual(out.issue, null);
    assert.strictEqual(out.count, 0);
  });
});

// -- stdout is only JSON ---------------------------------------------

describe('queue.js — stdout contains only JSON', () => {
  it('no stderr on success', () => {
    const result = spawnSync(process.execPath, [WRAPPER, 'stderr-test', 'KAN', 'a'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, '');
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.found, true);
  });
});

// -- empty labels give code 2 ----------------------------------------

describe('queue.js — empty labels (code 2)', () => {
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
