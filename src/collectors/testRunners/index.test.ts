import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogBuffer } from '../../types.js';
import {
  parseTestFailure,
  parseJest,
  parseVitest,
  parseMocha,
  parseNodeTest,
  parsePlaywright,
} from './index.js';

// `text` lands in the clean stdout tail (what parsing reads). combinedTail is
// line-tagged like the real interleaved buffer — parsing must NOT rely on it.
function logs(text: string, stdout = '', stderr = ''): LogBuffer {
  return {
    stdoutTail: stdout || text,
    stderrTail: stderr,
    combinedTail: text
      .split('\n')
      .map((l) => `[stdout] ${l}`)
      .join('\n'),
    truncated: false,
    bufferLines: 0,
  };
}

const JEST = `
 FAIL  src/math.test.ts
    ✕ subtracts numbers (3 ms)
Tests:       1 failed, 1 passed, 2 total
`;

const VITEST = `
 FAIL  src/sum.test.ts > sum > negatives
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;

test('parseTestFailure picks jest from clean stdout tail', () => {
  const r = parseTestFailure(logs(JEST));
  assert.ok(r);
  assert.equal(r.runner, 'jest');
});

test('parseTestFailure picks vitest from clean stdout tail', () => {
  const r = parseTestFailure(logs(VITEST));
  assert.ok(r);
  assert.equal(r.runner, 'vitest');
});

test('parseTestFailure parses from stderr stream too', () => {
  const r = parseTestFailure(logs('', '', JEST));
  assert.ok(r);
  assert.equal(r.runner, 'jest');
});

test('jest and vitest are not cross-misclassified', () => {
  // Jest output must not be read as vitest, and vice versa.
  assert.equal(parseVitest(JEST), null);
  assert.equal(parseJest(VITEST), null);
  assert.equal(parseJest(JEST)?.runner, 'jest');
  assert.equal(parseVitest(VITEST)?.runner, 'vitest');
});

test('all parsers and parseTestFailure return null on unrelated logs', () => {
  const noise = `
$ npm run build
> tsc -p tsconfig.json
Done in 3.4s. Bundle written to dist/.
Some application log line: connected to db at 10:00.
`;
  assert.equal(parseJest(noise), null);
  assert.equal(parseVitest(noise), null);
  assert.equal(parseMocha(noise), null);
  assert.equal(parseNodeTest(noise), null);
  assert.equal(parsePlaywright(noise), null);
  assert.equal(parseTestFailure(logs(noise)), null);
});
