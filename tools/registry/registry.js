import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_FIELDS = [
  'productId',
  'name',
  'label',
  'repo',
  'baseBranch',
  'docsPath',
];

const LABEL_RE = /^project-[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function validateDocsPath(value) {
  if (value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') {
      return false;
    }
  }
  return true;
}

export function loadRegistry({ filePath }) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'MISSING' };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'CORRUPT', detail: err.message };
  }

  if (typeof data.version !== 'number' || data.version !== 1) {
    return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  }

  if (!Array.isArray(data.products)) {
    return { ok: false, reason: 'CORRUPT' };
  }

  const seenProductIds = new Map();
  const seenLabels = new Map();
  const validated = [];

  for (let i = 0; i < data.products.length; i++) {
    const entry = data.products[i];

    const keys = Object.keys(entry);
    if (keys.length !== REQUIRED_FIELDS.length || !REQUIRED_FIELDS.every(k => keys.includes(k))) {
      let badField = null;
      if (keys.length !== REQUIRED_FIELDS.length) {
        const missing = REQUIRED_FIELDS.filter(f => !keys.includes(f));
        const extra = keys.filter(f => !REQUIRED_FIELDS.includes(f));
        badField = missing.length ? missing[0] : extra[0];
      } else {
        badField = REQUIRED_FIELDS[0];
      }
      return { ok: false, reason: 'INVALID_ENTRY', detail: `entry ${i}, field "${badField}"` };
    }

    for (const field of REQUIRED_FIELDS) {
      const val = entry[field];
      if (typeof val !== 'string' || val.length === 0) {
        return { ok: false, reason: 'INVALID_ENTRY', detail: `entry ${i}, field "${field}"` };
      }
    }

    if (!LABEL_RE.test(entry.label)) {
      return { ok: false, reason: 'INVALID_ENTRY', detail: `entry ${i}, field "label"` };
    }

    if (!REPO_RE.test(entry.repo)) {
      return { ok: false, reason: 'INVALID_ENTRY', detail: `entry ${i}, field "repo"` };
    }

    if (!validateDocsPath(entry.docsPath)) {
      return { ok: false, reason: 'INVALID_ENTRY', detail: `entry ${i}, field "docsPath"` };
    }

    if (seenProductIds.has(entry.productId)) {
      return { ok: false, reason: 'DUPLICATE_PRODUCT_ID', detail: `productId "${entry.productId}"` };
    }
    seenProductIds.set(entry.productId, i);

    const labelKey = entry.label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return { ok: false, reason: 'DUPLICATE_LABEL', detail: `label "${entry.label}"` };
    }
    seenLabels.set(labelKey, i);

    validated.push(entry);
  }

  return { ok: true, products: validated };
}
