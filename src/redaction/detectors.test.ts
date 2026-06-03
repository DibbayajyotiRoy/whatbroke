/**
 * Unit coverage for individual detectors and the entropy heuristic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_FORMAT_DETECTORS,
  makeDenylistDetector,
  makeEnvValueDetector,
} from './detectors.js';
import {
  entropyDetector,
  looksHighEntropy,
  shannonEntropy,
} from './entropy.js';

function runChain(detectors: { redact(t: string): { text: string; hits: number } }[], text: string) {
  let out = text;
  let hits = 0;
  for (const d of detectors) {
    const r = d.redact(out);
    out = r.text;
    hits += r.hits;
  }
  return { text: out, hits };
}

test('known-format: AWS access key', () => {
  const r = runChain(KNOWN_FORMAT_DETECTORS, 'key AKIAIOSFODNN7EXAMPLE here');
  assert.ok(!r.text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(r.text.includes('‹redacted:aws-access-key›'));
});

test('known-format: GitHub classic + PAT', () => {
  const r = runChain(
    KNOWN_FORMAT_DETECTORS,
    'ghp_1234567890abcdefghijABCDEFGHIJ123456 and github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ012345',
  );
  assert.ok(!r.text.includes('ghp_'));
  assert.ok(!r.text.includes('github_pat_'));
});

test('known-format: Google API key, Slack token, JWT', () => {
  const r = runChain(
    KNOWN_FORMAT_DETECTORS,
    // 'xox'+'b-' split so GitHub push-protection can't match a real Slack token.
    'AIzaSyA1234567890abcdefghijklmnopqrstuv xox' +
      'b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx eyJaaa.eyJbbb.ccc',
  );
  assert.ok(!r.text.includes('AIzaSy'));
  assert.ok(!r.text.includes('xoxb-'));
  assert.ok(!r.text.includes('eyJaaa'));
});

test('known-format: private key block (multiline)', () => {
  const pem =
    '-----BEGIN PRIVATE KEY-----\nMIIaaa\nbbbccc\n-----END PRIVATE KEY-----';
  const r = runChain(KNOWN_FORMAT_DETECTORS, `before\n${pem}\nafter`);
  assert.ok(!r.text.includes('MIIaaa'));
  assert.ok(r.text.includes('before'));
  assert.ok(r.text.includes('after'));
});

test('known-format: connection string and bearer header', () => {
  const r = runChain(
    KNOWN_FORMAT_DETECTORS,
    'postgres://user:secretpass@host:5432/db\nAuthorization: Bearer abc123DEF456ghi789',
  );
  assert.ok(!r.text.includes('secretpass'));
  assert.ok(!r.text.includes('abc123DEF456ghi789'));
});

test('env-value: redacts non-trivial values, skips allowlisted + trivial', () => {
  const env = {
    SECRET: 'sup3r-s3cret-token-value',
    NODE_ENV: 'production',
    PORT: '3000',
    FLAG: 'true',
  };
  const det = makeEnvValueDetector(env, new Set(['NODE_ENV']));
  const r = det.redact(
    'val=sup3r-s3cret-token-value mode=production port=3000 flag=true',
  );
  assert.ok(!r.text.includes('sup3r-s3cret-token-value'));
  // allowlisted + trivial values must remain untouched
  assert.ok(r.text.includes('production'));
  assert.ok(r.text.includes('3000'));
  assert.ok(r.text.includes('true'));
});

test('env-value: longest-first ordering avoids partial leaks', () => {
  const env = { A: 'abcdefghij', B: 'abcdefghijklmnop' };
  const det = makeEnvValueDetector(env, new Set());
  const r = det.redact('x abcdefghijklmnop y');
  assert.ok(!r.text.includes('abcdefghij'));
});

test('denylist: compiles config regexes; bad regex is skipped, not thrown', () => {
  const det = makeDenylistDetector(['INTERNAL-[0-9]{4}', '(unclosed']);
  const r = det.redact('ticket INTERNAL-1234 done');
  assert.ok(!r.text.includes('INTERNAL-1234'));
  assert.ok(r.text.includes('‹redacted:denylist›'));
});

test('entropy: flags a long random token, ignores paths/versions', () => {
  assert.ok(looksHighEntropy('k3J9xQ2pVz7Lm4Nw8Rt5Yb1Hc6Df0Ga2Se9Ui3Ok'));
  assert.ok(!looksHighEntropy('src/auth/handler.ts'));
  assert.ok(!looksHighEntropy('2.1.0'));
  assert.ok(!looksHighEntropy('aaaaaaaaaaaaaaaaaaaaaaaa')); // low entropy
  assert.ok(!looksHighEntropy('short'));
});

test('entropy: detector preserves surrounding structure', () => {
  const r = entropyDetector.redact(
    'config: key="k3J9xQ2pVz7Lm4Nw8Rt5Yb1Hc6Df0Ga2Se9Ui3Ok" done',
  );
  assert.ok(!r.text.includes('k3J9xQ2pVz7Lm4Nw8Rt5Yb1Hc6Df0Ga2Se9Ui3Ok'));
  assert.ok(r.text.includes('key='));
  assert.ok(r.text.includes('done'));
  assert.equal(r.hits, 1);
});

test('shannonEntropy: monotonic sanity', () => {
  assert.ok(shannonEntropy('aaaa') < shannonEntropy('abcd'));
  assert.equal(shannonEntropy(''), 0);
});
