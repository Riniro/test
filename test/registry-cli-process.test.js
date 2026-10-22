import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'tools', 'registry', 'cli.js');

describe('registry CLI — route command', () => {
  describe('ROUTED', () => {
    it('ai-ready,project-test,mode-mvp → code 0, status ROUTED, product.repo === Riniro/test', () => {
      const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'ai-ready,project-test,mode-mvp'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.status, 'ROUTED');
      assert.strictEqual(out.product.repo, 'Riniro/test');
    });
  });

  describe('NEEDS_INPUT', () => {
    it('ai-ready,mode-mvp → code 3, status NEEDS_INPUT', () => {
      const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'ai-ready,mode-mvp'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 3);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.status, 'NEEDS_INPUT');
    });
  });

  describe('AMBIGUOUS', () => {
    it('project-test,project-other → code 4, status AMBIGUOUS, sorted projectLabels', () => {
      const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'project-test,project-other'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 4);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.status, 'AMBIGUOUS');
      assert.ok(Array.isArray(out.projectLabels));
      assert.strictEqual(out.projectLabels[0], 'project-other');
      assert.strictEqual(out.projectLabels[1], 'project-test');
    });
  });

  describe('NEEDS_REGISTRATION', () => {
    it('project-unknown → code 5, status NEEDS_REGISTRATION, label project-unknown', () => {
      const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'project-unknown'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 5);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.status, 'NEEDS_REGISTRATION');
      assert.strictEqual(out.label, 'project-unknown');
    });
  });

  describe('REGISTRY_ERROR', () => {
    it('битый JSON → код 6, status REGISTRY_ERROR, непустой reason', () => {
      const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
      try {
        writeFileSync(join(dir, 'bad.json'), '{ broken json!!!', 'utf8');
        const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'project-test', '--registry', join(dir, 'bad.json')], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        });
        assert.strictEqual(result.status, 6);
        const out = JSON.parse(result.stdout);
        assert.strictEqual(out.status, 'REGISTRY_ERROR');
        assert.ok(out.reason);
        assert.ok(out.reason.length > 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('USAGE errors — код 2', () => {
    it('без аргументов → код 2', () => {
      const result = spawnSync(process.execPath, [CLI], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.strictEqual(result.status, 2);
    });

    it('неизвестная команда → код 2', () => {
      const result = spawnSync(process.execPath, [CLI, 'foobar'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.strictEqual(result.status, 2);
    });
  });

  describe('stdout only JSON', () => {
    it('ROUTED stdout чистый JSON', () => {
      const result = spawnSync(process.execPath, [CLI, 'route', '--labels', 'ai-ready,project-test,mode-mvp'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.status);
    });
  });
});
