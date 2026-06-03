/**
 * MANDATORY secret-regression corpus (06). This is the safety net: a CI-grade
 * test that seeds real-SHAPED-but-FAKE secrets into a full synthetic Bundle
 * across multiple fields, runs redact(), and asserts ZERO fixture value
 * survives anywhere in the resulting JSON. Grow this whenever a near-miss is
 * found.
 *
 * Every value below is fabricated for testing — none is a live credential.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import type { Bundle } from '../types.js';
import { redact } from './redact.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake-but-real-shaped secret corpus. One per known format + high-entropy + env.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES: { name: string; value: string }[] = [
  { name: 'aws-access-key', value: 'AKIAIOSFODNN7EXAMPLE' },
  {
    name: 'aws-secret-line',
    value: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  { name: 'github-classic', value: 'ghp_1234567890abcdefghijABCDEFGHIJ123456' },
  {
    name: 'github-pat',
    value:
      'github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRs',
  },
  { name: 'google-api', value: 'AIzaSyA1234567890abcdefghijklmnopqrstuv' },
  {
    name: 'slack-token',
    // Split literal so GitHub push-protection can't match a real Slack token;
    // the redactor still receives the full reconstructed value at runtime.
    value: 'xox' + 'b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  },
  {
    name: 'jwt',
    value:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
  {
    name: 'connection-string',
    value: 'postgres://admin:s3cr3tP4ssw0rd@db.example.com:5432/app',
  },
  {
    name: 'bearer-header',
    value: 'Authorization: Bearer abcDEF123456ghiJKL789mnoPQR',
  },
  {
    name: 'private-key',
    value:
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ0987654321zyxwvutsrqponmlk\n-----END RSA PRIVATE KEY-----',
  },
  // High-entropy randoms with no known prefix.
  { name: 'entropy-b64', value: 'k3J9xQ2pVz7Lm4Nw8Rt5Yb1Hc6Df0Ga2Se9Ui3Ok7Pn' },
  { name: 'entropy-hex', value: 'a3f5c8d9e1b2470698fe5c3a1d2b4e6f8a9c0d1e2f3a4b5c' },
];

/** An env value that matches no known format but is sensitive by virtue of env. */
const ENV_SECRET_KEY = 'MY_APP_SECRET';
const ENV_SECRET_VALUE = 'Zq-7Wk_pL93mXcv-tunafish-9921';

/** Build a complete, schema-valid Bundle, seeding secrets into several fields. */
function makeSeededBundle(): Bundle {
  const secretsBlob = FIXTURES.map((f) => `${f.name}: ${f.value}`).join('\n');
  return {
    schemaVersion: 1,
    id: 'test-id',
    createdAt: '2026-06-03T00:00:00.000Z',
    tool: { name: 'whatbroke', version: '0.1.0' },
    crash: {
      kind: 'uncaught-exception',
      exitCode: 1,
      signal: null,
      error: {
        name: 'Error',
        message: `boom while using ${FIXTURES[2]!.value} and ${ENV_SECRET_VALUE}`,
        stack: [],
        rawStack: `Error: token ${FIXTURES[6]!.value}\n    at fn (src/a.ts:1:1)`,
      },
      testFailure: {
        runner: 'vitest',
        failingTests: [
          {
            id: 'auth > login',
            file: 'src/auth.test.ts',
            message: `expected ok, got ${FIXTURES[4]!.value}`,
          },
        ],
      },
    },
    environment: {
      os: { platform: 'linux', release: '6.0', arch: 'x64' },
      runtime: { node: 'v20.0.0' },
      packageManager: { name: 'npm', version: '10.0.0' },
      envKeys: [ENV_SECRET_KEY, 'NODE_ENV'],
      envValues: {},
      cwd: '/repo',
    },
    dependencies: { declared: {}, relevantResolved: {}, lockfile: 'none' },
    git: {
      isRepo: true,
      branch: 'main',
      head: 'abc123',
      dirty: true,
      changedFiles: [],
      greenRef: 'def456',
      diffVsGreen: {
        base: 'def456',
        truncated: false,
        patch: `--- a/.env\n+++ b/.env\n${secretsBlob}\n+SECRET=${ENV_SECRET_VALUE}`,
      },
    },
    logs: {
      stdoutTail: `starting\n${secretsBlob}\nenv=${ENV_SECRET_VALUE}`,
      stderrTail: `error using ${FIXTURES[0]!.value}`,
      combinedTail: `${FIXTURES[9]!.value}`,
      truncated: false,
      bufferLines: 100,
    },
    repro: {
      steps: [
        { order: 1, text: `run with ${FIXTURES[5]!.value}`, provenance: 'observed' },
        { order: 2, text: 'observe crash', provenance: 'derived' },
      ],
      suspects: [],
      confidence: 'medium',
      narration: `the token ${FIXTURES[1]!.value} appears in the diff`,
    },
    redaction: { redactedCount: 0, rules: [] },
    collectorErrors: [],
  };
}

test('corpus: zero fixture value survives anywhere in the redacted JSON', () => {
  const bundle = makeSeededBundle();
  const env = { [ENV_SECRET_KEY]: ENV_SECRET_VALUE, NODE_ENV: 'test' };
  const redacted = redact(bundle, { env });
  const json = JSON.stringify(redacted);

  for (const f of FIXTURES) {
    assert.ok(
      !json.includes(f.value),
      `LEAK: fixture "${f.name}" survived redaction`,
    );
  }
  assert.ok(
    !json.includes(ENV_SECRET_VALUE),
    'LEAK: env secret value survived redaction',
  );

  // Report must reflect that redactions happened, and must never store values.
  assert.ok(redacted.redaction.redactedCount > 0);
  for (const r of redacted.redaction.rules) {
    for (const f of FIXTURES) {
      assert.ok(!r.rule.includes(f.value), 'report rule leaked a value');
    }
  }
});

test('corpus: each individual field is scrubbed (no field left raw)', () => {
  const env = { [ENV_SECRET_KEY]: ENV_SECRET_VALUE, NODE_ENV: 'test' };
  const redacted = redact(makeSeededBundle(), { env });

  const fields = [
    redacted.logs.stdoutTail,
    redacted.logs.stderrTail,
    redacted.logs.combinedTail ?? '',
    redacted.crash.error?.message ?? '',
    redacted.crash.error?.rawStack ?? '',
    redacted.crash.testFailure?.failingTests[0]?.message ?? '',
    redacted.git.diffVsGreen?.patch ?? '',
    redacted.repro.narration ?? '',
    ...redacted.repro.steps.map((s) => s.text),
  ];

  for (const field of fields) {
    for (const f of FIXTURES) {
      assert.ok(!field.includes(f.value), `LEAK in field: ${f.name}`);
    }
    assert.ok(!field.includes(ENV_SECRET_VALUE), 'LEAK env value in field');
  }
});

test('property: a random high-entropy env var is scrubbed from logs + diff', () => {
  for (let i = 0; i < 25; i++) {
    const key = `RAND_${randomBytes(4).toString('hex')}`;
    const value = randomBytes(24).toString('base64url'); // ~32 chars, high entropy
    const bundle = makeSeededBundle();
    bundle.logs.stdoutTail = `log line value=${value} end`;
    bundle.logs.stderrTail = `err ${value}`;
    if (bundle.git.diffVsGreen) {
      bundle.git.diffVsGreen.patch = `+CONFIG=${value}`;
    }

    const redacted = redact(bundle, { env: { [key]: value, NODE_ENV: 'test' } });
    assert.ok(!redacted.logs.stdoutTail.includes(value), 'env value in stdout');
    assert.ok(!redacted.logs.stderrTail.includes(value), 'env value in stderr');
    assert.ok(
      !(redacted.git.diffVsGreen?.patch ?? '').includes(value),
      'env value in diff',
    );
  }
});

test('negative: structural fields are NOT mangled by the entropy pass', () => {
  const bundle = makeSeededBundle();
  // Compose a log of purely structural tokens. None should be redacted.
  const structural = [
    'src/auth/handler.ts',
    'packages/core/dist/index.js',
    'version 2.1.0',
    'node v20.11.1',
    'branch main',
    'commit abc123def4567890', // short-ish sha, mixed but < threshold distinct
    'http://localhost:3000/health',
    'Error: Cannot find module ./utils',
  ].join('\n');
  bundle.logs.stdoutTail = structural;
  bundle.logs.stderrTail = '';
  bundle.logs.combinedTail = '';
  bundle.crash = { kind: 'nonzero-exit', exitCode: 1, signal: null };
  if (bundle.git.diffVsGreen) bundle.git.diffVsGreen.patch = '';
  bundle.repro.narration = undefined;
  bundle.repro.steps = [];

  // No env values, so only known-format + entropy run.
  const redacted = redact(bundle, { env: { NODE_ENV: 'test' } });
  assert.equal(
    redacted.logs.stdoutTail,
    structural,
    'structural text was mangled by redaction',
  );
});

test('fail-closed: a field that throws becomes ‹redacted:error› and is reported', () => {
  const bundle = makeSeededBundle();
  // Poison stdoutTail with a value whose .replace throws via a hostile getter.
  // structuredClone copies plain strings, so instead we inject a non-string
  // that violates the type to force the detector chain to throw.
  // @ts-expect-error deliberately violating the type to trigger fail-closed.
  bundle.logs.stdoutTail = { not: 'a string' };

  const redacted = redact(bundle, { env: { NODE_ENV: 'test' } });
  assert.equal(redacted.logs.stdoutTail, '‹redacted:error›');
  const errRule = redacted.redaction.rules.find((r) => r.rule === 'error');
  assert.ok(errRule && errRule.hits >= 1, 'fail-closed not recorded in report');
  // And of course no raw object content leaked.
  assert.ok(!JSON.stringify(redacted).includes('not'));
});
