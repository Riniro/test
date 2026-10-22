import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import { loadRegistry } from '../tools/registry/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -- helpers -----------------------------------------------------------

function tmpRegistry(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  const filePath = path.join(dir, 'products.json');
  fs.writeFileSync(filePath, JSON.stringify(content), 'utf8');
  return { dir, filePath };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

// -- 12.  production file loads successfully ---------------------------

test('production products.json loads with one entry', () => {
  const base = path.resolve(__dirname, '..', 'tools', 'registry', 'products.json');
  // __dirname is test/, .. is project root, then tools/registry/
  const res = loadRegistry({ filePath: base });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.products.length, 1);
  const p = res.products[0];
  assert.strictEqual(p.label, 'project-test');
  assert.strictEqual(p.repo, 'Riniro/test');
});

// -- 13.  reason-code tests --------------------------------------------

test('MISSING when file does not exist', () => {
  const res = loadRegistry({ filePath: '/no/such/file.json' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'MISSING');
  assert.strictEqual(res.products, undefined);
});

test('CORRUPT when JSON cannot be parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  try {
    const filePath = path.join(dir, 'products.json');
    fs.writeFileSync(filePath, '{ bad json', 'utf8');
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'CORRUPT');
    assert.ok(res.detail && res.detail.length > 0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

test('UNSUPPORTED_VERSION when version is not 1', () => {
  const { dir, filePath } = tmpRegistry({ version: 2, products: [] });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'UNSUPPORTED_VERSION');
    assert.strictEqual(res.products, undefined);
  } finally { cleanup(dir); }
});

test('CORRUPT when products is not an array', () => {
  const { dir, filePath } = tmpRegistry({ version: 1, products: 'oops' });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'CORRUPT');
  } finally { cleanup(dir); }
});

test('DUPLICATE_PRODUCT_ID', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [
      { productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
      { productId: 'a', name: 'n2', label: 'project-b', repo: 'org/repo2', baseBranch: 'main', docsPath: 'docs2' },
    ],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'DUPLICATE_PRODUCT_ID');
    assert.strictEqual(res.products, undefined);
  } finally { cleanup(dir); }
});

test('DUPLICATE_LABEL (case-insensitive)', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [
      { productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
      { productId: 'b', name: 'n2', label: 'project-a', repo: 'org/repo2', baseBranch: 'main', docsPath: 'docs2' },
    ],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'DUPLICATE_LABEL');
    assert.strictEqual(res.products, undefined);
  } finally { cleanup(dir); }
});

// -- 14.  INVALID_ENTRY sub-tests --------------------------------------

test('INVALID_ENTRY for missing field', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('docsPath'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for empty string field', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: '', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('name'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for wrong type (number instead of string)', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 42, name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('productId'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for extra field', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs', extra: 'oops' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('extra'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for bad label', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'bad-label', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('label'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for bad repo', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'badrepo', baseBranch: 'main', docsPath: 'docs' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('repo'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for absolute docsPath (leading /)', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: '/absolute' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('docsPath'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for absolute docsPath (leading \\)', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: '\\absolute' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('docsPath'));
  } finally { cleanup(dir); }
});

test('INVALID_ENTRY for docsPath with segment ".."', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [{ productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'foo/../bar' }],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'INVALID_ENTRY');
    assert.ok(res.detail.includes('docsPath'));
  } finally { cleanup(dir); }
});

// -- 15.  no products field on duplicate label -------------------------

test('no products key when DUPLICATE_LABEL', () => {
  const { dir, filePath } = tmpRegistry({
    version: 1,
    products: [
      { productId: 'a', name: 'n', label: 'project-a', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
      { productId: 'b', name: 'n2', label: 'project-a', repo: 'org/repo2', baseBranch: 'main', docsPath: 'docs2' },
    ],
  });
  try {
    const res = loadRegistry({ filePath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'DUPLICATE_LABEL');
    assert.strictEqual(Object.hasOwn(res, 'products'), false);
  } finally { cleanup(dir); }
});
