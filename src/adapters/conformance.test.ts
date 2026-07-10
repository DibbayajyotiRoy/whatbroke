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
import { pythonAdapter, goAdapter, selectAdapter, registerAdapter } from './index.js';
import { makeDeclarativeAdapter } from './declarative.js';
import type { StackGrammar } from './grammar.js';

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

// ── Third-party grammar conformance (the extension gate) ─────────────────────
//
// Proof that a brand-new language needs ZERO core changes: define a
// `StackGrammar` (pure data), wrap it with `makeDeclarativeAdapter`, register
// it — and it flows through the exact parse → enrich → rank pipeline the
// built-ins use. 'toylang' below is deliberately made up; if it passes, any
// grammar built the same way passes. docs/adding-a-language.md walks a
// third-party author through this example step by step.

const toyGrammar: StackGrammar = {
  id: 'toylang',
  detect: {
    commands: [/\btoyc\b/],
    extensions: ['.toy'],
    cwdFiles: ['toy.manifest'],
    stderrMarkers: [/^!! crash:/m],
  },
  error: {
    // Top-of-block header (Go-style): `!! crash: Name: message`.
    header: /^!! crash: (?<name>[A-Za-z_]\w*): (?<message>.*)$/,
    headerAfterFrames: false,
  },
  frame: {
    // Two-line frames: a `-> func()` line, then an indented location line.
    line: /^\s+in (?<file>\S+) line (?<line>\d+)$/,
    funcLine: /^-> (?<func>[\w.]+)\(\)$/,
    order: 'top-first',
  },
  userCode: { vendorPatterns: [/[\\/]toy_modules[\\/]/] },
  crashKinds: [{ pattern: /^!! crash: OutOfGears:/m, kind: 'nonzero-exit' }],
};

const toyAdapter = makeDeclarativeAdapter(toyGrammar);

const TOY_STDERR = `spinning up gizmo
!! crash: GizmoJamError: spinner jammed after 3 spins
-> spin_up()
   in /repo/gizmo/spinner.toy line 12
-> gear_mesh()
   in /repo/toy_modules/gears.toy line 44
-> boot()
   in /repo/main.toy line 3
`;

test('toylang: third-party grammar parses two-line frames with zero core changes', () => {
  const err = toyAdapter.parseError(TOY_STDERR);
  assert.ok(err, 'expected a parsed toy crash');
  assert.equal(err.name, 'GizmoJamError');
  assert.equal(err.message, 'spinner jammed after 3 spins');
  assert.equal(err.stack.length, 3);
  // top-first order is preserved; funcLine names carry onto location lines.
  assert.equal(err.stack[0]?.file, '/repo/gizmo/spinner.toy');
  assert.equal(err.stack[0]?.line, 12);
  assert.equal(err.stack[0]?.functionName, 'spin_up');
  assert.equal(err.stack[0]?.isUserCode, true);
  assert.equal(err.stack[1]?.isUserCode, false); // toy_modules/ is vendor
  assert.equal(err.stack[2]?.file, '/repo/main.toy');
  assert.equal(err.stack[2]?.functionName, 'boot');
});

test('toylang: culprit on stack AND changed ranks #1 through the shared moat', () => {
  const err = toyAdapter.parseError(TOY_STDERR);
  assert.ok(err);
  err.stack = enrichFrames(err.stack, REPO, REPO);
  const input = makeInput('toylang', err, ['gizmo/spinner.toy']);
  const suspects = rankSuspects(input);
  assert.ok(suspects.length > 0, 'expected suspects');
  assert.equal(suspects[0]?.path, 'gizmo/spinner.toy');
});

test('toylang: classify upgrades the kind and honors declarative crashKinds', () => {
  const err = toyAdapter.parseError(TOY_STDERR);
  const crash = toyAdapter.classify({
    exitCode: 1,
    signal: null,
    stderrText: TOY_STDERR,
    error: err,
  });
  assert.ok(crash, 'nonzero exit must classify as a crash');
  assert.equal(crash.kind, 'uncaught-exception'); // parsed error upgrades the kind

  const gearsStderr = `!! crash: OutOfGears: gearbox empty
-> boot()
   in /repo/main.toy line 3
`;
  const gearsCrash = toyAdapter.classify({
    exitCode: 3,
    signal: null,
    stderrText: gearsStderr,
    error: toyAdapter.parseError(gearsStderr),
  });
  assert.ok(gearsCrash);
  assert.equal(gearsCrash.kind, 'nonzero-exit'); // crashKinds override wins
});

test('toylang: registers and routes via the registry without disturbing the fallback', () => {
  registerAdapter(toyAdapter);
  const picked = selectAdapter({
    command: { argv: ['toyc', 'run', 'main.toy'], cwd: REPO },
    cwdEntries: ['main.toy', 'toy.manifest'],
    fileExtensions: new Set(['.toy']),
    stderrText: TOY_STDERR,
    stdoutText: '',
  });
  assert.equal(picked.id, 'toylang');
  // The node fallback still owns unrecognized crashes after registration.
  const fallback = selectAdapter({
    command: { argv: ['./mystery-binary'], cwd: REPO },
    cwdEntries: [],
    fileExtensions: new Set(),
    stderrText: 'segfault at 0x0',
    stdoutText: '',
  });
  assert.equal(fallback.id, 'node');
});
