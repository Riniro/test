// settlement-guard.test.js — tests for R1 (lock guard), R2 (idempotency), R3 (dispose step).
// Tests use only local mocks — no live Orca, Jira, or GitHub calls.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as guard from '../tools/settlement-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const stateDir = join(dir, 'state');
  const settlementsDir = join(stateDir, 'default');
  if (!existsSync(settlementsDir)) mkdirSync(settlementsDir, { recursive: true });
  return { dir, stateDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// R1: concurrent writes with different dispatchIds
// ---------------------------------------------------------------------------

test('R1: two sequential writes to the same journal — both records present', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // Process A
    const resultA = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['dispatch-a'] = { verdict: 'SETTLED_BY_WORKER', recordBy: 'A' };
      },
    });

    // Process B
    const resultB = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['dispatch-b'] = { verdict: 'WORK_PRESENT_UNSETTLED', recordBy: 'B' };
      },
    });

    assert.equal(resultA.code, 0);
    assert.equal(resultB.code, 0);

    // Read the journal file — both records should be present
    const journalPath = join(stateDir, 'default', 'settlements.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.ok(journal['dispatch-a'], 'dispatch-a should be in journal');
    assert.ok(journal['dispatch-b'], 'dispatch-b should be in journal');
    assert.equal(journal['dispatch-a'].recordBy, 'A');
    assert.equal(journal['dispatch-b'].recordBy, 'B');
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R1: lock cannot be acquired → journal not touched
// ---------------------------------------------------------------------------

test('R1: lock busy returns code 3 and does not modify journal', async () => {
  const { stateDir, cleanup } = makeStateDir();

  // Write initial journal content
  const journalPath = join(stateDir, 'default', 'settlements.json');
  writeFileSync(journalPath, JSON.stringify({ 'dispatch-x': { verdict: 'NO_WORK_UNSETTLED' } }), 'utf8');
  const journalBefore = readFileSync(journalPath, 'utf8');

  // Acquire the settlements lock manually to simulate another process holding it
  const lock = await import('../tools/coordinator/lock.js');
  const lockRes = lock.acquire({
    stateDir,
    repoKey: 'settlements-guard',
  });

  after(cleanup);

  try {
    assert.ok(lockRes.ok, 'should be able to acquire the lock for test');

    // Now call guardedSettlements — the lock is held, so it should fail with code 3
    process.env.COORDINATOR_STATE_DIR = stateDir;

    try {
      const result = guard.guardedSettlements({
        repoKey: 'default',
        lockRequired: true,
        mutateFn: (journal) => {
          // This should never be called because lock is busy
          journal['dispatch-y'] = { verdict: 'SETTLED_BY_WORKER' };
        },
      });

      assert.equal(result.code, 3, 'should return LOCK_BUSY code');
      assert.equal(result.journal, null, 'journal should be null');
    } finally {
      delete process.env.COORDINATOR_STATE_DIR;
    }

    // Journal must NOT have changed
    const journalAfter = readFileSync(journalPath, 'utf8');
    assert.equal(journalAfter, journalBefore, 'journal should not have changed');
  } finally {
    lock.release({
      stateDir,
      repoKey: 'settlements-guard',
      token: lockRes.token,
    });
  }
});

// ---------------------------------------------------------------------------
// R1: lock is released on exception in mutateFn
// ---------------------------------------------------------------------------

test('R1: lock released on exception in mutateFn', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // First call succeeds
    const result1 = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['dispatch-1'] = { verdict: 'SETTLED_BY_WORKER' };
      },
    });
    assert.equal(result1.code, 0);

    // Second call with throwing mutateFn — lock should still be released
    let threw = false;
    try {
      guard.guardedSettlements({
        repoKey: 'default',
        lockRequired: true,
        mutateFn: () => {
          threw = true;
          throw new Error('mutation error');
        },
      });
    } catch {
      // Expected
    }
    assert.ok(threw, 'mutateFn should have thrown');

    // Third call should succeed (lock was released by the throw)
    const result3 = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['dispatch-2'] = { verdict: 'WORK_PRESENT_UNSETTLED' };
      },
    });
    assert.equal(result3.code, 0);
    assert.ok(result3.journal['dispatch-2']);
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R2: idempotency — same action not repeated
// ---------------------------------------------------------------------------

test('R2: isDisposalCompleted returns false when no entry', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    assert.equal(guard.isDisposalCompleted('ctx-xxx', 'default'), false);
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

test('R2: isDisposalCompleted returns true after recordDisposal', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    assert.equal(guard.isDisposalCompleted('ctx-r2', 'default'), false);

    // Create a journal entry first
    guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-r2'] = { verdict: 'WORK_PRESENT_UNSETTLED' };
      },
    });

    assert.equal(guard.isDisposalCompleted('ctx-r2', 'default'), false);

    // Now record disposal
    const result = guard.recordDisposal('ctx-r2', 'default', { verdict: 'WORK_PRESENT_UNSETTLED' });
    assert.equal(result.code, 0);

    assert.equal(guard.isDisposalCompleted('ctx-r2', 'default'), true);
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R3: disposeResources — no settlement entry → code 5
// ---------------------------------------------------------------------------

test('R3: no settlement entry → code 5 (escalation)', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    const result = await guard.disposeResources({
      dispatchId: 'ctx-missing',
      runId: 'run-missing',
      taskId: 'task-missing',
      worktree: join(stateDir, 'worktree'),
      repoKey: 'default',
    });

    assert.equal(result.code, 5);
    assert.ok(result.body.includes('no settlement entry'));
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R3: disposeResources with completedAction → code 4 (already done)
// ---------------------------------------------------------------------------

test('R3: completedAction already present → code 4', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // Create a journal entry with completedAction
    guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-r3'] = {
          verdict: 'SETTLED_BY_WORKER',
          completedAction: { name: 'dispose-resources', at: new Date().toISOString() },
        };
      },
    });

    const result = await guard.disposeResources({
      dispatchId: 'ctx-r3',
      runId: 'run-r3',
      taskId: 'task-r3',
      worktree: join(stateDir, 'worktree'),
      repoKey: 'default',
    });

    assert.equal(result.code, 4, 'should return 4 for already completed');
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R2: repeated check with changed evidence → new verdict allowed
// ---------------------------------------------------------------------------

test('R2: repeated check with changed evidence → new verdict allowed', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // First run — verdict A
    const result1 = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-r2r'] = { verdict: 'NO_WORK_UNSETTLED', evidence: { commit: '' } };
      },
    });
    assert.equal(result1.code, 0);

    // Second run — different verdict (simulating changed evidence)
    const result2 = guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-r2r'] = { verdict: 'WORK_PRESENT_UNSETTLED', evidence: { commit: 'abc123' } };
      },
    });
    assert.equal(result2.code, 0);
    assert.equal(result2.journal['ctx-r2r'].verdict, 'WORK_PRESENT_UNSETTLED');

    // Journal file should reflect the new verdict
    const journalPath = join(stateDir, 'default', 'settlements.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal['ctx-r2r'].verdict, 'WORK_PRESENT_UNSETTLED');
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
  }
});

// ---------------------------------------------------------------------------
// R3: disposeResources with Orca stub → resource disposed
// ---------------------------------------------------------------------------

test('R3: disposeResources with stub → code 0, action recorded', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // Create a journal entry without completedAction
    guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-ora'] = {
          verdict: 'WORK_PRESENT_UNSETTLED',
          evidence: { workerDone: { dispatchId: 'ctx-ora' } },
        };
      },
    });

    // Create an Orca stub that succeeds on worker-stop
    const stubDir = join(stateDir, 'ora-stub');
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, 'ora-stub.js');
    writeFileSync(stubPath, 'process.exit(0);', 'utf8');
    process.env.SETTLE_ORCA_EXEC = process.execPath;
    process.env.SETTLE_ORCA_PREFIX_ARGS_JSON = JSON.stringify([stubPath]);

    try {
      const result = guard.disposeResources({
        dispatchId: 'ctx-ora',
        runId: 'run-ora',
        taskId: 'task-ora',
        worktree: join(stateDir, 'worktree'),
        repoKey: 'default',
      });

      assert.equal(result.code, 0, 'should succeed with working stub');
      assert.ok(result.body.includes('resources disposed'));

      // Verify completedAction was recorded
      const journalPath = join(stateDir, 'default', 'settlements.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      assert.ok(journal['ctx-ora'].completedAction);
      assert.equal(journal['ctx-ora'].completedAction.name, 'dispose-resources');
    } finally {
      delete process.env.SETTLE_ORCA_EXEC;
      delete process.env.SETTLE_ORCA_PREFIX_ARGS_JSON;
    }
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// R3: disposeResources with failing Orca stub → code 5 (escalation)
// ---------------------------------------------------------------------------

test('R3: disposeResources failing stub → code 5 (escalation)', async () => {
  const { stateDir, cleanup } = makeStateDir();
  after(cleanup);
  process.env.COORDINATOR_STATE_DIR = stateDir;

  try {
    // Create a journal entry
    guard.guardedSettlements({
      repoKey: 'default',
      lockRequired: true,
      mutateFn: (journal) => {
        journal['ctx-fail'] = {
          verdict: 'WORK_PRESENT_UNSETTLED',
          evidence: { workerDone: { dispatchId: 'ctx-fail' } },
        };
      },
    });

    // Create a failing Orca stub
    const stubDir = join(stateDir, 'ora-fail');
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, 'ora-fail.js');
    writeFileSync(stubPath, 'process.exit(1);', 'utf8');
    process.env.SETTLE_ORCA_EXEC = process.execPath;
    process.env.SETTLE_ORCA_PREFIX_ARGS_JSON = JSON.stringify([stubPath]);

    try {
      const result = guard.disposeResources({
        dispatchId: 'ctx-fail',
        runId: 'run-fail',
        taskId: 'task-fail',
        worktree: join(stateDir, 'worktree'),
        repoKey: 'default',
      });

      assert.equal(result.code, 5, 'should fail with failing stub');
      assert.ok(result.body.includes('worker-stop'));
    } finally {
      delete process.env.SETTLE_ORCA_EXEC;
      delete process.env.SETTLE_ORCA_PREFIX_ARGS_JSON;
    }
  } finally {
    delete process.env.COORDINATOR_STATE_DIR;
    cleanup();
  }
});
