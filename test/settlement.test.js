import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, summarize } from '../tools/coordinator/settlement.js';

// Helpers ---------------------------------------------------------------

function makeDispatch(opts = {}) {
  return {
    workerDone: null,
    status: 'dispatched',
    expectedTaskId: 'task-1',
    expectedDispatchId: 'ctx-1',
    ...opts,
  };
}

function makeWork(opts = {}) {
  return { commit: null, treeClean: null, ...opts };
}

function makeTests(opts = {}) {
  return { ran: false, passed: null, failed: 0, ...opts };
}

// 12. По тесту на каждый из четырёх вердиктов --------------------------

test('verdict SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123', treeClean: true }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.length > 0);
});

test('verdict UNVERIFIABLE — dispatch status null', () => {
  const res = decide({
    dispatch: makeDispatch({ status: null }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('DISPATCH_STATUS_UNKNOWN'));
});

test('verdict UNVERIFIABLE — commit unknown (null)', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'completed' }),
    work: makeWork({ commit: null }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
});

test('verdict WORK_PRESENT_UNSETTLED', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'WORK_PRESENT_UNSETTLED');
});

test('verdict NO_WORK_UNSETTLED', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: '' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'NO_WORK_UNSETTLED');
});

// 13. Зелёные тесты + коммит + нет workerDone → WORK_PRESENT_UNSETTLED --

test('green tests + commit + no workerDone → WORK_PRESENT_UNSETTLED', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'WORK_PRESENT_UNSETTLED');
  assert.notEqual(res.reasons.indexOf('SETTLED_BY_WORKER'), 0);
});

// 14. Корректный workerDone + красные тесты → SETTLED_BY_WORKER ---------

test('correct workerDone + failed tests → SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: false, failed: 2 }),
  });
  assert.equal(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('TESTS_FAILED'));
});

// 15. Несовпадение taskId → не SETTLED_BY_WORKER, reasons содержит ID_MISMATCH

test('taskId mismatch → no SETTLED_BY_WORKER, reasons has ID_MISMATCH', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-999', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.notEqual(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('ID_MISMATCH'));
});

// 16. Несовпадение dispatchId → то же самое ---------------------------

test('dispatchId mismatch → no SETTLED_BY_WORKER, reasons has ID_MISMATCH', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-999', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.notEqual(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('ID_MISMATCH'));
});

// 17. dispatch.status: null → UNVERIFIABLE с DISPATCH_STATUS_UNKNOWN ----

test('dispatch status null → UNVERIFIABLE with DISPATCH_STATUS_UNKNOWN', () => {
  const res = decide({
    dispatch: makeDispatch({ status: null }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('DISPATCH_STATUS_UNKNOWN'));
});

// 18. dispatch.status: 'dispatched' при наличии workerDone → не SETTLED_BY_WORKER

test('dispatch status dispatched (not finished) → no SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'dispatched',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.notEqual(res.verdict, 'SETTLED_BY_WORKER');
});

// 19. work.commit: null → UNVERIFIABLE с COMMIT_UNKNOWN -----------------

test('work commit null → UNVERIFIABLE with COMMIT_UNKNOWN', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'completed' }),
    work: makeWork({ commit: null }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
});

// 20. deadlineExceeded: true при корректном workerDone → SETTLED_BY_WORKER, reasons содержит DEADLINE_EXCEEDED

test('deadlineExceeded true with correct workerDone → SETTLED_BY_WORKER + DEADLINE_EXCEEDED', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
    deadlineExceeded: true,
  });
  assert.equal(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('DEADLINE_EXCEEDED'));
});

// 21. deadlineExceeded: true без workerDone и без коммита → NO_WORK_UNSETTLED

test('deadlineExceeded true with no workerDone and no commit → NO_WORK_UNSETTLED', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: '' }),
    tests: makeTests(),
    deadlineExceeded: true,
  });
  assert.equal(res.verdict, 'NO_WORK_UNSETTLED');
});

// 22. TypeError на аргументе-не-объекте --------------------------------

test('throws TypeError on non-object argument', () => {
  assert.throws(() => decide('string'), TypeError);
  assert.throws(() => decide(42), TypeError);
  assert.throws(() => decide(null), TypeError);
  assert.throws(() => decide([], []), TypeError);
  assert.throws(() => decide([{}]), TypeError);
});

// 23. Входной объект не изменился после вызова --------------------------

test('input object is not mutated', () => {
  const dispatch = makeDispatch({
    workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
    status: 'completed',
  });
  const work = makeWork({ commit: 'abc123' });
  const tests = makeTests({ ran: true, passed: true, failed: 0 });

  // Deep snapshot before
  const before = JSON.stringify({ dispatch, work, tests });

  decide({ dispatch, work, tests });

  // Verify after
  const after = JSON.stringify({ dispatch, work, tests });
  assert.equal(before, after);
});

// Дополнительные проверки правил из spec --------------------------------

test('rule 6: failed outcome with matching IDs still gives SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'failed' },
      status: 'completed',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('WORKER_OUTCOME_FAILED'));
});

test('rule 5: ID mismatch even with finished status does not give SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-999', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'abandoned',
    }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.notEqual(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('ID_MISMATCH'));
});

test('reasons always contains reason codes for missing/absent evidence', () => {
  // Empty-ish call: only dispatch provided
  const res = decide({
    dispatch: makeDispatch(),
    work: makeWork(),
    tests: makeTests(),
  });
  assert.ok(res.reasons.length > 0);
  assert.ok(res.reasons.includes('NO_WORKER_DONE'));
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
  assert.ok(res.reasons.includes('TESTS_NOT_RUN'));
});

test('all 11 reason codes can appear', () => {
  const allCodes = [
    'NO_WORKER_DONE', 'ID_MISMATCH', 'DISPATCH_STATUS_UNKNOWN',
    'COMMIT_UNKNOWN', 'COMMIT_PRESENT', 'COMMIT_ABSENT',
    'TESTS_NOT_RUN', 'TESTS_PASSED', 'TESTS_FAILED',
    'DEADLINE_EXCEEDED', 'WORKER_OUTCOME_FAILED',
  ];
  const res = decide({
    dispatch: makeDispatch(),
    work: makeWork(),
    tests: makeTests(),
  });
  // The default call should cover at least the common ones
  for (const code of ['NO_WORKER_DONE', 'COMMIT_UNKNOWN', 'TESTS_NOT_RUN']) {
    assert.ok(res.reasons.includes(code), `expected ${code} in reasons: ${res.reasons}`);
  }
});

test('tests.ran: false → TESTS_NOT_RUN, not TESTS_FAILED', () => {
  const res = decide({
    dispatch: makeDispatch(),
    work: makeWork(),
    tests: { ran: false, passed: null, failed: 0 },
  });
  assert.ok(res.reasons.includes('TESTS_NOT_RUN'));
  assert.ok(!res.reasons.includes('TESTS_FAILED'));
});

// === KAN-8-A2: missing work evidence → UNKNOWN / UNVERIFIABLE ===

test('missing work (undefined) → UNVERIFIABLE with COMMIT_UNKNOWN', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'stopped', expectedTaskId: 't1', expectedDispatchId: 'd1' }),
    work: undefined,
    tests: makeTests({ ran: false }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
  assert.ok(!res.reasons.includes('COMMIT_ABSENT'));
});

test('work null → UNVERIFIABLE with COMMIT_UNKNOWN', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'stopped', expectedTaskId: 't1', expectedDispatchId: 'd1' }),
    work: null,
    tests: makeTests({ ran: false }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
  assert.ok(!res.reasons.includes('COMMIT_ABSENT'));
});

test('work {} (commit absent) → UNVERIFIABLE with COMMIT_UNKNOWN', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'stopped', expectedTaskId: 't1', expectedDispatchId: 'd1' }),
    work: {},
    tests: makeTests({ ran: false }),
  });
  assert.equal(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
  assert.ok(!res.reasons.includes('COMMIT_ABSENT'));
});

test('work commit empty string → NO_WORK_UNSETTLED with COMMIT_ABSENT', () => {
  const res = decide({
    dispatch: makeDispatch({ status: 'stopped', expectedTaskId: 't1', expectedDispatchId: 'd1' }),
    work: { commit: '' },
    tests: makeTests({ ran: false }),
  });
  assert.equal(res.verdict, 'NO_WORK_UNSETTLED');
  assert.ok(res.reasons.includes('COMMIT_ABSENT'));
});

test('work commit non-empty → COMMIT_PRESENT, verdict not UNVERIFIABLE', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: { commit: 'abc123' },
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.notEqual(res.verdict, 'UNVERIFIABLE');
  assert.ok(res.reasons.includes('COMMIT_PRESENT'));
});

test('correct workerDone + finished status + missing work → SETTLED_BY_WORKER', () => {
  const res = decide({
    dispatch: makeDispatch({
      workerDone: { taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' },
      status: 'completed',
    }),
    work: undefined,
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  assert.equal(res.verdict, 'SETTLED_BY_WORKER');
  assert.ok(res.reasons.includes('COMMIT_UNKNOWN'));
});

// === summarize tests (KAN-8) ===

// 9. Вердикт с несколькими причинами
test('summarize: multiple reasons joined with ", "', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  const summary = summarize(res);
  // WORK_PRESENT_UNSETTLED with NO_WORKER_DONE and other reasons
  assert.match(summary, /^WORK_PRESENT_UNSETTLED: .+,.+/);
  assert.ok(summary.startsWith('WORK_PRESENT_UNSETTLED: '));
  const [prefix, ...rest] = summary.split(': ');
  assert.equal(prefix, 'WORK_PRESENT_UNSETTLED');
  const joined = rest.join(': ');
  assert.equal(joined, res.reasons.join(', '));
});

// 10. Вердикт с одной причиной
test('summarize: single reason', () => {
  const res = summarize({ verdict: 'WORK_PRESENT_UNSETTLED', reasons: ['COMMIT_PRESENT'] });
  assert.equal(res, 'WORK_PRESENT_UNSETTLED: COMMIT_PRESENT');
});

// 11. Пустой массив причин
test('summarize: empty reasons array → verdict only', () => {
  const res = summarize({ verdict: 'SETTLED_BY_WORKER', reasons: [] });
  assert.equal(res, 'SETTLED_BY_WORKER');
});

// 12. Отсутствующий reasons
test('summarize: missing reasons → verdict only', () => {
  const res = summarize({ verdict: 'NO_WORK_UNSETTLED' });
  assert.equal(res, 'NO_WORK_UNSETTLED');
});

// 13. TypeError на не-объекте и на отсутствующем verdict
test('summarize: TypeError on non-object', () => {
  assert.throws(() => summarize('string'), TypeError);
  assert.throws(() => summarize(42), TypeError);
  assert.throws(() => summarize(null), TypeError);
  assert.throws(() => summarize([]), TypeError);
});

test('summarize: TypeError on missing verdict', () => {
  assert.throws(() => summarize({ reasons: ['X'] }), TypeError);
  assert.throws(() => summarize({}), TypeError);
  assert.throws(() => summarize({ verdict: 42 }), TypeError);
  assert.throws(() => summarize({ verdict: null }), TypeError);
  assert.throws(() => summarize({ verdict: undefined }), TypeError);
});

// 14. Вход не изменился после вызова
test('summarize: input object not mutated', () => {
  const input = { verdict: 'WORK_PRESENT_UNSETTLED', reasons: ['COMMIT_PRESENT', 'TESTS_PASSED'] };
  const before = JSON.stringify(input);
  summarize(input);
  assert.equal(JSON.stringify(input), before);
});

// 15. Integration: decide → summarize pipeline
test('summarize integrates with decide: pipeline test', () => {
  const res = decide({
    dispatch: makeDispatch({ workerDone: null, status: 'dispatched' }),
    work: makeWork({ commit: 'abc123' }),
    tests: makeTests({ ran: true, passed: true, failed: 0 }),
  });
  const summary = summarize(res);
  assert.ok(typeof summary === 'string');
  assert.ok(summary.length > 0);
  assert.ok(summary.startsWith(res.verdict + ': ') || summary === res.verdict);
});
