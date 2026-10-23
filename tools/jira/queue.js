#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchByLabels } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const result = { project: null, labels: [], json: false };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--project' && i + 1 < argv.length) {
      result.project = argv[i + 1];
      i += 2;
    } else if (arg === '--labels' && i + 1 < argv.length) {
      result.labels = argv[i + 1]
        .split(',')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      i += 2;
    } else if (arg === '--json') {
      result.json = true;
      i += 1;
    } else {
      i += 1;
    }
  }

  return result;
}

function formatIssue(issue) {
  return {
    key: issue.key,
    summary: issue.summary,
    labels: issue.labels,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!args.project || args.project.length === 0) {
    process.stderr.write('Usage: node queue.js --project <KEY> [--labels l1,l2] [--json]\n');
    process.exitCode = 2;
    return;
  }

  if (args.labels.length === 0) {
    process.stderr.write('Usage: node queue.js --project <KEY> [--labels l1,l2] [--json]\n');
    process.exitCode = 2;
    return;
  }

  const env = process.env;
  let filePath = env.JIRA_CREDENTIALS_FILE;

  if (!filePath) {
    filePath = path.join(os.homedir(), '.jira-coordinator.json');
  }

  let creds;
  try {
    const { loadCredentials } = await import('./client.js');
    creds = loadCredentials(env);
  } catch (err) {
    const out = { found: false, issue: null, count: 0 };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exitCode = 4;
    return;
  }

  try {
    const issues = await searchByLabels({
      creds,
      labels: args.labels,
      project: args.project,
    });

    const result = {
      found: issues.length > 0,
      issue: issues.length > 0 ? formatIssue(issues[0]) : null,
      count: issues.length,
    };

    process.stdout.write(JSON.stringify(result) + '\n');

    if (issues.length > 0) {
      process.exitCode = 0;
    } else {
      process.exitCode = 3;
    }
  } catch (err) {
    const out = { found: false, issue: null, count: 0 };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exitCode = 4;
  }
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main();
}
