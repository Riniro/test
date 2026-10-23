import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRegistry } from './registry.js';
import { route } from './route.js';

function parseArgs(argv) {
  const result = { command: null, labels: null, registry: null };
  let i = 0;

  if (i < argv.length) {
    result.command = argv[i++];
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--labels' && i + 1 < argv.length) {
      result.labels = argv[i + 1];
      i += 2;
    } else if (arg === '--registry' && i + 1 < argv.length) {
      result.registry = argv[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  return result;
}

export function main({ argv, cwd }) {
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.command !== 'route' || parsed.labels === null) {
    process.stderr.write('Usage: node cli.js route --labels "<labels>" [--registry <path>]\n');
    return 2;
  }

  const labelString = parsed.labels;
  const labels = labelString
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let filePath;
  if (parsed.registry) {
    filePath = path.resolve(cwd, parsed.registry);
  } else {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    filePath = path.resolve(dirname, 'products.json');
  }

  const regResult = loadRegistry({ filePath });

  if (!regResult.ok) {
    const errJson = JSON.stringify({
      status: 'REGISTRY_ERROR',
      reason: regResult.reason,
      detail: regResult.detail ?? null,
    });
    process.stdout.write(errJson + '\n');
    return 6;
  }

  const routeResult = route({ labels, products: regResult.products });
  process.stdout.write(JSON.stringify(routeResult) + '\n');

  switch (routeResult.status) {
    case 'ROUTED':
      return 0;
    case 'NEEDS_INPUT':
      return 3;
    case 'AMBIGUOUS':
      return 4;
    case 'NEEDS_REGISTRATION':
      return 5;
    default:
      return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main({ argv: process.argv.slice(2), cwd: process.cwd() });
}
