import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNodeTest } from './nodeTest.js';

const TAP_OUTPUT = `
TAP version 13
# Subtest: adds two numbers
ok 1 - adds two numbers
# Subtest: subtracts two numbers
not ok 2 - subtracts two numbers
  ---
  duration_ms: 1.2
  failureType: 'testCodeFailure'
  error: 'Expected values to be strictly equal'
  code: 'ERR_ASSERTION'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
`;

test('parseNodeTest identifies runner, failing test and counts', () => {
  const r = parseNodeTest(TAP_OUTPUT);
  assert.ok(r, 'expected a match');
  assert.equal(r.runner, 'node:test');
  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failingTests.map((t) => t.id), ['subtracts two numbers']);
  assert.equal(r.failingTests[0]?.file, null);
});

test('parseNodeTest requires a TAP marker (declines bare not ok)', () => {
  assert.equal(parseNodeTest('not ok 1 - something\n'), null);
});

test('parseNodeTest declines unrelated text', () => {
  assert.equal(parseNodeTest('hello world, no TAP here'), null);
});
