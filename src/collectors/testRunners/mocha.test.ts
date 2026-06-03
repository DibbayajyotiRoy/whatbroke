import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMocha } from './mocha.js';

const MOCHA_OUTPUT = `
  Array
    #indexOf()
      ✓ should return -1 when not present
      1) should return the index when present

  Math
    2) add adds two numbers


  1 passing (18ms)
  2 failing

  1) Array #indexOf() should return the index when present:
     AssertionError: expected -1 to equal 2
      at Context.<anonymous> (test/array.spec.js:10:21)

  2) Math add adds two numbers:
     AssertionError: expected 4 to equal 5
      at Context.<anonymous> (test/math.spec.js:5:18)
`;

test('parseMocha identifies runner, failing tests and counts', () => {
  const r = parseMocha(MOCHA_OUTPUT);
  assert.ok(r, 'expected a match');
  assert.equal(r.runner, 'mocha');
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.failingTests.map((t) => t.id), [
    'Array #indexOf() should return the index when present',
    'Math add adds two numbers',
  ]);
  // Mocha summary block has no file paths.
  assert.equal(r.failingTests[0]?.file, null);
});

test('parseMocha matches an all-passing run summary too', () => {
  const r = parseMocha('  3 passing (5ms)\n');
  assert.ok(r);
  assert.equal(r.runner, 'mocha');
  assert.equal(r.passed, 3);
  assert.equal(r.total, 3);
  assert.equal(r.failingTests.length, 0);
});

test('parseMocha declines text without a passing/failing summary', () => {
  assert.equal(parseMocha('  1) some random numbered line:\n'), null);
});
