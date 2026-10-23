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
  const commitPresent = w?.commit !== null && w?.commit !== undefined && w.commit !== '';
  const commitUnknown = w?.commit === null;

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
    reasons.push('COMMIT_PRESENT');
  }

  return { verdict, reasons };
}
