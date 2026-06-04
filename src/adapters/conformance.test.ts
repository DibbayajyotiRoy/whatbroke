/**
 * Cross-adapter conformance — the v0.2 quality bar.
 *
 * For each non-Node adapter we assert two things:
 *   1. it parses a real crash's stderr into structured frames, and
 *   2. the resulting frames flow through `enrichFrames` + the suspect-ranking
 *      moat to surface the in-repo culprit as the #1 suspect.
 *
 * This is the guardrail that "the moat still works" for every new grammar: an
 * adapter that emits a path the ranker can't resolve would silently drop the
 * suspect, and this test would catch it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChangedFile,
  CommandSpec,
  EnvInfo,
  GitInfo,
  ReproInput,
} from '../types.js';
import { enrichFrames } from '../assemble.js';
import { rankSuspects } from '../repro/suspects.js';
import { pythonAdapter, goAdapter, selectAdapter } from './index.js';

const REPO = '/repo';

function env(name: string): EnvInfo {
  return {
    os: { platform: 'linux', release: '6.0', arch: 'x64' },
    runtime: { name, version: '' },
    packageManager: { name: 'unknown', version: null },
    envKeys: [],
    envValues: {},
    cwd: REPO,
  };
}

function git(changed: string[]): GitInfo {
  const changedFiles: ChangedFile[] = changed.map((path) => ({ path, status: ' M' }));
  return {
    isRepo: true,
    branch: 'main',
    head: 'deadbeefcafe1234',
    dirty: changed.length > 0,
    changedFiles,
    greenRef: 'abc1234567890',
    greenRefSource: 'journal',
  };
}

function makeInput(adapterId: string, error: ReproInput['crash']['error'], changed: string[]): ReproInput {
  const crash: ReproInput['crash'] = {
    kind: 'uncaught-exception',
    exitCode: 1,
    signal: null,
  };
  if (error) crash.error = error;
  const command: CommandSpec = { argv: [adapterId], cwd: REPO };
  return {
    crash,
    command,
    context: {
      env: env(adapterId),
      deps: { declared: {}, relevantResolved: {}, lockfile: 'none' },
      git: git(changed),
      collectorErrors: [],
    },
  };
}

// ── Python ──────────────────────────────────────────────────────────────────

const PY_STDERR = `Traceback (most recent call last):
  File "/repo/svc/handler.py", line 42, in handle
    result = compute(payload)
  File "/repo/svc/math.py", line 7, in compute
    return 1 / divisor
ZeroDivisionError: division by zero
`;

test('python: parses traceback into ordered frames', () => {
  const err = pythonAdapter.parseError(PY_STDERR);
  assert.ok(err, 'expected a parsed error');
  assert.equal(err.name, 'ZeroDivisionError');
  assert.equal(err.message, 'division by zero');
  // Most-recent-first: the error site (math.py) is frame 0.
  assert.equal(err.stack.length, 2);
  assert.equal(err.stack[0]?.file, '/repo/svc/math.py');
  assert.equal(err.stack[0]?.line, 7);
  assert.equal(err.stack[0]?.functionName, 'compute');
  assert.equal(err.stack[1]?.file, '/repo/svc/handler.py');
  assert.ok(err.stack[0]?.isUserCode);
});

test('python: culprit on stack AND changed ranks #1 (moat)', () => {
  const err = pythonAdapter.parseError(PY_STDERR);
  assert.ok(err);
  err.stack = enrichFrames(err.stack, REPO, REPO);
  const input = makeInput('python', err, ['svc/math.py']);
  const suspects = rankSuspects(input);
  assert.ok(suspects.length > 0, 'expected suspects');
  assert.equal(suspects[0]?.path, 'svc/math.py');
});

test('python: site-packages frames are not user code', () => {
  const stderr = `Traceback (most recent call last):
  File "/repo/app.py", line 3, in <module>
    requests.get(url)
  File "/usr/lib/python3.11/site-packages/requests/api.py", line 59, in get
    return request("get", url)
RuntimeError: boom
`;
  const err = pythonAdapter.parseError(stderr);
  assert.ok(err);
  const vendor = err.stack.find((f) => f.file?.includes('site-packages'));
  assert.ok(vendor && vendor.isUserCode === false);
});

test('python: keeps the last exception of a chained traceback', () => {
  const stderr = `Traceback (most recent call last):
  File "/repo/a.py", line 1, in <module>
    boom()
ValueError: first

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/repo/b.py", line 2, in <module>
    rethrow()
KeyError: 'second'
`;
  const err = pythonAdapter.parseError(stderr);
  assert.ok(err);
  assert.equal(err.name, 'KeyError');
  assert.equal(err.stack[0]?.file, '/repo/b.py');
});

// ── Go ──────────────────────────────────────────────────────────────────────

const GO_STDERR = `panic: runtime error: index out of range [3] with length 2

goroutine 1 [running]:
main.process(...)
\t/repo/svc/process.go:24 +0x1d
main.main()
\t/repo/cmd/main.go:11 +0x65
exit status 2
`;

test('go: parses panic into two-line frames with func names', () => {
  const err = goAdapter.parseError(GO_STDERR);
  assert.ok(err, 'expected a parsed panic');
  assert.equal(err.name, 'panic');
  assert.match(err.message, /index out of range/);
  assert.equal(err.stack.length, 2);
  // Top-first: process.go is the active frame.
  assert.equal(err.stack[0]?.file, '/repo/svc/process.go');
  assert.equal(err.stack[0]?.line, 24);
  assert.equal(err.stack[0]?.functionName, 'main.process');
  assert.equal(err.stack[1]?.file, '/repo/cmd/main.go');
});

test('go: culprit on stack AND changed ranks #1 (moat)', () => {
  const err = goAdapter.parseError(GO_STDERR);
  assert.ok(err);
  err.stack = enrichFrames(err.stack, REPO, REPO);
  const input = makeInput('go', err, ['svc/process.go']);
  const suspects = rankSuspects(input);
  assert.ok(suspects.length > 0);
  assert.equal(suspects[0]?.path, 'svc/process.go');
});

// ── Detection routing ─────────────────────────────────────────────────────────

test('selectAdapter routes a python traceback to the python adapter', () => {
  const adapter = selectAdapter({
    command: { argv: ['python3', 'app.py'], cwd: REPO },
    cwdEntries: ['app.py', 'requirements.txt', 'package.json'],
    fileExtensions: new Set(['.py']),
    stderrText: PY_STDERR,
    stdoutText: '',
  });
  assert.equal(adapter.id, 'python');
});

test('selectAdapter routes a go panic to the go adapter', () => {
  const adapter = selectAdapter({
    command: { argv: ['go', 'run', './...'], cwd: REPO },
    cwdEntries: ['main.go', 'go.mod'],
    fileExtensions: new Set(['.go']),
    stderrText: GO_STDERR,
    stdoutText: '',
  });
  assert.equal(adapter.id, 'go');
});

test('selectAdapter falls back to node for an unrecognized stack', () => {
  const adapter = selectAdapter({
    command: { argv: ['./mystery-binary'], cwd: REPO },
    cwdEntries: [],
    fileExtensions: new Set(),
    stderrText: 'segfault at 0x0',
    stdoutText: '',
  });
  assert.equal(adapter.id, 'node');
});

test('selectAdapter routes node even when a python file is vendored', () => {
  const adapter = selectAdapter({
    command: { argv: ['npm', 'test'], cwd: REPO },
    cwdEntries: ['package.json', 'package-lock.json', 'script.py'],
    fileExtensions: new Set(['.ts', '.py']),
    stderrText: '    at Object.<anonymous> (/repo/src/a.ts:1:1)',
    stdoutText: '',
  });
  assert.equal(adapter.id, 'node');
});
