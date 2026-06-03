import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVitest } from './vitest.js';

const VITEST_OUTPUT = `
 ❯ src/sum.test.ts (3 tests | 1 failed) 12ms

 FAIL  src/sum.test.ts > sum > handles negatives
AssertionError: expected -1 to be 1

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  10:00:00
   Duration  500ms
`;

test('parseVitest identifies runner, test, file and counts', () => {
  const r = parseVitest(VITEST_OUTPUT);
  assert.ok(r, 'expected a match');
  assert.equal(r.runner, 'vitest');
  assert.equal(r.failed, 1);
  assert.equal(r.passed, 2);
  assert.equal(r.total, 3);
  assert.equal(r.failingTests.length, 1);
  assert.equal(r.failingTests[0]?.id, 'sum > handles negatives');
  assert.equal(r.failingTests[0]?.file, 'src/sum.test.ts');
});

test('parseVitest detects via separator even without FAIL>test path', () => {
  const r = parseVitest(`
 FAIL  src/a.test.ts
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
      Tests  1 failed (1)
`);
  assert.ok(r);
  assert.equal(r.runner, 'vitest');
  assert.deepEqual(r.failingTests.map((t) => t.id), ['src/a.test.ts']);
});

test('parseVitest declines jest output (no Test Files / separator)', () => {
  const jest = `
 FAIL  src/math.test.ts
    ✕ subtracts numbers (3 ms)
Tests:       1 failed, 2 passed, 3 total
`;
  assert.equal(parseVitest(jest), null);
});

test('parseVitest declines unrelated text', () => {
  assert.equal(parseVitest('nothing to see here'), null);
});
