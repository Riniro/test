#!/usr/bin/env node
/**
 * Stub wrapper — run by a child Node.js process via spawnSync.
 * Patches globalThis.fetch before importing any jira module,
 * then executes the queue-check logic in the same process
 * and exits with the correct code.
 *
 * Args: <mode> <project> <labels>
 *   mode: success | empty | stderr-test
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Build absolute path to client.js using new URL — resolves relative to this file,
// regardless of process.cwd().
const clientUrl = new URL('./client.js', import.meta.url);
const { searchByLabels, loadCredentials } = await import(clientUrl.href);

// -----------------------------------------------------------------------
// Parse args
// -----------------------------------------------------------------------
const raw = process.argv.slice(2);
if (raw.length < 3) {
  process.stderr.write('Usage: queue-stub-wrapper.mjs <mode> <project> <labels>\n');
  process.exitCode = 2;
  process.exit();
}

const mode = raw[0];
const project = raw[1];
const labelsStr = raw[2];

// -----------------------------------------------------------------------
// Set up stub response based on mode
// -----------------------------------------------------------------------
let stubResponse;
if (mode === 'success') {
  stubResponse = {
    issues: [
      {
        key: 'KAN-42',
        fields: {
          summary: 'Test issue',
          status: { name: 'Open' },
          labels: ['project-test', 'ai-ready'],
        },
      },
    ],
  };
} else if (mode === 'empty') {
  stubResponse = { issues: [] };
} else if (mode === 'stderr-test') {
  stubResponse = {
    issues: [{ key: 'KAN-1', fields: { summary: 'X', status: { name: 'Open' }, labels: ['a'] } }],
  };
} else {
  process.stderr.write('Unknown mode: ' + mode + '\n');
  process.exitCode = 2;
  process.exit();
}

// Patch fetch globally — all subsequent code sees this stub
globalThis.fetch = () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(stubResponse) });

// -----------------------------------------------------------------------
// Create temp creds file
// -----------------------------------------------------------------------
const credsDir = join(tmpdir(), 'jira-stub-' + Date.now() + '-' + Math.random().toString(36).slice(2));
mkdirSync(credsDir, { recursive: true });
const credPath = join(credsDir, 'creds.json');
writeFileSync(credPath, JSON.stringify({
  site: 'http://fake.example.com',
  email: 'x@x.com',
  token: 'token123',
}), 'utf8');

process.env.JIRA_CREDENTIALS_FILE = credPath;

// -----------------------------------------------------------------------
// Parse CLI args (mimics queue.js)
// -----------------------------------------------------------------------
const labels = labelsStr.split(',').map((l) => l.trim()).filter((l) => l.length > 0);

if (!project || project.length === 0 || labels.length === 0) {
  process.stderr.write('Usage: node queue.js --project <KEY> [--labels l1,l2] [--json]\n');
  process.exitCode = 2;
  process.exit();
}

try {
  const credsActual = loadCredentials(process.env);
  const issues = await searchByLabels({
    creds: credsActual,
    labels,
    project,
  });

  const issueOut = issues.length > 0
    ? { key: issues[0].key, summary: issues[0].summary, labels: issues[0].labels }
    : null;

  const out = {
    found: issues.length > 0,
    issue: issueOut,
    count: issues.length,
  };

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = issues.length > 0 ? 0 : 3;
} catch {
  const out = { found: false, issue: null, count: 0 };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = 4;
}

// Cleanup
try { rmSync(credsDir, { recursive: true, force: true }); } catch { /* */ }
