import { test } from 'node:test';
import assert from 'node:assert';
import { route } from '../tools/registry/route.js';

// ---------------------------------------------------------------------------
// 13. По тесту на каждый из четырёх исходов
// ---------------------------------------------------------------------------

test('ROUTED — single project label matches a product', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-alpha'], products });
  assert.deepStrictEqual(result, { status: 'ROUTED', product: products[0] });
});

test('NEEDS_REGISTRATION — single project label not in products', () => {
  const products = [];
  const result = route({ labels: ['project-unknown'], products });
  assert.deepStrictEqual(result, { status: 'NEEDS_REGISTRATION', label: 'project-unknown' });
});

test('AMBIGUOUS — two different project labels', () => {
  const products = [];
  const result = route({ labels: ['project-beta', 'project-alpha'], products });
  assert.strictEqual(result.status, 'AMBIGUOUS');
  assert.deepStrictEqual(result.projectLabels, ['project-alpha', 'project-beta']);
  assert.strictEqual(result.product, undefined);
});

test('NEEDS_INPUT — no project labels at all', () => {
  const products = [];
  const result = route({ labels: ['ai-ready', 'mode-mvp'], products });
  assert.deepStrictEqual(result, { status: 'NEEDS_INPUT' });
});

// ---------------------------------------------------------------------------
// 14. Служебные метки игнорируются
// ---------------------------------------------------------------------------

test('service labels ignored: [ai-ready, mode-mvp, project-test] → ROUTED', () => {
  const products = [
    { productId: 't', name: 'Test', label: 'project-test', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['ai-ready', 'mode-mvp', 'project-test'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.strictEqual(result.product, products[0]);
  assert.strictEqual(result.projectLabels, undefined);
  assert.strictEqual(result.label, undefined);
});

// ---------------------------------------------------------------------------
// 15. Только служебные метки → NEEDS_INPUT
// ---------------------------------------------------------------------------

test('only service labels → NEEDS_INPUT', () => {
  const products = [];
  const result = route({ labels: ['ai-ready', 'mode-mvp'], products });
  assert.deepStrictEqual(result, { status: 'NEEDS_INPUT' });
});

// ---------------------------------------------------------------------------
// 16. Две разные проектные метки → AMBIGUOUS, projectLabels отсортирован
// ---------------------------------------------------------------------------

test('two different project labels → AMBIGUOUS with sorted projectLabels', () => {
  const products = [];
  const result = route({ labels: ['project-zeta', 'project-alpha'], products });
  assert.strictEqual(result.status, 'AMBIGUOUS');
  assert.deepStrictEqual(result.projectLabels, ['project-alpha', 'project-zeta']);
});

// ---------------------------------------------------------------------------
// 17. Одна зарегистрированная и одна незарегистрированная → AMBIGUOUS
// ---------------------------------------------------------------------------

test('one registered + one unregistered project label → AMBIGUOUS, not ROUTED', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-alpha', 'project-unknown'], products });
  assert.strictEqual(result.status, 'AMBIGUOUS');
  assert.deepStrictEqual(result.projectLabels, ['project-alpha', 'project-unknown']);
  assert.strictEqual(result.product, undefined);
});

// ---------------------------------------------------------------------------
// 18. Повтор одной метки → ROUTED
// ---------------------------------------------------------------------------

test('duplicate project label → ROUTED, not AMBIGUOUS', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-alpha', 'project-alpha'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.strictEqual(result.product, products[0]);
  assert.strictEqual(result.projectLabels, undefined);
});

// ---------------------------------------------------------------------------
// 19. Перестановка входного массива даёт тот же результат
// ---------------------------------------------------------------------------

test('input permutation produces same result', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
    { productId: 'b', name: 'Beta', label: 'project-beta', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];

  const r1 = route({ labels: ['project-alpha', 'project-beta'], products });
  const r2 = route({ labels: ['project-beta', 'project-alpha'], products });
  const r3 = route({ labels: ['project-beta', 'project-beta', 'project-alpha'], products });

  assert.strictEqual(r1.status, 'AMBIGUOUS');
  assert.deepStrictEqual(r1.projectLabels, r2.projectLabels);
  assert.deepStrictEqual(r1.projectLabels, r3.projectLabels);
});

test('input permutation produces same ROUTED result', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const r1 = route({ labels: ['project-alpha'], products });
  const r2 = route({ labels: ['project-alpha', 'project-alpha'], products });
  assert.deepStrictEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// 20. TypeError на не-массиве labels, на элементе не-строке, на не-массиве products
// ---------------------------------------------------------------------------

test('TypeError when labels is not an array', () => {
  assert.throws(() => route({ labels: 'not-array', products: [] }), TypeError);
});

test('TypeError when labels contains non-string', () => {
  assert.throws(() => route({ labels: ['project-alpha', 42], products: [] }), TypeError);
});

test('TypeError when products is not an array', () => {
  assert.throws(() => route({ labels: [], products: 'not-array' }), TypeError);
});

// ---------------------------------------------------------------------------
// 21. Входные массивы не изменились после вызова
// ---------------------------------------------------------------------------

test('input arrays are not mutated', () => {
  const labels = ['project-alpha', 'project-beta'];
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];

  const labelsCopy = [...labels];
  const productsCopy = products.map((p) => ({ ...p }));

  route({ labels, products });

  assert.deepStrictEqual(labels, labelsCopy);
  assert.deepStrictEqual(products, productsCopy);
});

// ---------------------------------------------------------------------------
// Acceptance 1-5: field presence / absence in each status
// ---------------------------------------------------------------------------

test('ROUTED contains product, no label, no projectLabels', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-alpha'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.ok(Object.hasOwn(result, 'product'));
  assert.strictEqual(Object.hasOwn(result, 'label'), false);
  assert.strictEqual(Object.hasOwn(result, 'projectLabels'), false);
});

test('NEEDS_REGISTRATION contains label, no product, no projectLabels', () => {
  const result = route({ labels: ['project-unknown'], products: [] });
  assert.strictEqual(result.status, 'NEEDS_REGISTRATION');
  assert.ok(Object.hasOwn(result, 'label'));
  assert.strictEqual(Object.hasOwn(result, 'product'), false);
  assert.strictEqual(Object.hasOwn(result, 'projectLabels'), false);
});

test('AMBIGUOUS contains projectLabels, no product, no label', () => {
  const result = route({ labels: ['project-alpha', 'project-beta'], products: [] });
  assert.strictEqual(result.status, 'AMBIGUOUS');
  assert.ok(Object.hasOwn(result, 'projectLabels'));
  assert.strictEqual(Object.hasOwn(result, 'product'), false);
  assert.strictEqual(Object.hasOwn(result, 'label'), false);
});

test('NEEDS_INPUT contains no product, label, or projectLabels', () => {
  const result = route({ labels: ['ai-ready'], products: [] });
  assert.strictEqual(result.status, 'NEEDS_INPUT');
  assert.strictEqual(Object.hasOwn(result, 'product'), false);
  assert.strictEqual(Object.hasOwn(result, 'label'), false);
  assert.strictEqual(Object.hasOwn(result, 'projectLabels'), false);
});

// ---------------------------------------------------------------------------
// Acceptance 8: case-insensitive matching
// ---------------------------------------------------------------------------

test('case-insensitive label matching', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'Project-Alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-alpha'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.strictEqual(result.product, products[0]);
});

// ---------------------------------------------------------------------------
// Acceptance 10: empty products array with single project label → NEEDS_REGISTRATION
// ---------------------------------------------------------------------------

test('empty products with one project label → NEEDS_REGISTRATION', () => {
  const result = route({ labels: ['project-alpha'], products: [] });
  assert.deepStrictEqual(result, { status: 'NEEDS_REGISTRATION', label: 'project-alpha' });
});

// ---------------------------------------------------------------------------
// Acceptance 11: function does not mutate inputs
// ---------------------------------------------------------------------------

test('product objects inside products array are not mutated', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const proto = JSON.stringify(products[0]);
  route({ labels: ['project-alpha'], products });
  assert.strictEqual(JSON.stringify(products[0]), proto);
});

// ---------------------------------------------------------------------------
// Acceptance 12: module prints nothing to stdout/stderr
// ---------------------------------------------------------------------------

test('module produces no console output', () => {
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    route({ labels: ['project-alpha'], products: [] });
    assert.strictEqual(logs.length, 0);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

// ---------------------------------------------------------------------------
// Acceptance 6-10: case-insensitive project label detection (KAN-7-B2)
// ---------------------------------------------------------------------------

test('["Project-TEST"] with registry "project-test" → ROUTED', () => {
  const products = [
    { productId: 't', name: 'Test', label: 'project-test', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['Project-TEST'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.strictEqual(result.product, products[0]);
});

test('["project-test","Project-TEST"] → ROUTED, not AMBIGUOUS', () => {
  const products = [
    { productId: 't', name: 'Test', label: 'project-test', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['project-test', 'Project-TEST'], products });
  assert.strictEqual(result.status, 'ROUTED');
  assert.strictEqual(result.product, products[0]);
  assert.strictEqual(result.projectLabels, undefined);
});

test('["PROJECT-unknown"] → NEEDS_REGISTRATION with original casing', () => {
  const result = route({ labels: ['PROJECT-unknown'], products: [] });
  assert.strictEqual(result.status, 'NEEDS_REGISTRATION');
  assert.strictEqual(result.label, 'PROJECT-unknown');
});

test('["Project-alpha","project-beta"] → AMBIGUOUS with original casings', () => {
  const result = route({ labels: ['Project-alpha', 'project-beta'], products: [] });
  assert.strictEqual(result.status, 'AMBIGUOUS');
  assert.deepStrictEqual(result.projectLabels, ['Project-alpha', 'project-beta']);
});

test('service labels like "ai-ready" are still ignored regardless of case', () => {
  const products = [
    { productId: 'a', name: 'Alpha', label: 'project-alpha', repo: 'org/repo', baseBranch: 'main', docsPath: 'docs' },
  ];
  const result = route({ labels: ['ai-ready', 'AI-READY'], products });
  assert.deepStrictEqual(result, { status: 'NEEDS_INPUT' });
});
