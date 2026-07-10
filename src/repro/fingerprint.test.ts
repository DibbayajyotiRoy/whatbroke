import test from 'node:test';
import assert from 'node:assert/strict';
import type { CrashInfo, CrashKind, StackFrame, TestFailure } from '../types.js';
import {
  RULES,
  normalizeMessage,
  crashFingerprint,
  compareCrashes,
} from './fingerprint.js';

// ── Fixture builders ─────────────────────────────────────────────────────────

function frame(
  fileRelative: string | null,
  line: number,
  opts: {
    functionName?: string | null;
    isInRepo?: boolean;
    file?: string | null;
    column?: number;
  } = {},
): StackFrame {
  const isInRepo = opts.isInRepo ?? true;
  return {
    functionName: opts.functionName === undefined ? 'fn' : opts.functionName,
    file:
      opts.file === undefined
        ? fileRelative
          ? `/repo/${fileRelative}`
          : null
        : opts.file,
    fileRelative,
    line,
    column: opts.column ?? 1,
    isUserCode: isInRepo,
    isInRepo,
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

interface MakeCrashOpts {
  kind?: CrashKind;
  exitCode?: number | null;
  signal?: string | null;
  name?: string;
  message?: string;
  frames?: StackFrame[];
  testFailure?: TestFailure;
}

function makeCrash(opts: MakeCrashOpts = {}): CrashInfo {
  const kind = opts.kind ?? 'uncaught-exception';
  const crash: CrashInfo = {
    kind,
    exitCode:
      opts.exitCode !== undefined ? opts.exitCode : kind === 'signal' ? null : 1,
    signal:
      opts.signal !== undefined ? opts.signal : kind === 'signal' ? 'SIGSEGV' : null,
  };
  if (opts.name !== undefined || opts.message !== undefined || opts.frames !== undefined) {
    crash.error = {
      name: opts.name ?? 'Error',
      message: opts.message ?? 'boom',
      stack: opts.frames ?? [frame('src/app.ts', 10, { functionName: 'main' })],
      rawStack: 'raw',
    };
  }
  if (opts.testFailure) {
    crash.testFailure = opts.testFailure;
  }
  return crash;
}

function applyRule(name: string, input: string): string {
  const rule = RULES.find((r) => r.name === name);
  assert.ok(rule, `expected a rule named ${name}`);
  return rule.apply(input);
}

function assertPair(
  a: CrashInfo,
  b: CrashInfo,
  verdict: 'same' | 'related' | 'different',
  substrings: string[],
): void {
  const result = compareCrashes(a, b);
  assert.equal(
    result.verdict,
    verdict,
    `expected ${verdict}; reasons: ${result.reasons.join(' | ')}`,
  );
  assert.ok(result.reasons.length > 0, 'reasons must not be empty');
  for (const s of substrings) {
    assert.ok(
      result.reasons.some((r) => r.includes(s)),
      `expected a reason containing ${JSON.stringify(s)}; got: ${result.reasons.join(' | ')}`,
    );
  }
}

// ── Normalizer rules in isolation ────────────────────────────────────────────

test('rule timestamp: ISO/space/RFC-1123 datetimes become ‹ts›', () => {
  assert.equal(
    applyRule('timestamp', 'failed at 2024-01-15T10:30:22.123Z (retry)'),
    'failed at ‹ts› (retry)',
  );
  assert.equal(applyRule('timestamp', 'since 2024-01-15 10:30:22'), 'since ‹ts›');
  assert.equal(
    applyRule('timestamp', 'expired Mon, 15 Jan 2024 10:30:22 GMT'),
    'expired ‹ts›',
  );
  assert.ok(!applyRule('timestamp', 'at 2024-01-15T10:30:22Z').includes('2024'));
});

test('rule uuid: UUIDs become ‹uuid›', () => {
  const out = applyRule('uuid', 'job 550e8400-e29b-41d4-a716-446655440000 died');
  assert.equal(out, 'job ‹uuid› died');
  assert.ok(!out.includes('550e8400'));
});

test('rule tmp-path: unix, macOS, and windows temp paths become ‹tmp›', () => {
  assert.equal(applyRule('tmp-path', "open '/tmp/wb-1a2b/out.json'"), "open '‹tmp›'");
  assert.equal(
    applyRule('tmp-path', 'at /var/folders/zz/rst12/T/pkg-9/x.js line'),
    'at ‹tmp› line',
  );
  const win = applyRule(
    'tmp-path',
    'wrote C:\\Users\\bob\\AppData\\Local\\Temp\\wb\\a.log ok',
  );
  assert.equal(win, 'wrote ‹tmp› ok');
  assert.ok(!win.includes('AppData'));
});

test('rule hex-address: 0x… addresses become ‹hex›', () => {
  const out = applyRule('hex-address', 'segfault at 0xDEADbeef00');
  assert.equal(out, 'segfault at ‹hex›');
  assert.ok(!out.includes('0xDEADbeef00'));
});

test('rule port: host:port, bare :port, and "port N" become ‹port›', () => {
  assert.equal(
    applyRule('port', 'listening on localhost:3000'),
    'listening on localhost:‹port›',
  );
  assert.equal(
    applyRule('port', 'connect to 127.0.0.1:54321 failed'),
    'connect to 127.0.0.1:‹port› failed',
  );
  assert.equal(applyRule('port', 'in use :::3000'), 'in use :::‹port›');
  assert.equal(applyRule('port', 'port 8080 busy'), 'port ‹port› busy');
  assert.ok(!applyRule('port', 'localhost:3000').includes('3000'));
});

test('rule duration: 123ms / 4.5s / 30 seconds become ‹dur›', () => {
  const out = applyRule('duration', 'took 123ms then 4.5s total');
  assert.equal(out, 'took ‹dur› then ‹dur› total');
  assert.ok(!out.includes('123ms'));
  assert.equal(
    applyRule('duration', 'timeout after 30 seconds'),
    'timeout after ‹dur›',
  );
});

test('rule pid: pid/process numbers become ‹pid›', () => {
  assert.equal(applyRule('pid', 'pid 1234 exited'), 'pid ‹pid› exited');
  assert.equal(applyRule('pid', 'killed process 42'), 'killed process ‹pid›');
  assert.equal(applyRule('pid', 'PID: 9999'), 'PID: ‹pid›');
  assert.ok(!applyRule('pid', 'pid 1234').includes('1234'));
});

test('rule long-id: 8+ char mixed-alnum ids become ‹id›, words survive', () => {
  assert.equal(
    applyRule('long-id', 'bundle lq8x3k-7f9a2c written'),
    'bundle ‹id› written',
  );
  assert.equal(applyRule('long-id', 'commit deadbeefcafe1234'), 'commit ‹id›');
  // Ordinary words, short tokens, and identifiers are untouched.
  assert.equal(
    applyRule('long-id', 'TypeError undefined base64 x2'),
    'TypeError undefined base64 x2',
  );
});

test('rule whitespace: runs of whitespace collapse to single spaces', () => {
  assert.equal(applyRule('whitespace', '  a   b\n\tc  '), 'a b c');
});

test('normalizeMessage: all volatile classes replaced in one message', () => {
  const msg =
    'Error at 2024-01-15T10:30:22Z: connect localhost:5432 failed after 1500ms ' +
    '(pid 4242) in /tmp/wb-run-8f3a2c1b/job, request 550e8400-e29b-41d4-a716-446655440000, ' +
    'buf 0x7fff5fbb, run lq8x3k-7f9a2c';
  assert.equal(
    normalizeMessage(msg),
    'Error at ‹ts›: connect localhost:‹port› failed after ‹dur› (pid ‹pid›) in ‹tmp›, ' +
      'request ‹uuid›, buf ‹hex›, run ‹id›',
  );
});

// ── Fingerprint basics ───────────────────────────────────────────────────────

test('crashFingerprint returns 16 lowercase hex chars', () => {
  assert.match(crashFingerprint(makeCrash({ name: 'Error', message: 'x' })), /^[0-9a-f]{16}$/);
});

test('fingerprint excludes line and column numbers', () => {
  const a = makeCrash({
    name: 'TypeError',
    message: 'boom',
    frames: [frame('src/auth.ts', 42, { functionName: 'login', column: 3 })],
  });
  const b = makeCrash({
    name: 'TypeError',
    message: 'boom',
    frames: [frame('src/auth.ts', 217, { functionName: 'login', column: 99 })],
  });
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assert.equal(compareCrashes(a, b).verdict, 'same');
});

test('determinism: clones, key order, and extra properties do not change output', () => {
  const tf: TestFailure = {
    runner: 'node:test',
    failingTests: [{ id: 'auth > rejects bad token', file: 'test/auth.test.ts' }],
    total: 10,
    failed: 1,
    passed: 9,
  };
  const base = makeCrash({
    kind: 'unhandled-rejection',
    name: 'Error',
    message: 'x 0xdead1234 y at 2024-01-15T00:00:00Z',
    frames: [frame('src/q.ts', 7, { functionName: 'poll' })],
    testFailure: tf,
  });
  const fp = crashFingerprint(base);
  assert.equal(crashFingerprint(base), fp, 'second call on the same object');
  assert.equal(crashFingerprint(structuredClone(base)), fp, 'structured clone');

  // Different top-level key order plus an extra unknown property.
  const reordered = {
    zzzExtra: 'ignored',
    signal: base.signal,
    testFailure: structuredClone(base.testFailure),
    error: structuredClone(base.error),
    exitCode: base.exitCode,
    kind: base.kind,
  } as unknown as CrashInfo;
  assert.equal(crashFingerprint(reordered), fp, 'key order + extra props');
});

test('determinism: compareCrashes twice yields deep-equal results', () => {
  const a = makeCrash({
    name: 'TypeError',
    message: 'boom at 0xabc123',
    frames: [frame('src/a.ts', 1, { functionName: 'f' })],
  });
  const b = makeCrash({
    name: 'RangeError',
    message: 'other',
    frames: [frame('src/b.ts', 2, { functionName: 'g' })],
  });
  assert.deepEqual(compareCrashes(a, b), compareCrashes(a, b));
  assert.deepEqual(
    compareCrashes(structuredClone(a), structuredClone(b)),
    compareCrashes(a, b),
  );
  assert.deepEqual(compareCrashes(a, structuredClone(a)), compareCrashes(a, a));
});

// ── Corpus: crash pairs ──────────────────────────────────────────────────────

test('corpus 1: identical except ISO timestamp → same', () => {
  const at = (ts: string) =>
    makeCrash({
      name: 'FetchError',
      message: `request to /api failed at ${ts}`,
      frames: [frame('src/net/client.ts', 42, { functionName: 'request' })],
    });
  const a = at('2024-01-15T10:30:22.123Z');
  const b = at('2025-03-02T08:01:09.004Z');
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['FetchError', '‹ts›']);
});

test('corpus 2: identical except port number → same', () => {
  const on = (port: number) =>
    makeCrash({
      name: 'Error',
      message: `listen EADDRINUSE: address already in use :::${port}`,
      frames: [frame('src/server.ts', 12, { functionName: 'listen' })],
    });
  const a = on(3000);
  const b = on(4123);
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['‹port›']);
});

test('corpus 3: identical except hex address → same', () => {
  const at = (addr: string) =>
    makeCrash({
      name: 'Error',
      message: `wasm trap at ${addr}`,
      frames: [frame('src/wasm/run.ts', 5, { functionName: 'exec' })],
    });
  const a = at('0x7fff5fbff8b8');
  const b = at('0x00007f1de4c0a2');
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['‹hex›']);
});

test('corpus 4: identical except tmp path → same', () => {
  const open = (p: string) =>
    makeCrash({
      name: 'Error',
      message: `ENOENT: no such file or directory, open '${p}'`,
      frames: [frame('src/store/bundle.ts', 88, { functionName: 'write' })],
    });
  const a = open('/tmp/wb-a8f3/out.json');
  const b = open('/tmp/wb-99xz/out.json');
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['‹tmp›']);
});

test('corpus 5: identical except UUID → same', () => {
  const withId = (id: string) =>
    makeCrash({
      name: 'SessionError',
      message: `session ${id} expired`,
      frames: [frame('src/session.ts', 3, { functionName: 'load' })],
    });
  const a = withId('550e8400-e29b-41d4-a716-446655440000');
  const b = withId('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['‹uuid›']);
});

test('corpus 6: same error name + same file, different message → related', () => {
  const a = makeCrash({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    frames: [frame('src/auth.ts', 42, { functionName: 'login' })],
  });
  const b = makeCrash({
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'session')",
    frames: [frame('src/auth.ts', 77, { functionName: 'login' })],
  });
  assertPair(a, b, 'related', ['Same error type at same file', 'src/auth.ts']);
});

test('corpus 7: same failing test, different error → related', () => {
  const tf = (): TestFailure => ({
    runner: 'node:test',
    failingTests: [{ id: 'auth > rejects bad token', file: 'test/auth.test.ts' }],
    total: 10,
    failed: 1,
    passed: 9,
  });
  const a = makeCrash({
    kind: 'nonzero-exit',
    name: 'TypeError',
    message: 'token is not a string',
    frames: [frame('test/auth.test.ts', 9, { functionName: 'check' })],
    testFailure: tf(),
  });
  const b = makeCrash({
    kind: 'nonzero-exit',
    name: 'RangeError',
    message: 'Maximum call stack size exceeded',
    frames: [frame('src/auth.ts', 30, { functionName: 'verify' })],
    testFailure: tf(),
  });
  assertPair(a, b, 'related', [
    'Same failing test, different error',
    'auth > rejects bad token',
  ]);
});

test('corpus 8: same normalized message, different file → related', () => {
  const a = makeCrash({
    name: 'Error',
    message: 'connect ECONNREFUSED 127.0.0.1:5432',
    frames: [frame('src/db/pool.ts', 8, { functionName: 'connect' })],
  });
  const b = makeCrash({
    name: 'Error',
    message: 'connect ECONNREFUSED 127.0.0.1:6543',
    frames: [frame('src/cache/redis.ts', 30, { functionName: 'connect' })],
  });
  assertPair(a, b, 'related', ['Same message, different location', '‹port›']);
});

test('corpus 9: different everything → different', () => {
  const a = makeCrash({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    frames: [frame('src/auth.ts', 42, { functionName: 'login' })],
  });
  const b = makeCrash({
    name: 'RangeError',
    message: 'Maximum call stack size exceeded',
    frames: [frame('src/render/tree.ts', 5, { functionName: 'walk' })],
  });
  assertPair(a, b, 'different', [
    'Error names differ',
    'Normalized messages differ',
    'Top in-repo frames differ',
  ]);
});

test('corpus 10: kind-only signal crashes (no error) → same', () => {
  const a = makeCrash({ kind: 'signal', signal: 'SIGSEGV' });
  const b = makeCrash({ kind: 'signal', signal: 'SIGSEGV' });
  assert.equal(crashFingerprint(a), crashFingerprint(b));
  assertPair(a, b, 'same', ['no error object', 'signal']);
});

test('corpus 11: kind-only signal crash vs error crash → different', () => {
  const a = makeCrash({ kind: 'signal' });
  const b = makeCrash({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'x')",
    frames: [frame('src/auth.ts', 42, { functionName: 'login' })],
  });
  assertPair(a, b, 'different', ['no error object']);
});

test('corpus 12: node_modules-only stacks (no in-repo frame) handled without throw', () => {
  const nm = () => [
    nodeModulesFrame('express/lib/router.js', 100),
    nodeModulesFrame('express/lib/index.js', 5),
  ];
  const a = makeCrash({
    name: 'TypeError',
    message: 'next is not a function',
    frames: nm(),
  });
  const b = makeCrash({
    name: 'TypeError',
    message: 'next is not a function',
    frames: nm(),
  });
  assert.match(crashFingerprint(a), /^[0-9a-f]{16}$/);
  assertPair(a, b, 'same', ['Neither crash has an in-repo stack frame']);
});
