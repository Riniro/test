#!/usr/bin/env node
// settlement-guard.js — CLI entry point for settlement guard commands.
//
// Usage:
//   node settlement-guard.js dispose --dispatch <id> --run <id> --task <id> --worktree <path> [--repo-key <key>]
//
// Exit codes:
//   0  — disposal completed or already completed (B5).
//   3  — lock busy: journal untouched (B4).
//   5  — escalation: ownership/stop result cannot be confirmed.

import { parseArgs } from 'node:util';

import * as guard from './tools/settlement-guard.js';

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    die('Usage: node settlement-guard.js dispose --dispatch <id> --run <id> --task <id> --worktree <path> [--repo-key <key>]');
  }

  const command = argv[0];

  if (command !== 'dispose') {
    die('Unknown command: ' + command + '. Use: dispose');
  }

  // Parse remaining flags
  const { values } = parseArgs({
    options: {
      dispatch: { type: 'string', required: true },
      run: { type: 'string', required: true },
      task: { type: 'string', required: true },
      worktree: { type: 'string', required: true },
      'repo-key': { type: 'string', default: null },
    },
    allowPositionals: true,
    argv: argv.slice(1),
  });

  const result = guard.disposeResources({
    dispatchId: values.dispatch,
    runId: values.run,
    taskId: values.task,
    worktree: values.worktree,
    repoKey: values['repo-key'],
  });

  // Map code to exit: code 20 → 0 (B5), code 3 → 3, code 5 → 5
  const exitCode = result.code === 20 ? 0 : result.code;

  process.stdout.write(JSON.stringify({ code: result.code, exitCode, body: result.body }) + '\n');
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith('settlement-guard.js')) {
  main();
}

export { main };
