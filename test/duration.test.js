import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';

// --- each unit ---
test('1ms → 1', () => { assert.strictEqual(parseDuration('1ms'), 1); });
test('1s → 1000', () => { assert.strictEqual(parseDuration('1s'), 1000); });
test('1m → 60000', () => { assert.strictEqual(parseDuration('1m'), 60000); });
test('1h → 3600000', () => { assert.strictEqual(parseDuration('1h'), 3600000); });
test('1d → 86400000', () => { assert.strictEqual(parseDuration('1d'), 86400000); });

// --- composite ---
test('1h 30m → 5400000', () => { assert.strictEqual(parseDuration('1h 30m'), 5_400_000); });
test('1h30m → 5400000', () => { assert.strictEqual(parseDuration('1h30m'), 5_400_000); });
test('30m 1h → 5400000', () => { assert.strictEqual(parseDuration('30m 1h'), 5_400_000); });
test('1d 2h 3m 4s 5ms → full sum', () => {
  assert.strictEqual(
    parseDuration('1d 2h 3m 4s 5ms'),
    86_400_000 + 7_200_000 + 180_000 + 4_000 + 5,
  );
});

// --- zero ---
test('0s → 0', () => { assert.strictEqual(parseDuration('0s'), 0); });

// --- repeated unit ---
test('30s 30s → 60000', () => { assert.strictEqual(parseDuration('30s 30s'), 60_000); });

// --- leading/trailing whitespace ---
test('  1h  → 3600000', () => { assert.strictEqual(parseDuration('  1h  '), 3_600_000); });

// --- errors: TypeError ---
test('parseDuration(5) throws TypeError', () => {
  assert.throws(() => parseDuration(5), TypeError);
});
test('parseDuration(null) throws TypeError', () => {
  assert.throws(() => parseDuration(null), TypeError);
});
test('parseDuration(undefined) throws TypeError', () => {
  assert.throws(() => parseDuration(undefined), TypeError);
});
test('parseDuration({}) throws TypeError', () => {
  assert.throws(() => parseDuration({}), TypeError);
});

// --- errors: RangeError ---
test('empty string → RangeError', () => {
  assert.throws(() => parseDuration(''), RangeError);
});
test('only spaces → RangeError', () => {
  assert.throws(() => parseDuration('   '), RangeError);
});
test('"abc" → RangeError', () => {
  assert.throws(() => parseDuration('abc'), RangeError);
});
test('"10" (no unit) → RangeError', () => {
  assert.throws(() => parseDuration('10'), RangeError);
});
test('"s" (no number) → RangeError', () => {
  assert.throws(() => parseDuration('s'), RangeError);
});
test('"10x" (unknown unit) → RangeError', () => {
  assert.throws(() => parseDuration('10x'), RangeError);
});
test('1.5s (fractional) → RangeError', () => {
  assert.throws(() => parseDuration('1.5s'), RangeError);
});
test('-5s (negative) → RangeError', () => {
  assert.throws(() => parseDuration('-5s'), RangeError);
});
test('10 S (wrong case) → RangeError', () => {
  assert.throws(() => parseDuration('10 S'), RangeError);
});
