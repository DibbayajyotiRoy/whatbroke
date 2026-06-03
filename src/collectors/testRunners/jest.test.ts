import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJest } from './jest.js';

const JEST_OUTPUT = `
 FAIL  src/math.test.ts
  math
    ✓ adds positive numbers (2 ms)
    ✕ subtracts numbers (3 ms)
    ✕ divides numbers

  ● math › subtracts numbers

    expect(received).toBe(expected)

    Expected: 1
    Received: 3

      at Object.<anonymous> (src/math.test.ts:8:23)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 1 passed, 3 total
Snapshots:   0 total
Time:        1.234 s
`;

test('parseJest identifies runner, tests, file and counts', () => {
  const r = parseJest(JEST_OUTPUT);
  assert.ok(r, 'expected a match');
  assert.equal(r.runner, 'jest');
  assert.equal(r.failed, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.total, 3);
  const ids = r.failingTests.map((t) => t.id);
  assert.deepEqual(ids, ['subtracts numbers', 'divides numbers']);
  // Single FAIL file → attributed to each failing test.
  assert.equal(r.failingTests[0]?.file, 'src/math.test.ts');
});

test('parseJest falls back to file ids when no per-test markers present', () => {
  const r = parseJest(`
 FAIL  src/a.test.ts
 FAIL  src/b.test.ts
Tests:       2 failed, 0 passed, 2 total
`);
  assert.ok(r);
  assert.equal(r.failingTests.length, 2);
  assert.deepEqual(r.failingTests.map((t) => t.id), ['src/a.test.ts', 'src/b.test.ts']);
});

test('parseJest declines vitest output (has Test Files line)', () => {
  const vitest = `
 FAIL  src/a.test.ts > a > works
Test Files  1 failed (1)
      Tests  1 failed (1)
`;
  assert.equal(parseJest(vitest), null);
});

test('parseJest declines output without a Tests: summary', () => {
  assert.equal(parseJest('FAIL  src/a.test.ts\nsome other noise'), null);
});
