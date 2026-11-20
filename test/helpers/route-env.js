// Shared test environment for the coordinator route (precheck / start). Not a test: node --test finds
// no tests here and passes it.
//
// WHY THIS EXISTS. The coordinator tests inherit process.env. The machine has a real
// ~/.jira-coordinator.json. The stub gate is the only thing between a test and a LIVE Jira; if the
// stub is ever mis-wired, the real pickup.js/claim.js runs with the real credentials. Therefore every
// environment built here names JIRA_CREDENTIALS_FILE explicitly: a temp file with TEST values and a
// LOCAL address nobody listens on. A broken stub then fails safely (connection refused ->
// source_unavailable), it cannot reach a real service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A local address with no listener (port 1, tcpmux): connecting is refused at once. */
export const CLOSED_LOCAL_SITE = 'http://127.0.0.1:1';

let credsDir = null;
let credsPath = null;

/** A credentials file with TEST values and a closed local address. Created once per process. */
export function testCredentialsFile() {
  if (credsPath !== null && fs.existsSync(credsPath)) return credsPath;
  credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-creds-'));
  credsPath = path.join(credsDir, 'jira-creds.json');
  fs.writeFileSync(credsPath, JSON.stringify({ site: CLOSED_LOCAL_SITE, email: 'test@example.com', token: 'test-token-not-real' }), 'utf8');
  process.on('exit', () => { try { fs.rmSync(credsDir, { recursive: true, force: true }); } catch { /* gone */ } });
  return credsPath;
}

/** The credentials part of every test environment. */
export function safeCredentialsEnv() {
  return { JIRA_CREDENTIALS_FILE: testCredentialsFile() };
}

/** Stub pickup/claim/gh processes. They log how often (and with what) they were called. */
export function writeStubs(dir) {
  const pickup = path.join(dir, 'pickup-stub.mjs');
  const claim = path.join(dir, 'claim-stub.mjs');
  const gh = path.join(dir, 'gh-stub.mjs');
  fs.writeFileSync(pickup, [
    "import fs from 'node:fs';",
    "if (process.env.PK_LOG) fs.appendFileSync(process.env.PK_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "if (process.env.PK_KILL_PARENT) process.kill(process.ppid, process.env.PK_KILL_PARENT);",
    "process.stdout.write((process.env.PK_OUT || '') + '\\n');",
    'process.exit(Number(process.env.PK_CODE || 0));',
  ].join('\n'));
  fs.writeFileSync(claim, [
    "import fs from 'node:fs';",
    "if (process.env.CL_LOG) fs.appendFileSync(process.env.CL_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "if (process.env.CL_SABOTAGE_JOURNAL) { fs.rmSync(process.env.CL_SABOTAGE_JOURNAL, { force: true }); fs.mkdirSync(process.env.CL_SABOTAGE_JOURNAL); }",
    // The journal as the gate sees it when it is called: proves what was on disk BEFORE the gate.
    "if (process.env.CL_PEEK_JOURNAL) { let t; try { t = fs.readFileSync(process.env.CL_PEEK_JOURNAL, 'utf8'); } catch { t = 'UNREADABLE'; } fs.appendFileSync(process.env.CL_PEEK_OUT, t + '\\n'); }",
    // Models "the gate changed the labels": a file stands for the label change in Jira.
    "if (process.env.CL_MUTATE_MARK) fs.appendFileSync(process.env.CL_MUTATE_MARK, 'labels changed\\n');",
    // Models a gate that has reported the change and is then cut off: it publishes its pid and waits, BOUNDED
    // by CL_HANG_MS (default 15 s) so that it can never outlive a failed test for long.
    "if (process.env.CL_HANG_FILE) { fs.writeFileSync(process.env.CL_HANG_FILE, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CL_HANG_MS || 15000)); }",
    // Publishes the gate's own pid, so that a test can kill and check exactly this process.
    "if (process.env.CL_PID_FILE) fs.writeFileSync(process.env.CL_PID_FILE, String(process.pid));",
    // A gate whose output is larger than spawnSync's buffer (1 MiB): the parent gets ENOBUFS and no status.
    // Bounded: it ends by itself after 20 s even if nobody ever reads or kills it.
    "if (process.env.CL_BIG) { setTimeout(() => process.exit(0), 20000); process.stdout.write('x'.repeat(3 * 1024 * 1024), () => process.exit(0)); }",
    // A gate that dies without an answer.
    "if (process.env.CL_SELF_KILL) process.kill(process.pid, 'SIGKILL');",
    "if (!process.env.CL_BIG) { process.stdout.write((process.env.CL_OUT || '') + '\\n'); process.exit(Number(process.env.CL_CODE || 0)); }",
  ].join('\n'));
  fs.writeFileSync(gh, [
    "import fs from 'node:fs';",
    'const a = process.argv.slice(2);',
    "if (process.env.GH_LOG) fs.appendFileSync(process.env.GH_LOG, a.join(' ') + '\\n');",
    "if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write(process.env.GH_LIST || '[]'); process.exit(Number(process.env.GH_LIST_CODE || 0)); }",
    "if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(process.env.GH_VIEW || '{}'); process.exit(Number(process.env.GH_VIEW_CODE || 0)); }",
    'process.exit(99);',
  ].join('\n'));
  return { pickup, claim, gh };
}

const PR_URL = 'https://gh.test/o/r/pull/42';
const MODE_TO_REASON = { implement: 'ready', review: 'review', close: 'closing' };

/**
 * What the LIVE re-read (pickup + PR lookup) returns. By default it mirrors the candidate, so the
 * re-read agrees; a test changes one field to make it disagree.
 * @param {string} dir scratch directory for the stubs and their logs
 * @param {{ issue?: string, mode?: string, reason?: string, pr?: null | { number: number, url?: string, headSha: string | null },
 *           prState?: string, pkCode?: number, pkOut?: string, extra?: object }} live
 */
export function liveEnv(dir, live = {}) {
  const stubs = writeStubs(dir);
  const issue = live.issue || 'KAN-14';
  const mode = live.mode || 'implement';
  const reason = live.reason || MODE_TO_REASON[mode];
  const pr = live.pr === undefined ? null : live.pr;
  const prState = live.prState || (mode === 'close' ? 'MERGED' : 'OPEN');
  const list = pr === null ? [] : [{ number: pr.number, state: prState, title: `[${issue}] work`, url: pr.url || PR_URL }];
  const view = pr === null ? {} : { number: pr.number, state: prState, ...(pr.headSha ? { headRefOid: pr.headSha } : {}) };
  return {
    ...safeCredentialsEnv(),
    PRECHECK_PICKUP_SCRIPT: stubs.pickup,
    PICKUP_GH_EXEC: stubs.gh,
    PICKUP_GH_PREFIX_ARGS_JSON: JSON.stringify([process.execPath]),
    PK_CODE: String(live.pkCode === undefined ? 0 : live.pkCode),
    PK_OUT: live.pkOut === undefined ? JSON.stringify({ work: true, reason, issue: { key: issue }, pr: null, counts: {} }) : live.pkOut,
    PK_LOG: path.join(dir, 'pickup.log'),
    GH_LIST: JSON.stringify(list),
    GH_VIEW: JSON.stringify(view),
    GH_LOG: path.join(dir, 'gh.log'),
    ...(live.extra || {}),
  };
}

/** The live data that agrees with a candidate record. */
export function liveOfCandidate(candidate) {
  if (!candidate) return {};
  return { issue: candidate.issueKey, mode: candidate.mode, pr: candidate.pr || null };
}
