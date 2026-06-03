import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from './markdown.js';
import type { Bundle, RedactedBundle } from '../types.js';

function fullBundle(): RedactedBundle {
  const bundle: Bundle = {
    schemaVersion: 1,
    id: 'abc123',
    createdAt: '2026-06-03T00:00:00.000Z',
    tool: { name: 'whatbroke', version: '0.1.0' },
    crash: {
      kind: 'uncaught-exception',
      exitCode: 1,
      signal: null,
      error: {
        name: 'TypeError',
        message: "cannot read 'id' of undefined",
        rawStack:
          "TypeError: cannot read 'id' of undefined\n    at getUser (src/auth.ts:42:10)\n    at node_modules/express/lib/router/index.js:100:5",
        stack: [
          {
            functionName: 'getUser',
            file: '/repo/src/auth.ts',
            fileRelative: 'src/auth.ts',
            line: 42,
            column: 10,
            isUserCode: true,
            isInRepo: true,
            sourceMapped: false,
          },
          {
            functionName: 'handle',
            file: '/repo/node_modules/express/lib/router/index.js',
            fileRelative: null,
            line: 100,
            column: 5,
            isUserCode: false,
            isInRepo: false,
            sourceMapped: false,
          },
        ],
      },
      testFailure: {
        runner: 'vitest',
        failingTests: [{ id: 'auth > returns user', file: 'src/auth.test.ts', message: 'expected 1' }],
        total: 10,
        passed: 9,
        failed: 1,
      },
    },
    environment: {
      os: { platform: 'linux', release: '6.17.9', arch: 'x64' },
      runtime: { node: '20.11.0', v8: '11.3.244' },
      packageManager: { name: 'pnpm', version: '9.1.0' },
      envKeys: ['NODE_ENV'],
      envValues: { NODE_ENV: 'test' },
      cwd: '/repo',
    },
    dependencies: {
      declared: { express: '^4.0.0' },
      relevantResolved: { express: '4.18.2' },
      lockfile: 'pnpm-lock',
    },
    git: {
      isRepo: true,
      branch: 'feature/login',
      head: 'deadbeefcafebabe1234',
      dirty: true,
      changedFiles: [{ path: 'src/auth.ts', status: 'M' }],
      greenRef: 'abc1234567',
      diffVsGreen: {
        base: 'abc1234567def',
        truncated: false,
        patch:
          '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -40,3 +40,3 @@\n-  return user.id;\n+  return user!.id;',
      },
    },
    logs: {
      stdoutTail: 'starting server\nlistening on 3000\n',
      stderrTail: 'TypeError: boom\n',
      truncated: true,
      bufferLines: 500,
    },
    repro: {
      steps: [
        { order: 1, text: 'run pnpm test', provenance: 'observed' },
        { order: 2, text: 'getUser called with undefined', provenance: 'derived' },
      ],
      suspects: [
        { path: 'src/auth.ts', score: 0.92, reasons: ['top frame', 'recently changed'] },
        { path: 'src/db.ts', score: 0.4, reasons: ['imported by auth'] },
      ],
      confidence: 'high',
    },
    redaction: {
      redactedCount: 3,
      rules: [
        { rule: 'aws-key', hits: 1 },
        { rule: 'jwt', hits: 2 },
        { rule: 'entropy', hits: 0 },
      ],
    },
    collectorErrors: [],
  };
  return bundle as unknown as RedactedBundle;
}

test('full bundle renders all sections', () => {
  const md = renderMarkdown(fullBundle());

  // Summary line with error + top frame + confidence.
  assert.match(md, /^## 🐛 TypeError: cannot read 'id' of undefined — first app frame src\/auth\.ts:42:10 · confidence: high/m);

  // Suspects table rows.
  assert.match(md, /\| path \| score \| reasons \|/);
  assert.match(md, /\| src\/auth\.ts \| 0\.92 \| top frame; recently changed \|/);

  // Diff fence with base sha (7 chars).
  assert.match(md, /```diff\n/);
  assert.match(md, /base abc1234/);

  // Redaction footer with count + rule names (zero-hit rule excluded).
  assert.match(md, /_3 values redacted by rules aws-key, jwt\._/);
  assert.doesNotMatch(md, /entropy/);

  // Collapsible details present.
  assert.match(md, /<details>/);
  assert.match(md, /<summary>🎯 Suspect files<\/summary>/);

  // Library frames folded.
  assert.match(md, /1 library frame hidden/);

  // Env bullets.
  assert.match(md, /\*\*Runtime\*\*: node 20\.11\.0, v8 11\.3\.244/);
  assert.match(md, /\*\*Package manager\*\*: pnpm 9\.1\.0/);

  // Git header with short head + dirty.
  assert.match(md, /\*\*feature\/login @ deadbee\*\* \(dirty\)/);

  // Repro provenance tags.
  assert.match(md, /1\. run pnpm test _\(observed\)_/);

  // Test failure detail.
  assert.match(md, /runner: `vitest`/);
});

test('empty bundle: no git repo, no suspects, nonzero-exit with no error', () => {
  const base = fullBundle() as unknown as Bundle;
  const bundle: Bundle = {
    ...base,
    crash: { kind: 'nonzero-exit', exitCode: 2, signal: null },
    git: {
      isRepo: false,
      branch: null,
      head: null,
      dirty: false,
      changedFiles: [],
      greenRef: null,
      note: 'not a git repository',
    },
    dependencies: { declared: {}, relevantResolved: {}, lockfile: 'none' },
    logs: { stdoutTail: '', stderrTail: '', truncated: false, bufferLines: 0 },
    repro: { steps: [], suspects: [], confidence: 'low' },
    redaction: { redactedCount: 0, rules: [] },
  };

  let md = '';
  assert.doesNotThrow(() => {
    md = renderMarkdown(bundle as unknown as RedactedBundle);
  });

  // Summary describes the exit code, not an error.
  assert.match(md, /^## 🐛 nonzero-exit: exited with code 2 · confidence: low/m);

  // Suspects section omitted.
  assert.doesNotMatch(md, /Suspect files/);

  // Git section notes non-repo.
  assert.match(md, /not a git repository/);
  assert.doesNotMatch(md, /```diff/);

  // Dependencies omitted (empty relevantResolved).
  assert.doesNotMatch(md, /Relevant dependencies/);

  // Logs omitted (empty).
  assert.doesNotMatch(md, /<summary>📜 Logs<\/summary>/);

  // Redaction footer says no secrets.
  assert.match(md, /_No secrets detected\._/);
});

test('signal crash summary', () => {
  const base = fullBundle() as unknown as Bundle;
  const bundle: Bundle = {
    ...base,
    crash: { kind: 'signal', exitCode: null, signal: 'SIGSEGV' },
  };
  const md = renderMarkdown(bundle as unknown as RedactedBundle);
  assert.match(md, /^## 🐛 signal: terminated by signal SIGSEGV · confidence: high/m);
});
