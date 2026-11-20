// claim.js must SAY whether it attempted a mutation (contract: "Исполняемый маршрут запуска").
// The exit code cannot say it: 6 is returned before any change (the PR source is down) AND after one
// (the status transition fails when the labels are already changed). The route relies on this field
// alone to decide whether a claim attempt may be dropped.
//
// Local stubs only: a Jira server on 127.0.0.1 and a gh stub. Nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const CLAIM = path.join(REPO_ROOT, 'tools', 'jira', 'claim.js');

const OPEN_PR = { number: 42, state: 'OPEN', title: '[KAN-1] Fix bug', url: 'https://gh.test/o/r/pull/42' };
const BASE = ['--project', 'KAN', '--issue', 'KAN-1', '--repo', 'o/r'];

function drain(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/**
 * cfg: labels, prs, ghListFails, putCode (status for PUT), putApplies (default true), postCode, issueCode.
 * Returns { status, out, state, writes } where writes are the Jira requests that are not GET.
 */
async function run(cfg, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-flag-'));
  const gh = path.join(dir, 'gh.js');
  fs.writeFileSync(gh, [
    'var a = process.argv.slice(2);',
    `var cfg = ${JSON.stringify({ prs: cfg.prs || [], fail: !!cfg.ghListFails })};`,
    'if (a[0] === "pr" && a[1] === "list") { if (cfg.fail) process.exit(1); process.stdout.write(JSON.stringify(cfg.prs)); process.exit(0); }',
    'if (a[0] === "pr" && a[1] === "view") { process.stdout.write(JSON.stringify({ number: 42, state: "OPEN", headRefOid: "' + 'a'.repeat(40) + '" })); process.exit(0); }',
    'process.stdout.write("[]");',
  ].join('\n'));
  const state = { labels: (cfg.labels || ['project-test', 'ai-ready']).slice(), status: 'To Do' };
  const writes = [];
  const server = createServer(async (req, res) => {
    const body = await drain(req);
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') {
      if (req.url.endsWith('/myself')) return json(200, { accountId: 'me' });
      if (req.url.endsWith('/comment')) return json(200, { comments: [] });
      if (cfg.issueCode >= 400) return json(cfg.issueCode, {});
      return json(200, { fields: { summary: 'S', status: { name: state.status }, labels: state.labels } });
    }
    writes.push(req.method + ' ' + req.url.split('?')[0]);
    if (req.method === 'PUT') {
      if (cfg.putCode >= 400) return json(cfg.putCode, {});
      if (cfg.putApplies !== false) { try { state.labels = JSON.parse(body).fields.labels; } catch { /* keep */ } }
      res.writeHead(204); res.end(); return;
    }
    if (cfg.postCode >= 400) return json(cfg.postCode, {});
    state.status = 'In Review';
    res.writeHead(204); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const creds = path.join(dir, 'creds.json');
  fs.writeFileSync(creds, JSON.stringify({ site: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', token: 'tok-123' }));
  const env = {
    ...process.env, JIRA_CREDENTIALS_FILE: creds,
    PICKUP_GH_EXEC: gh, PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
  };
  try {
    const r = await new Promise((resolve) => {
      exec(`"${process.execPath}" "${CLAIM}" ${args.map((a) => JSON.stringify(a)).join(' ')}`,
        { cwd: REPO_ROOT, env, timeout: 20000 }, (err, stdout) => resolve({ status: err ? err.code : 0, stdout: stdout || '' }));
    });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* not json */ }
    return { status: r.status, out, state, writes };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NO_MUTATION = [
  ['issue not found (2)', { issueCode: 404 }, BASE, 2],
  ['labels carry no ai-ready (3)', { labels: ['project-test'] }, BASE, 3],
  ['task blocked (3)', { labels: ['project-test', 'ai-blocked', 'ai-ready'] }, BASE, 3],
  ['a PR exists and --adopt-existing is not given (4)', { prs: [OPEN_PR] }, BASE, 4],
  ['gh pr list is down (6): code 6 BEFORE any change', { ghListFails: true }, BASE, 6],
];

for (const [name, cfg, args, code] of NO_MUTATION) {
  test(`claim.js states mutationAttempted:false when it refused before any change — ${name}`, async () => {
    const res = await run(cfg, args);
    assert.equal(res.status, code, JSON.stringify(res.out));
    assert.strictEqual(res.out.mutationAttempted, false);
    assert.deepStrictEqual(res.writes, [], 'premise: the gate really wrote nothing');
  });
}

const MUTATION = [
  // The labels request went out and was refused: it WAS attempted, even though nothing changed.
  ['labels PUT refused with 401 (6): code 6 AFTER the attempt', { putCode: 401 }, BASE, 6],
  ['labels PUT fails with 500 (7)', { putCode: 500 }, BASE, 7],
  ['labels PUT accepted but the read-back shows no change (5)', { putApplies: false }, BASE, 5],
  // The labels ARE changed, then the transition fails: 6 and 7 again, both after a real mutation.
  ['transition refused with 401 after the labels changed (6)', { postCode: 401 }, [...BASE, '--transition-id', '5', '--expect-status', 'In Review'], 6],
  ['transition fails with 500 after the labels changed (7)', { postCode: 500 }, [...BASE, '--transition-id', '5', '--expect-status', 'In Review'], 7],
];

// The same on the --adopt-existing path (an open PR, no verdict yet: the labels move to ai-in-review).
// This path has its own label request; the bench showed that without these rows its flag was not covered.
const ADOPT = [...BASE, '--adopt-existing'];
MUTATION.push(
  ['adopt path: labels PUT refused with 401 (6)', { prs: [OPEN_PR], putCode: 401 }, ADOPT, 6],
  ['adopt path: labels PUT fails with 500 (7)', { prs: [OPEN_PR], putCode: 500 }, ADOPT, 7],
  ['adopt path: labels PUT accepted but the read-back shows no change (5)', { prs: [OPEN_PR], putApplies: false }, ADOPT, 5],
);

for (const [name, cfg, args, code] of MUTATION) {
  test(`claim.js states mutationAttempted:true once a change was attempted — ${name}`, async () => {
    const res = await run(cfg, args);
    assert.equal(res.status, code, JSON.stringify(res.out));
    assert.strictEqual(res.out.mutationAttempted, true);
    assert.ok(res.writes.length >= 1, 'premise: the gate really sent a write');
  });
}

test('claim.js: the same exit code 6 carries both answers — only the field tells them apart', async () => {
  const before = await run({ ghListFails: true }, BASE);
  const after = await run({ postCode: 401 }, [...BASE, '--transition-id', '5', '--expect-status', 'In Review']);
  assert.equal(before.status, 6);
  assert.equal(after.status, 6);
  assert.deepStrictEqual([before.out.mutationAttempted, after.out.mutationAttempted], [false, true]);
});

test('claim.js: a successful claim states mutationAttempted:true and keeps its existing fields', async () => {
  const res = await run({}, BASE);
  assert.equal(res.status, 0, JSON.stringify(res.out));
  assert.strictEqual(res.out.mutationAttempted, true);
  for (const k of ['success', 'reason', 'state', 'mode', 'key', 'labelsBefore', 'labelsAfter', 'pr']) {
    assert.ok(k in res.out, 'the existing field is kept: ' + k);
  }
});
