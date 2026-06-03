import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ReproInput,
  StackFrame,
  ChangedFile,
  CrashSignal,
  EnvInfo,
  GitInfo,
  CommandSpec,
} from '../types.js';
import { rankSuspects } from './suspects.js';
import { computeConfidence } from './confidence.js';
import { reconstruct } from './reconstruct.js';

// ── Fixture builders ───────────────────────────────────────────────────────

function frame(
  fileRelative: string | null,
  line: number,
  opts: { isUserCode?: boolean; functionName?: string; file?: string } = {},
): StackFrame {
  const isUserCode = opts.isUserCode ?? true;
  return {
    functionName: opts.functionName ?? 'fn',
    file: opts.file ?? (fileRelative ? `/repo/${fileRelative}` : null),
    fileRelative,
    line,
    column: 1,
    isUserCode,
    isInRepo: isUserCode,
    sourceMapped: false,
  };
}

function nodeModulesFrame(pkgRel: string, line: number): StackFrame {
  return {
    functionName: 'libFn',
    file: `/repo/node_modules/${pkgRel}`,
    fileRelative: `node_modules/${pkgRel}`,
    line,
    column: 1,
    isUserCode: false,
    isInRepo: false,
    sourceMapped: false,
  };
}

function changed(path: string): ChangedFile {
  return { path, status: ' M' };
}

function defaultEnv(): EnvInfo {
  return {
    os: { platform: 'linux', release: '6.0', arch: 'x64' },
    runtime: { node: 'v20.11.0' },
    packageManager: { name: 'npm', version: '10.2.0' },
    envKeys: [],
    envValues: {},
    cwd: '/repo',
  };
}

function defaultGit(overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    isRepo: true,
    branch: 'main',
    head: 'deadbeefcafe1234',
    dirty: true,
    changedFiles: [],
    greenRef: 'abc1234567890',
    greenRefSource: 'journal',
    ...overrides,
  };
}

function makeInput(opts: {
  stack?: StackFrame[];
  changedFiles?: ChangedFile[];
  git?: Partial<GitInfo>;
  command?: CommandSpec;
  errorName?: string;
  errorMessage?: string;
  crash?: Partial<CrashSignal>;
  env?: EnvInfo;
  testFailure?: ReproInput['context']['testFailure'];
}): ReproInput {
  const stack = opts.stack ?? [];
  const error =
    opts.errorName !== undefined || stack.length > 0
      ? {
          name: opts.errorName ?? 'TypeError',
          message: opts.errorMessage ?? 'boom',
          stack,
          rawStack: 'raw',
        }
      : undefined;

  const crash: CrashSignal = {
    kind: 'uncaught-exception',
    exitCode: 1,
    signal: null,
    ...(error ? { error } : {}),
    ...opts.crash,
  };

  const git = defaultGit({
    ...opts.git,
    ...(opts.changedFiles ? { changedFiles: opts.changedFiles } : {}),
  });

  return {
    crash,
    context: {
      env: opts.env ?? defaultEnv(),
      deps: { declared: {}, relevantResolved: {}, lockfile: 'package-lock' },
      git,
      ...(opts.testFailure ? { testFailure: opts.testFailure } : {}),
      collectorErrors: [],
    },
    command: opts.command ?? { argv: ['npm', 'test'], cwd: '/repo' },
  };
}

// ── THE CORE EVAL: the product's quality bar ─────────────────────────────────

test('CORE EVAL: edited file on stack frame 1 + changed-since-green is suspects[0] with both signals, confidence high', () => {
  const input = makeInput({
    stack: [
      frame('src/auth.ts', 42),
      frame('src/server.ts', 10),
      nodeModulesFrame('express/lib/router.js', 100),
    ],
    changedFiles: [changed('src/auth.ts'), changed('README.md')],
    git: { greenRef: 'abc1234aaaa' },
  });

  const suspects = rankSuspects(input);
  assert.ok(suspects.length > 0, 'expected suspects');

  const top = suspects[0]!;
  assert.equal(top.path, 'src/auth.ts', 'auth.ts must lead the ranking');

  // Both signals must be spelled out in reasons.
  const reasonText = top.reasons.join(' | ');
  assert.match(reasonText, /on stack at frame 1/);
  assert.match(reasonText, /changed since green/);
  assert.match(reasonText, /abc1234/, 'green sha should appear in reason');

  assert.equal(computeConfidence(input), 'high');

  const info = reconstruct(input);
  assert.equal(info.confidence, 'high');
  assert.equal(info.suspects[0]!.path, 'src/auth.ts');
});

test('changed-but-not-on-stack ranks below on-stack-and-changed', () => {
  const input = makeInput({
    stack: [frame('src/auth.ts', 42)],
    changedFiles: [changed('src/auth.ts'), changed('src/unrelated.ts')],
  });
  const suspects = rankSuspects(input);
  const authIdx = suspects.findIndex((s) => s.path === 'src/auth.ts');
  const unrelatedIdx = suspects.findIndex((s) => s.path === 'src/unrelated.ts');
  assert.ok(authIdx >= 0 && unrelatedIdx >= 0);
  assert.ok(authIdx < unrelatedIdx, 'on-stack+changed must outrank changed-only');
  assert.ok(
    suspects[authIdx]!.score > suspects[unrelatedIdx]!.score,
    'score must be strictly higher',
  );
});

// ── Confidence ───────────────────────────────────────────────────────────────

test('no greenRef → confidence low', () => {
  const input = makeInput({
    stack: [frame('src/auth.ts', 42)],
    changedFiles: [changed('src/auth.ts')],
    git: { greenRef: null, greenRefSource: 'none' },
  });
  assert.equal(computeConfidence(input), 'low');
});

test('no user-code frame → confidence low', () => {
  const input = makeInput({
    stack: [nodeModulesFrame('express/lib/router.js', 100)],
    changedFiles: [changed('src/auth.ts')],
  });
  assert.equal(computeConfidence(input), 'low');
});

test('not a git repo → confidence low', () => {
  const input = makeInput({
    stack: [frame('src/auth.ts', 42)],
    git: { isRepo: false, branch: null, head: null, greenRef: null },
  });
  assert.equal(computeConfidence(input), 'low');
});

test('greenRef + user frame but no intersection → confidence medium', () => {
  const input = makeInput({
    stack: [frame('src/auth.ts', 42)],
    changedFiles: [changed('src/other.ts')],
  });
  assert.equal(computeConfidence(input), 'medium');
});

// ── Steps assembly ──────────────────────────────────────────────────────────

test('steps assembly: order, provenance tiers, verbatim command', () => {
  const input = makeInput({
    stack: [frame('src/auth.ts', 42)],
    changedFiles: [changed('src/auth.ts'), changed('package.json')],
    command: { argv: ['npm', 'run', 'test', '--', '--bail'], cwd: '/repo' },
    errorName: 'TypeError',
    errorMessage: "Cannot read properties of undefined (reading 'id')",
  });

  const info = reconstruct(input);
  const texts = info.steps.map((s) => s.text);

  // Orders are sequential starting at 1.
  info.steps.forEach((s, i) => assert.equal(s.order, i + 1));

  // 1. Starting state (observed).
  assert.equal(info.steps[0]!.provenance, 'observed');
  assert.match(texts[0]!, /^On branch `main` at `deadbee` \(dirty: 2 files\)\.$/);

  // Setup deltas (derived) appear and mention green sha + dependency change.
  const derivedTexts = info.steps
    .filter((s) => s.provenance === 'derived')
    .map((s) => s.text)
    .join('\n');
  assert.match(derivedTexts, /Since last passing run \(`abc1234`\): 2 files changed/);
  assert.match(derivedTexts, /dependency\/lockfile change/);
  assert.match(derivedTexts, /package\.json/);

  // The action — verbatim command line, joined exactly.
  const action = texts.find((t) => t.startsWith('Run:'));
  assert.ok(action);
  assert.equal(action, 'Run: `npm run test -- --bail` (cwd: `.`).');

  // Observed result — error name + message.
  const result = texts.find((t) => t.includes('Cannot read properties'));
  assert.ok(result);
  assert.equal(
    result,
    "TypeError: Cannot read properties of undefined (reading 'id')",
  );

  // Where — first app frame (derived).
  const where = texts.find((t) => t.startsWith('First app frame:'));
  assert.equal(where, 'First app frame: `src/auth.ts:42`.');

  // Provenance tiers per the spec.
  const byText = new Map(info.steps.map((s) => [s.text, s.provenance]));
  assert.equal(byText.get(action!), 'observed');
  assert.equal(byText.get(result!), 'observed');
  assert.equal(byText.get(where!), 'derived');

  // Suspects are heuristic and live OUTSIDE steps.
  assert.ok(!texts.some((t) => /suspect/i.test(t)));
});

test('absent inputs omit their steps', () => {
  // No git repo, no greenRef, no error, no user frames, signal crash.
  const input = makeInput({
    stack: [],
    git: { isRepo: false, branch: null, head: null, greenRef: null, dirty: false },
    command: { argv: ['./run.sh'], cwd: '/somewhere/else' },
    crash: { kind: 'signal', exitCode: null, signal: 'SIGSEGV' },
    env: {
      os: { platform: '', release: '', arch: '' },
      runtime: { node: '' },
      packageManager: { name: 'unknown', version: null },
      envKeys: [],
      envValues: {},
      cwd: '/somewhere',
    },
  });

  const info = reconstruct(input);
  const texts = info.steps.map((s) => s.text);

  // No starting-state step (not a repo).
  assert.ok(!texts.some((t) => t.startsWith('On branch')));
  // No setup-deltas step (no greenRef).
  assert.ok(!texts.some((t) => t.startsWith('Since last passing run')));
  // No environment step (nothing notable).
  assert.ok(!texts.some((t) => t.startsWith('Environment:')));
  // No "where" step (no user frame).
  assert.ok(!texts.some((t) => t.startsWith('First app frame')));

  // The action still appears, and result is the signal.
  assert.ok(texts.some((t) => t === 'Run: `./run.sh` (cwd: `else`).'));
  assert.ok(texts.some((t) => t === 'Terminated by signal SIGSEGV.'));
});

test('test-failure result line', () => {
  const input = makeInput({
    stack: [],
    crash: { kind: 'nonzero-exit', exitCode: 1, signal: null },
    testFailure: {
      runner: 'node:test',
      failingTests: [
        { id: 'auth > rejects bad token', file: 'test/auth.test.ts' },
        { id: 'auth > expires session', file: 'test/auth.test.ts' },
      ],
      total: 10,
      failed: 2,
      passed: 8,
    },
  });
  const info = reconstruct(input);
  const result = info.steps.find((s) => s.text.includes('tests failed'));
  assert.ok(result);
  assert.equal(
    result.text,
    '2 of 10 tests failed: auth > rejects bad token, auth > expires session.',
  );
});

// ── Determinism ──────────────────────────────────────────────────────────────

test('determinism: same input twice → deep-equal output', () => {
  const build = (): ReproInput =>
    makeInput({
      stack: [
        frame('src/auth.ts', 42),
        frame('src/server.ts', 10),
        nodeModulesFrame('express/lib/router.js', 100),
      ],
      changedFiles: [
        changed('src/auth.ts'),
        changed('src/server.ts'),
        changed('package.json'),
        changed('docs/x.md'),
      ],
    });

  const a = reconstruct(build());
  const b = reconstruct(build());
  assert.deepEqual(a, b);

  // Suspect ranking alone is also deterministic.
  assert.deepEqual(rankSuspects(build()), rankSuspects(build()));
});

// ── No-signal edge: empty result ─────────────────────────────────────────────

test('no signals at all → empty suspects', () => {
  const input = makeInput({
    stack: [],
    changedFiles: [],
    errorName: undefined,
  });
  assert.deepEqual(rankSuspects(input), []);
});

test('node_modules-only frame yields low-weight suspect', () => {
  const input = makeInput({
    stack: [nodeModulesFrame('express/lib/router.js', 100)],
    changedFiles: [],
  });
  const suspects = rankSuspects(input);
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0]!.score, 0.5);
  assert.match(suspects[0]!.reasons.join(' '), /node_modules/);
});
