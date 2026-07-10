import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ReproInput,
  StackFrame,
  ChangedFile,
  EnvInfo,
  GitInfo,
} from '../types.js';
import { rankSuspects } from './suspects.js';

/**
 * Import-graph one-hop signal (T3.2). Hermeticity: every test either injects
 * prebuilt `edges` (an empty map disables the signal without fs access) or
 * injects fake readFile/fileExists for the lazy build. Fixture paths live
 * under the nonexistent roots /repo, /virt, /derived, so nothing real is read.
 */

// ── Fixture builders (mirrors reconstruct.test.ts) ───────────────────────────

function frame(
  fileRelative: string,
  line: number,
  opts: { isUserCode?: boolean; file?: string } = {},
): StackFrame {
  const isUserCode = opts.isUserCode ?? true;
  return {
    functionName: 'fn',
    file: opts.file ?? `/repo/${fileRelative}`,
    fileRelative,
    line,
    column: 1,
    isUserCode,
    isInRepo: isUserCode,
    sourceMapped: false,
  };
}

function changed(path: string): ChangedFile {
  return { path, status: ' M' };
}

function defaultEnv(): EnvInfo {
  return {
    os: { platform: 'linux', release: '6.0', arch: 'x64' },
    runtime: { name: 'node', version: 'v20.11.0' },
    packageManager: { name: 'npm', version: '10.2.0' },
    envKeys: [],
    envValues: {},
    cwd: '/repo',
  };
}

function makeInput(opts: {
  stack?: StackFrame[];
  changedFiles?: ChangedFile[];
  git?: Partial<GitInfo>;
}): ReproInput {
  const stack = opts.stack ?? [];
  const git: GitInfo = {
    isRepo: true,
    branch: 'main',
    head: 'deadbeefcafe1234',
    dirty: true,
    changedFiles: opts.changedFiles ?? [],
    greenRef: 'abc1234567890',
    greenRefSource: 'journal',
    ...opts.git,
  };
  return {
    crash: {
      kind: 'uncaught-exception',
      exitCode: 1,
      signal: null,
      ...(stack.length > 0
        ? { error: { name: 'TypeError', message: 'boom', stack, rawStack: 'raw' } }
        : {}),
    },
    context: {
      env: defaultEnv(),
      deps: { declared: {}, relevantResolved: {}, lockfile: 'package-lock' },
      git,
      collectorErrors: [],
    },
    command: { argv: ['npm', 'test'], cwd: '/repo' },
  };
}

function find(suspects: ReturnType<typeof rankSuspects>, path: string) {
  const s = suspects.find((x) => x.path === path);
  assert.ok(s, `expected suspect ${path}`);
  return s;
}

const edgesOf = (pairs: [string, string[]][]): Map<string, Set<string>> =>
  new Map(pairs.map(([k, v]) => [k, new Set(v)]));

// ── Import-hop: forward direction ────────────────────────────────────────────

test('hop: stack file importing a changed file gets +2 with the imports reason', () => {
  const input = makeInput({
    stack: [frame('a.ts', 10)],
    changedFiles: [changed('b.ts')],
  });
  const suspects = rankSuspects(input, { edges: edgesOf([['a.ts', ['b.ts']]]) });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 5); // 3 (top frame) + 2 (import hop)
  assert.ok(a.reasons.includes('imports changed file b.ts'), a.reasons.join(' | '));
  assert.equal(suspects[0]!.path, 'a.ts');

  const b = find(suspects, 'b.ts');
  // Symmetric hop (4.2): the changed off-stack file is one import away from
  // the crash site, so it carries the proximity evidence too: 1 + 2.
  assert.equal(b.score, 3);
  assert.ok(b.reasons.includes('imported by crashing file a.ts'), b.reasons.join(' | '));
});

test('hop changes the ranking: one-hop frame overtakes the top frame', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1), frame('c.ts', 2)],
    changedFiles: [changed('b.ts')],
  });

  // Baseline without edges (empty map = signal off, no fs): a (3) > c (2) > b (1).
  const base = rankSuspects(input, { edges: new Map() });
  assert.equal(base[0]!.path, 'a.ts');
  assert.ok(!base.some((s) => s.reasons.some((r) => r.includes('import'))));

  // c.ts imports the changed b.ts → c: 2 + 2 = 4 outranks a: 3.
  const suspects = rankSuspects(input, { edges: edgesOf([['c.ts', ['b.ts']]]) });
  assert.equal(suspects[0]!.path, 'c.ts');
  assert.equal(suspects[0]!.score, 4);
  assert.ok(suspects[0]!.reasons.includes('imports changed file b.ts'));
});

// ── Import-hop: reverse direction ────────────────────────────────────────────

test('hop reverse: changed file importing the stack file → "imported by changed file"', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts')],
  });
  // b.ts (changed, off-stack) imports a.ts (on stack): the bonus lands on a.ts.
  const suspects = rankSuspects(input, { edges: edgesOf([['b.ts', ['a.ts']]]) });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 5); // 3 + 2
  assert.ok(a.reasons.includes('imported by changed file b.ts'), a.reasons.join(' | '));

  const b = find(suspects, 'b.ts');
  // Symmetric hop (4.2): b.ts changed and imports the crashing a.ts → 1 + 2.
  assert.equal(b.score, 3);
  assert.ok(b.reasons.includes('imports crashing file a.ts'), b.reasons.join(' | '));
});

test('intersection dominance: stack∩changed outranks a hop-boosted frame with a higher raw score', () => {
  // callee.ts: top frame (3) + hop (2) = 5. caller.ts: frame 2 (2) + intersection (5) = 7?
  // Force the interesting case: deep caller whose decayed frame weight makes its
  // total NUMERICALLY lower than the boosted callee — direct evidence must still win.
  const input = makeInput({
    stack: [frame('callee.ts', 1), frame('mid.ts', 2), frame('caller.ts', 3)],
    changedFiles: [changed('caller.ts'), changed('lib.ts')],
  });
  // callee.ts imports changed lib.ts → callee: 3 + 2 = 5. caller: 1 (frame 3) + 5 = 6.
  // Also boost mid via lib to press harder on the sort: mid: 2 + 2 = 4.
  const suspects = rankSuspects(input, {
    edges: edgesOf([
      ['callee.ts', ['lib.ts']],
      ['mid.ts', ['lib.ts']],
    ]),
  });
  assert.equal(suspects[0]!.path, 'caller.ts', suspects.map((s) => `${s.path}:${s.score}`).join(', '));
  // And even if bonuses stacked past the intersection total, the tier ordering
  // keeps every intersection candidate above every non-intersection one.
  const caller = find(suspects, 'caller.ts');
  const callee = find(suspects, 'callee.ts');
  assert.ok(suspects.indexOf(caller) < suspects.indexOf(callee));
});

// ── Exclusions ───────────────────────────────────────────────────────────────

test('stack∩changed file keeps its +5 and never stacks an extra hop bonus', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('a.ts'), changed('b.ts')],
  });
  // a.ts also imports the other changed file — must still not get +2 on top of +5.
  const suspects = rankSuspects(input, { edges: edgesOf([['a.ts', ['b.ts']]]) });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 8); // 3 (frame) + 5 (intersection); no +2
  assert.ok(!a.reasons.some((r) => r.includes('import')), a.reasons.join(' | '));
});

test('hop never lands on changed-only files (must connect stack to change)', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts'), changed('c.ts')],
  });
  // b imports c: both changed, neither on stack → no bonus anywhere.
  const suspects = rankSuspects(input, { edges: edgesOf([['b.ts', ['c.ts']]]) });

  for (const p of ['b.ts', 'c.ts']) {
    const s = find(suspects, p);
    assert.equal(s.score, 1);
    assert.ok(!s.reasons.some((r) => r.includes('import')));
  }
  assert.equal(find(suspects, 'a.ts').score, 3);
});

test('at most one hop bonus per file: first matching changed file in sorted order', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('z.ts'), changed('b.ts')],
  });
  // a imports BOTH changed files; only sorted-first b.ts may be credited.
  const suspects = rankSuspects(input, { edges: edgesOf([['a.ts', ['b.ts', 'z.ts']]]) });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 5); // exactly one +2
  assert.deepEqual(
    a.reasons.filter((r) => r.includes('import')),
    ['imports changed file b.ts'],
  );
});

test('mixed directions: sorted-first changed file wins regardless of direction', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('z.ts'), changed('b.ts')],
  });
  // a imports z (forward), while b imports a (reverse). b sorts first → reverse reason.
  const suspects = rankSuspects(input, {
    edges: edgesOf([
      ['a.ts', ['z.ts']],
      ['b.ts', ['a.ts']],
    ]),
  });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 5);
  assert.deepEqual(
    a.reasons.filter((r) => r.includes('import')),
    ['imported by changed file b.ts'],
  );
});

// ── Gating: no-git / no-changed / defaults unchanged ─────────────────────────

test('not a git repo → hop never fires, even with edges provided', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts')],
    git: { isRepo: false, branch: null, head: null, greenRef: null },
  });
  const suspects = rankSuspects(input, { edges: edgesOf([['a.ts', ['b.ts']]]) });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 3);
  assert.ok(!a.reasons.some((r) => r.includes('import')));
});

test('no changed files → no hop bonus and the graph is never computed', () => {
  let calls = 0;
  const input = makeInput({ stack: [frame('a.ts', 1)] });
  const suspects = rankSuspects(input, {
    repoRoot: '/virt',
    readFile: () => {
      calls++;
      return null;
    },
    fileExists: () => {
      calls++;
      return false;
    },
  });
  assert.equal(calls, 0);
  assert.equal(find(suspects, 'a.ts').score, 3);
});

test('default call (no options) keeps old behavior on fixture paths', () => {
  // Fixture root /repo does not exist, so the lazy fs probing finds nothing:
  // exactly the hermetic degradation the existing reconstruct/conformance
  // fixtures rely on.
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts')],
  });
  const suspects = rankSuspects(input);
  assert.equal(find(suspects, 'a.ts').score, 3);
  assert.equal(find(suspects, 'b.ts').score, 1);
  assert.ok(!suspects.some((s) => s.reasons.some((r) => r.includes('import'))));
});

// ── Lazy graph build through injectable fs ───────────────────────────────────

test('lazy build: injected fs feeds the hop signal without prebuilt edges', () => {
  const files: Record<string, string> = {
    '/virt/a.ts': "import { b } from './b.js';\n",
    '/virt/b.ts': 'export const b = 1;\n',
  };
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts')],
  });
  const suspects = rankSuspects(input, {
    repoRoot: '/virt',
    readFile: (p) => (Object.hasOwn(files, p) ? files[p]! : null),
    fileExists: (p) => Object.hasOwn(files, p),
  });

  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 5);
  assert.ok(a.reasons.includes('imports changed file b.ts'), a.reasons.join(' | '));
});

test('lazy build derives the repo root from stack frames (file minus fileRelative)', () => {
  const files: Record<string, string> = {
    '/derived/a.ts': "import './b.js';\n",
    '/derived/b.ts': 'export {};\n',
  };
  const input = makeInput({
    stack: [frame('a.ts', 1, { file: '/derived/a.ts' })],
    changedFiles: [changed('b.ts')],
  });
  const suspects = rankSuspects(input, {
    readFile: (p) => (Object.hasOwn(files, p) ? files[p]! : null),
    fileExists: (p) => Object.hasOwn(files, p),
  });
  assert.ok(find(suspects, 'a.ts').reasons.includes('imports changed file b.ts'));
});

test('a throwing fs can never break ranking — hop degrades to no bonus', () => {
  const input = makeInput({
    stack: [frame('a.ts', 1)],
    changedFiles: [changed('b.ts')],
  });
  const suspects = rankSuspects(input, {
    repoRoot: '/virt',
    readFile: () => {
      throw new Error('disk on fire');
    },
    fileExists: () => {
      throw new Error('disk on fire');
    },
  });
  const a = find(suspects, 'a.ts');
  assert.equal(a.score, 3);
  assert.ok(!a.reasons.some((r) => r.includes('import')));
});

// ── Determinism ──────────────────────────────────────────────────────────────

test('determinism: same input and edges twice → deep-equal suspects', () => {
  const build = () => ({
    input: makeInput({
      stack: [frame('a.ts', 1), frame('c.ts', 2)],
      changedFiles: [changed('b.ts'), changed('d.ts')],
    }),
    opts: {
      edges: edgesOf([
        ['a.ts', ['b.ts']],
        ['d.ts', ['c.ts']],
      ]),
    },
  });
  const one = build();
  const two = build();
  assert.deepEqual(
    rankSuspects(one.input, one.opts),
    rankSuspects(two.input, two.opts),
  );
});
