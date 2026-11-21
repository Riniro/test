#!/usr/bin/env node
// settlement-guard.js — CLI entry point for the settlement guard.
//
// Usage:
//   node settlement-guard.js dispose --dispatch <id> --run <id> [--task <id>]
//                            [--repo-key <key>] [--deadline-exceeded]
//
// Exit codes (the same numbers the module returns, so a caller never has to
// translate between layers):
//   0  — resources disposed, or already disposed: nothing to do.
//   2  — wrong usage.
//   5  — ownership or stop result cannot be confirmed → escalation.
//   23 — lock busy: journal untouched, worker-stop not called.
//   24 — journal corrupt: left untouched, nothing stopped.
//   25 — read or write error.
//
// --deadline-exceeded says the wait ended on the deadline rather than on a
// result.  Only then may a live dispatch be stopped, and the step still stays
// unsettled: stopping is not acceptance.

import { parseArgs } from 'node:util';

import * as guard from './tools/settlement-guard.js';

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

const USAGE = 'Usage: node settlement-guard.js dispose --dispatch <id> --run <id> ' +
  '[--task <id>] [--repo-key <key>] [--deadline-exceeded]';

export function main(argvInput) {
  const argv = argvInput || process.argv.slice(2);

  if (argv.length === 0) die(USAGE);

  const command = argv[0];
  if (command !== 'dispose') die('Unknown command: ' + command + '. Use: dispose');

  let values;
  try {
    ({ values } = parseArgs({
      options: {
        dispatch: { type: 'string' },
        run: { type: 'string' },
        task: { type: 'string' },
        worktree: { type: 'string' },
        'repo-key': { type: 'string' },
        'deadline-exceeded': { type: 'boolean', default: false },
      },
      allowPositionals: false,
      args: argv.slice(1),
    }));
  } catch (err) {
    die(err.message + '\n' + USAGE);
  }

  if (!values.dispatch) die('--dispatch is required\n' + USAGE);
  if (!values.run) die('--run is required\n' + USAGE);

  const result = guard.disposeResources({
    dispatchId: values.dispatch,
    runId: values.run,
    taskId: values.task,
    repoKey: values['repo-key'],
    deadlineExceeded: values['deadline-exceeded'],
  });

  process.stdout.write(JSON.stringify({ code: result.code, body: result.body }) + '\n');
  return result.code;
}

const invokedPath = process.argv[1] ? process.argv[1].split(String.fromCharCode(92)).join('/') : '';
if (invokedPath.endsWith('/settlement-guard.js') && !invokedPath.endsWith('/tools/settlement-guard.js')) {
  process.exit(main());
}
