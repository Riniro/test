const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PART_RE = /^(\d+)(ms|s|m|h|d)/;

export function parseDuration(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new RangeError('Empty duration string');
  }

  let total = 0;
  let pos = 0;

  while (pos < trimmed.length) {
    // skip leading whitespace
    while (pos < trimmed.length && trimmed[pos] === ' ') {
      pos++;
    }
    if (pos >= trimmed.length) break;

    const rest = trimmed.slice(pos);
    const match = PART_RE.exec(rest);

    if (!match) {
      throw new RangeError(`Invalid duration: ${JSON.stringify(trimmed)}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];
    total += value * UNIT_MS[unit];
    pos += match[0].length;
  }

  return total;
}

const SORTED_UNITS = ['d', 'h', 'm', 's', 'ms'];

export function formatDuration(ms) {
  if (typeof ms !== 'number') {
    throw new TypeError('Expected a number');
  }

  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError('Expected a safe positive integer');
  }

  if (ms === 0) {
    return '0ms';
  }

  const parts = [];
  let remaining = ms;

  for (const unit of SORTED_UNITS) {
    const value = Math.floor(remaining / UNIT_MS[unit]);
    if (value > 0) {
      parts.push(`${value}${unit}`);
      remaining -= value * UNIT_MS[unit];
    }
  }

  return parts.join(' ');
}
