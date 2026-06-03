import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCrash } from './classify.js';

test('exit 0 with no signal is a green run (null)', () => {
  assert.equal(
    classifyCrash({ exitCode: 0, signal: null, stderrText: '' }),
    null,
  );
});

test('nonzero exit with no error markers is nonzero-exit', () => {
  const c = classifyCrash({ exitCode: 3, signal: null, stderrText: 'nope\n' });
  assert.ok(c);
  assert.equal(c.kind, 'nonzero-exit');
  assert.equal(c.exitCode, 3);
  assert.equal(c.signal, null);
  assert.equal(c.error, undefined);
});

test('signal termination is kind signal', () => {
  const c = classifyCrash({
    exitCode: null,
    signal: 'SIGSEGV',
    stderrText: '',
  });
  assert.ok(c);
  assert.equal(c.kind, 'signal');
  assert.equal(c.signal, 'SIGSEGV');
  assert.equal(c.exitCode, null);
});

test('signal wins over stderr error content', () => {
  const c = classifyCrash({
    exitCode: null,
    signal: 'SIGKILL',
    stderrText: 'Error: boom\n    at x (/a.ts:1:1)\n',
  });
  assert.ok(c);
  assert.equal(c.kind, 'signal');
});

test('uncaught exception banner upgrades classification', () => {
  const stderr = [
    '/abs/file.ts:3',
    "throw new Error('boom');",
    '^',
    '',
    'Error: boom',
    '    at Object.<anonymous> (/abs/file.ts:3:7)',
    '    at node:internal/modules/cjs/loader:1234:14',
    '',
    'Node.js v20.0.0',
  ].join('\n');
  const c = classifyCrash({ exitCode: 1, signal: null, stderrText: stderr });
  assert.ok(c);
  assert.equal(c.kind, 'uncaught-exception');
  assert.ok(c.error);
  assert.equal(c.error.name, 'Error');
  assert.equal(c.error.message, 'boom');
  assert.ok(c.rawErrorBlock);
});

test('unhandled rejection upgrades classification', () => {
  const stderr = [
    'node:internal/process/promises:288',
    'UnhandledPromiseRejection: This error originated...',
    '    at /abs/file.ts:5:1',
  ].join('\n');
  const c = classifyCrash({ exitCode: 1, signal: null, stderrText: stderr });
  assert.ok(c);
  assert.equal(c.kind, 'unhandled-rejection');
});

test('nonzero exit still attaches a parsed error block when present', () => {
  const stderr = 'TypeError: bad\n    at run (/a.ts:1:1)\n';
  const c = classifyCrash({ exitCode: 1, signal: null, stderrText: stderr });
  assert.ok(c);
  assert.ok(c.error);
  assert.equal(c.error.name, 'TypeError');
});
