/**
 * Unit coverage for the redact() gate orchestration: cloning, envValues policy,
 * entropy toggle, denylist-add-only invariant, and report shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Bundle } from '../types.js';
import { DEFAULT_ALLOW_ENV, redact } from './redact.js';

function baseBundle(): Bundle {
  return {
    schemaVersion: 1,
    id: 'id',
    createdAt: '2026-06-03T00:00:00.000Z',
    tool: { name: 'whatbroke', version: '0.1.0' },
    crash: { kind: 'nonzero-exit', exitCode: 1, signal: null },
    environment: {
      os: { platform: 'linux', release: '6.0', arch: 'x64' },
      runtime: { node: 'v20.0.0' },
      packageManager: { name: 'npm', version: '10.0.0' },
      envKeys: [],
      envValues: {},
      cwd: '/repo',
    },
    dependencies: { declared: {}, relevantResolved: {}, lockfile: 'none' },
    git: { isRepo: false, branch: null, head: null, dirty: false, changedFiles: [], greenRef: null },
    logs: { stdoutTail: '', stderrTail: '', truncated: false, bufferLines: 0 },
    repro: { steps: [], suspects: [], confidence: 'low' },
    redaction: { redactedCount: 0, rules: [] },
    collectorErrors: [],
  };
}

test('redact does not mutate the input bundle (deep clone)', () => {
  const b = baseBundle();
  b.logs.stdoutTail = 'token AKIAIOSFODNN7EXAMPLE';
  const before = b.logs.stdoutTail;
  redact(b, { env: {} });
  assert.equal(b.logs.stdoutTail, before, 'input bundle was mutated');
});

test('envValues: only allowlisted keys are populated, with verbatim values', () => {
  const b = baseBundle();
  const env = {
    NODE_ENV: 'production',
    HOME: '/home/roy',
    SECRET_TOKEN: 'this-is-a-very-secret-value-123',
  };
  const r = redact(b, { env });
  assert.equal(r.environment.envValues.NODE_ENV, 'production');
  assert.equal(r.environment.envValues.HOME, '/home/roy');
  assert.ok(!('SECRET_TOKEN' in r.environment.envValues), 'leaked non-allowlisted key');
});

test('envValues: allowlisted values are not entropy-scrubbed even if long/random', () => {
  const b = baseBundle();
  // PATH-like value is allowlisted and should survive verbatim.
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin:/opt/k3J9xQ2pVz7Lm4Nw8Rt5Yb' };
  const r = redact(b, { env });
  assert.equal(r.environment.envValues.PATH, env.PATH);
});

test('entropy toggle: opts.entropy === false disables the entropy pass', () => {
  const b = baseBundle();
  const token = 'k3J9xQ2pVz7Lm4Nw8Rt5Yb1Hc6Df0Ga2Se9Ui3Ok';
  b.logs.stdoutTail = `value ${token}`;
  const off = redact(b, { env: {}, entropy: false });
  assert.ok(off.logs.stdoutTail.includes(token), 'entropy ran despite being off');
  const on = redact(baseBundle(), { env: {} }); // default on
  const b2 = baseBundle();
  b2.logs.stdoutTail = `value ${token}`;
  assert.ok(!redact(b2, { env: {} }).logs.stdoutTail.includes(token));
  void on;
});

test('denylist can only ADD redaction; built-ins still fire', () => {
  const b = baseBundle();
  b.logs.stdoutTail = 'AKIAIOSFODNN7EXAMPLE and CUSTOMTAG-42';
  const r = redact(b, { env: {}, denyPatterns: ['CUSTOMTAG-[0-9]+'] });
  assert.ok(!r.logs.stdoutTail.includes('AKIAIOSFODNN7EXAMPLE'), 'built-in suppressed');
  assert.ok(!r.logs.stdoutTail.includes('CUSTOMTAG-42'), 'denylist did not fire');
});

test('report: counts hits and never stores values', () => {
  const b = baseBundle();
  b.logs.stdoutTail = 'AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE';
  const r = redact(b, { env: {} });
  assert.ok(r.redaction.redactedCount >= 2);
  const aws = r.redaction.rules.find((x) => x.rule === 'aws-access-key');
  assert.ok(aws && aws.hits === 2);
  assert.ok(!JSON.stringify(r.redaction).includes('AKIA'));
});

test('DEFAULT_ALLOW_ENV contains the expected baseline keys', () => {
  for (const k of ['NODE_ENV', 'CI', 'TZ', 'LANG', 'LC_ALL', 'PATH', 'HOME', 'SHELL', 'TERM', 'PWD']) {
    assert.ok(DEFAULT_ALLOW_ENV.includes(k), `missing allow key ${k}`);
  }
});

test('custom allowEnv overrides the default allowlist', () => {
  const b = baseBundle();
  const env = { NODE_ENV: 'production', ONLY_THIS: 'keepvalue1234567' };
  const r = redact(b, { env, allowEnv: ['ONLY_THIS'] });
  assert.equal(r.environment.envValues.ONLY_THIS, 'keepvalue1234567');
  assert.ok(!('NODE_ENV' in r.environment.envValues));
});
