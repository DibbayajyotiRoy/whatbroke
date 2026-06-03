import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaywright } from './playwright.js';

const PW_OUTPUT = `
Running 3 tests using 1 worker

  ✘  1 [chromium] › tests/login.spec.ts:12:3 › login flow › shows error on bad password (2.1s)
  ✓  2 [chromium] › tests/home.spec.ts:4:1 › home › renders (300ms)
  ✘  3 [firefox] › tests/login.spec.ts:12:3 › login flow › shows error on bad password (1.8s)


  1) [chromium] › tests/login.spec.ts:12:3 › login flow › shows error on bad password ─────────

    Error: expect(received).toBeVisible()

  2 failed
    [chromium] › tests/login.spec.ts:12:3 › login flow › shows error on bad password
    [firefox] › tests/login.spec.ts:12:3 › login flow › shows error on bad password
  1 passed (4.5s)
`;

test('parsePlaywright identifies runner, tests, files and counts', () => {
  const r = parsePlaywright(PW_OUTPUT);
  assert.ok(r, 'expected a match');
  assert.equal(r.runner, 'playwright');
  assert.equal(r.failed, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.total, 3);
  // Two distinct (project,file:line) entries; the ✘ lines and summary dedupe.
  assert.deepEqual(r.failingTests.map((t) => t.id), [
    '[chromium] › login flow › shows error on bad password',
    '[firefox] › login flow › shows error on bad password',
  ]);
  assert.deepEqual(r.failingTests.map((t) => t.file), [
    'tests/login.spec.ts:12',
    'tests/login.spec.ts:12',
  ]);
});

test('parsePlaywright declines unrelated text', () => {
  assert.equal(parsePlaywright('no playwright output here'), null);
});
