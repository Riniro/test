// settle.js — verdict logic for worker settlement.
// Pure function: no filesystem, network, or process access.
// Does not print to stdout/stderr. Does not mutate inputs.

const FINISHED_STATUSES = new Set(['completed', 'failed', 'stopped', 'abandoned']);

/**
 * @param {object}  params
 * @param {object}  [params.dispatch]
 * @param {object}  [params.work]
 * @param {object}  [params.tests]
 * @param {boolean} [params.deadlineExceeded=false]
 * @returns {{ verdict: string, reasons: string[] }}
 */
export function decide(params) {
  // Rule 11: non-object argument throws TypeError
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('decide expects an object argument');
  }

  const { dispatch, work, tests, deadlineExceeded = false } = params;

  // Deep-clone inputs to guarantee no mutation of caller's objects
  const d = structuredClone(dispatch);
  const w = structuredClone(work);
  const t = structuredClone(tests);

  const reasons = [];

  // -- workerDone --
  const workerDone = d?.workerDone ?? null;
  const taskIdMatches = workerDone &&
                        d?.expectedTaskId !== undefined &&
                        workerDone.taskId === d.expectedTaskId;
  const dispatchIdMatches = workerDone &&
                            d?.expectedDispatchId !== undefined &&
                            workerDone.dispatchId === d.expectedDispatchId;
  const workerDoneOk = !!workerDone && taskIdMatches && dispatchIdMatches;

  if (!workerDoneOk) {
    if (!workerDone) {
      reasons.push('NO_WORKER_DONE');
    } else if (!taskIdMatches || !dispatchIdMatches) {
      reasons.push('ID_MISMATCH');
    }
  }

  // -- dispatch status --
  const statusUnknown = !d || d.status === null || d.status === undefined ||
                        (typeof d.status !== 'string');
  const statusFinished = !statusUnknown && FINISHED_STATUSES.has(d.status);

  if (statusUnknown) {
    reasons.push('DISPATCH_STATUS_UNKNOWN');
  }

  // -- work --
  // Missing or null work object, or absent commit field → unknown.
  const commitUnknown = !w || w.commit === null || w.commit === undefined;
  const commitPresent = w && w.commit !== null && w.commit !== undefined && w.commit !== '';

  if (commitUnknown) {
    reasons.push('COMMIT_UNKNOWN');
  } else if (commitPresent) {
    reasons.push('COMMIT_PRESENT');
  } else {
    reasons.push('COMMIT_ABSENT');
  }

  // -- tests --
  if (!t?.ran) {
    reasons.push('TESTS_NOT_RUN');
  } else if (t.passed === true) {
    reasons.push('TESTS_PASSED');
  } else if (t.passed === false || (t.failed !== undefined && t.failed > 0)) {
    reasons.push('TESTS_FAILED');
  }

  // -- deadline --
  if (deadlineExceeded) {
    reasons.push('DEADLINE_EXCEEDED');
  }

  // ---------- verdict (fixed order per spec) ----------

  let verdict;

  // 1. SETTLED_BY_WORKER
  if (workerDoneOk && statusFinished) {
    verdict = 'SETTLED_BY_WORKER';
    if (workerDone?.outcome === 'failed') {
      reasons.push('WORKER_OUTCOME_FAILED');
    }
  }
  // 2. UNVERIFIABLE
  else if (statusUnknown || commitUnknown) {
    verdict = 'UNVERIFIABLE';
  }
  // 3. WORK_PRESENT_UNSETTLED
  else if (commitPresent) {
    verdict = 'WORK_PRESENT_UNSETTLED';
  }
  // 4. NO_WORK_UNSETTLED
  else {
    verdict = 'NO_WORK_UNSETTLED';
  }

  // reasons must always be non-empty
  if (reasons.length === 0) {
    reasons.push('NO_EVIDENCE');
    verdict = 'UNVERIFIABLE';
  }

  return { verdict, reasons };
}

/**
 * Summarise a `decide` result into a single short line for the coordinator log.
 *
 * @param {object}  result  — `{ verdict, reasons }` as returned by `decide`
 * @returns {string}
 */
export function summarize(result) {
  // Rule 4: argument must be an object (not null, not array, not primitive)
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('summarize expects an object argument');
  }

  // Rule 5: verdict must be present and a string
  const { verdict, reasons } = result;
  if (verdict === null || verdict === undefined || typeof verdict !== 'string') {
    throw new TypeError('summarize expects a string verdict');
  }

  const codes = Array.isArray(reasons) ? reasons.filter(r => typeof r === 'string' && r !== '') : [];

  // Rule 3: empty / absent reasons → single-string, no colon
  if (codes.length === 0) {
    return verdict;
  }

  // Rule 1, 2: "<verdict>: <reason1>, <reason2>"
  return `${verdict}: ${codes.join(', ')}`;
}
