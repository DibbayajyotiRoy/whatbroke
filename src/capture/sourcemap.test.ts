/**
 * Source-map resolution tests (T4.2 / roadmap 5.2).
 *
 * Hermetic: decoder + resolution logic run against an injected in-memory IO;
 * one end-to-end case writes real files under os.tmpdir() (hand-written
 * generated JS + map — no tsc invocation) and exercises the default fs IO
 * through `enrichFrames`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeVlqMappings, resolveFrame, resolveFrames } from './sourcemap.js';
import type { SourceMapIO } from './sourcemap.js';
import { enrichFrames } from '../assemble.js';
import type { StackFrame } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory IO. `extraExisting` marks files that exist but are never read. */
function makeIo(
  files: Record<string, string>,
  extraExisting: string[] = [],
): SourceMapIO & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile(p: string): string | null {
      reads.push(p);
      return Object.hasOwn(files, p) ? files[p]! : null;
    },
    fileExists(p: string): boolean {
      return Object.hasOwn(files, p) || extraExisting.includes(p);
    },
  };
}

function frameOf(
  file: string | null,
  line: number | null,
  column: number | null,
  overrides: Partial<StackFrame> = {},
): StackFrame {
  return {
    functionName: 'boom',
    file,
    fileRelative: null,
    line,
    column,
    isUserCode: true,
    isInRepo: false,
    sourceMapped: false,
    ...overrides,
  };
}

// Hand-compiled fixture (no tsc): a tiny TS file and its tsc-style output.
//
//   src/app.ts                          dist/app.js
//   1  export function boom(): never {  1  export function boom() {
//   2    throw new Error('kaboom');     2      throw new Error('kaboom');
//   3  }                                3  }
//   4  boom();                          4  boom();
//
// mappings (hand-encoded, one segment per generated line):
//   line1 [0,0,0,0] → 'AAAA'   line2 [4,0,1,2] → 'IACE'
//   line3 [0,0,2,0] → 'AACF'   line4 [0,0,3,0] → 'AACA'
const MAPPINGS = 'AAAA;IACE;AACF;AACA';
const GEN_BODY = [
  'export function boom() {',
  "    throw new Error('kaboom');",
  '}',
  'boom();',
  '',
].join('\n');
const ORIG_TS = [
  'export function boom(): never {',
  "  throw new Error('kaboom');",
  '}',
  'boom();',
  '',
].join('\n');

function mapJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    file: 'app.js',
    sourceRoot: '',
    sources: ['../src/app.ts'],
    names: [],
    mappings: MAPPINGS,
    ...overrides,
  });
}

/** Standard external-map project layout under /proj. */
function projectIo(): SourceMapIO & { reads: string[] } {
  return makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson(),
    '/proj/src/app.ts': ORIG_TS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VLQ decoder
// ─────────────────────────────────────────────────────────────────────────────

test('vlq: decodes simple per-line segments (AAAA;AACA)', () => {
  assert.deepEqual(decodeVlqMappings('AAAA;AACA'), [[[0, 0, 0, 0]], [[0, 0, 1, 0]]]);
});

test('vlq: multi-segment line, negatives, and cross-line carry', () => {
  // 'IAAI'  → deltas [+4,0,0,+4]            → [4,0,0,4]
  // 'ACAD'  → deltas [+0,+1,0,-1] (D = -1)  → [4,1,0,3]  (genCol accumulates in-line)
  // ';AACA' → genCol RESETS; srcIdx/origLine/origCol carry → [0,1,1,3]
  assert.deepEqual(decodeVlqMappings('IAAI,ACAD;AACA'), [
    [
      [4, 0, 0, 4],
      [4, 1, 0, 3],
    ],
    [[0, 1, 1, 3]],
  ]);
});

test('vlq: continuation bits assemble multi-char values', () => {
  // '2' = 54 → continuation set, payload 22; 'C' = 2 → value 22 + 2*32 = 86 → +43
  assert.deepEqual(decodeVlqMappings('2CAAA'), [[[43, 0, 0, 0]]]);
});

test('vlq: 5th (names) field is decoded but dropped', () => {
  assert.deepEqual(decodeVlqMappings('AAAAA'), [[[0, 0, 0, 0]]]);
});

test('vlq: empty string is one line with no segments', () => {
  assert.deepEqual(decodeVlqMappings(''), [[]]);
});

test('vlq: lines with no segments stay empty, carry survives the gap', () => {
  assert.deepEqual(decodeVlqMappings('AAAA;;AACA'), [
    [[0, 0, 0, 0]],
    [],
    [[0, 0, 1, 0]],
  ]);
});

test('vlq: 1-field segments (no source info) kept as [genCol]', () => {
  // 'E' = +2 relative to the previous segment's genCol on the same line.
  assert.deepEqual(decodeVlqMappings('AAAA,E'), [[[0, 0, 0, 0], [2]]]);
});

test('vlq: throws on malformed input (resolveFrame catches it)', () => {
  assert.throws(() => decodeVlqMappings('!'));
  assert.throws(() => decodeVlqMappings('2')); // unterminated continuation
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFrame — external map
// ─────────────────────────────────────────────────────────────────────────────

test('external map: dist frame resolves to original .ts with 1-based line/col', () => {
  const io = projectIo();
  const result = resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io);
  assert.deepEqual(result, {
    file: '/proj/src/app.ts',
    line: 2,
    col: 3,
    resolved: true,
  });
});

test('external map: null column falls back to the first segment of the line', () => {
  const result = resolveFrame(
    { file: '/proj/dist/app.js', line: 2, col: null },
    projectIo(),
  );
  assert.ok(result.resolved);
  assert.equal(result.line, 2);
  assert.equal(result.col, 3);
});

test('external map: column before the first segment falls back to it', () => {
  const result = resolveFrame(
    { file: '/proj/dist/app.js', line: 2, col: 1 },
    projectIo(),
  );
  assert.ok(result.resolved);
  assert.equal(result.col, 3);
});

test('external map: legacy //@ sourceMappingURL marker is honored', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//@ sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson(),
    '/proj/src/app.ts': ORIG_TS,
  });
  const result = resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io);
  assert.ok(result.resolved);
  assert.equal(result.file, '/proj/src/app.ts');
});

test('external map: sourceRoot is prepended before resolving against map dir', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson({ sourceRoot: '../src/', sources: ['app.ts'] }),
    '/proj/src/app.ts': ORIG_TS,
  });
  const result = resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io);
  assert.ok(result.resolved);
  assert.equal(result.file, '/proj/src/app.ts');
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFrame — inline data-URI map
// ─────────────────────────────────────────────────────────────────────────────

test('inline base64 map resolves identically to the external one', () => {
  const b64 = Buffer.from(mapJson()).toString('base64');
  const io = makeIo(
    {
      '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=data:application/json;base64,${b64}\n`,
    },
    ['/proj/src/app.ts'],
  );
  const result = resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io);
  assert.deepEqual(result, {
    file: '/proj/src/app.ts',
    line: 2,
    col: 3,
    resolved: true,
  });
});

test('inline map with charset segment resolves too', () => {
  const b64 = Buffer.from(mapJson()).toString('base64');
  const io = makeIo(
    {
      '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}\n`,
    },
    ['/proj/src/app.ts'],
  );
  const result = resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io);
  assert.ok(result.resolved);
  assert.equal(result.file, '/proj/src/app.ts');
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFrame — failure modes (never throws)
// ─────────────────────────────────────────────────────────────────────────────

test('no sourceMappingURL marker → no-map', () => {
  const io = makeIo({ '/proj/dist/app.js': GEN_BODY });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'no-map',
  });
});

test('unreadable generated file → no-map', () => {
  const io = makeIo({});
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'no-map',
  });
});

test('declared but missing map file → unresolved', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('corrupt map JSON → unresolved, no throw', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': '{ this is not json',
    '/proj/src/app.ts': ORIG_TS,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('corrupt VLQ mappings inside valid JSON → unresolved, no throw', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson({ mappings: 'A!!;**' }),
    '/proj/src/app.ts': ORIG_TS,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('mapped original source missing on disk → unresolved', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson(),
    // no /proj/src/app.ts
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('generated line with no segments → unresolved', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson({ mappings: 'AAAA;;AACA' }),
    '/proj/src/app.ts': ORIG_TS,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('frame with null line → unresolved (map was discoverable)', () => {
  const result = resolveFrame(
    { file: '/proj/dist/app.js', line: null, col: null },
    projectIo(),
  );
  assert.deepEqual(result, { resolved: false, note: 'unresolved' });
});

test('http(s) sourceMappingURL → unresolved (offline by design)', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=https://cdn.example.com/app.js.map\n`,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

test('unsupported map version → unresolved', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': mapJson().replace('"version":3', '"version":2'),
    '/proj/src/app.ts': ORIG_TS,
  });
  assert.deepEqual(resolveFrame({ file: '/proj/dist/app.js', line: 2, col: 11 }, io), {
    resolved: false,
    note: 'unresolved',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFrames — batch pass over StackFrames
// ─────────────────────────────────────────────────────────────────────────────

test('resolveFrames rewrites dist frames and leaves the rest alone', () => {
  const io = projectIo();
  const distFrame = frameOf('/proj/dist/app.js', 2, 11);
  const tsFrame = frameOf('/proj/src/other.ts', 5, 1);
  const nullFrame = frameOf(null, null, null);
  const { frames, unresolvedCount } = resolveFrames([distFrame, tsFrame, nullFrame], io);

  assert.equal(unresolvedCount, 0);
  assert.equal(frames.length, 3);
  const mapped = frames[0]!;
  assert.equal(mapped.file, '/proj/src/app.ts');
  assert.equal(mapped.line, 2);
  assert.equal(mapped.column, 3);
  assert.equal(mapped.sourceMapped, true);
  assert.equal(mapped.isUserCode, true);
  // Repo placement is recomputed downstream against the NEW path.
  assert.equal(mapped.fileRelative, null);
  assert.equal(mapped.isInRepo, false);
  assert.equal(mapped.functionName, 'boom');
  // Untouched frames keep identity.
  assert.equal(frames[1], tsFrame);
  assert.equal(frames[2], nullFrame);
});

test('resolveFrames: discoverable-but-broken map leaves frame untouched, counts it', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    '/proj/dist/app.js.map': '{ corrupt',
  });
  const original = frameOf('/proj/dist/app.js', 2, 11);
  const { frames, unresolvedCount } = resolveFrames([original], io);
  assert.equal(unresolvedCount, 1);
  assert.equal(frames[0], original); // same object, fully untouched
  assert.equal(frames[0]!.sourceMapped, false);
});

test('resolveFrames: no-map .js frame is untouched and NOT counted unresolved', () => {
  const io = makeIo({ '/proj/dist/app.js': GEN_BODY });
  const original = frameOf('/proj/dist/app.js', 2, 11);
  const { frames, unresolvedCount } = resolveFrames([original], io);
  assert.equal(unresolvedCount, 0);
  assert.equal(frames[0], original);
});

test('resolveFrames skips frames already sourceMapped (no IO at all)', () => {
  const io = projectIo();
  const done = frameOf('/proj/dist/app.js', 2, 11, { sourceMapped: true });
  const { frames, unresolvedCount } = resolveFrames([done], io);
  assert.equal(frames[0], done);
  assert.equal(unresolvedCount, 0);
  assert.equal(io.reads.length, 0);
});

test('resolveFrames skips non-candidates without touching IO', () => {
  const io = projectIo();
  const frames = [
    frameOf('/proj/src/app.ts', 2, 3), // source file, not build output
    frameOf('node:internal/modules/run_main', 1, 1),
    frameOf('/proj/node_modules/dep/lib/index.js', 1, 1), // vendored, non-dist
  ];
  const result = resolveFrames(frames, io);
  assert.equal(io.reads.length, 0);
  assert.equal(result.frames[0], frames[0]);
  assert.equal(result.frames[1], frames[1]);
  assert.equal(result.frames[2], frames[2]);
});

test('resolveFrames: plain .js outside build dirs is still attempted (marker discoverable)', () => {
  const io = makeIo({
    '/proj/server.js': `${GEN_BODY}//# sourceMappingURL=server.js.map\n`,
    '/proj/server.js.map': mapJson({ sources: ['src/app.ts'] }),
    '/proj/src/app.ts': ORIG_TS,
  });
  const { frames } = resolveFrames([frameOf('/proj/server.js', 2, 11)], io);
  assert.equal(frames[0]!.file, '/proj/src/app.ts');
  assert.equal(frames[0]!.sourceMapped, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// enrichFrames integration
// ─────────────────────────────────────────────────────────────────────────────

test('enrichFrames maps dist frame first, then computes isInRepo/fileRelative on the .ts', () => {
  const io = projectIo();
  const enriched = enrichFrames(
    [frameOf('/proj/dist/app.js', 2, 11)],
    '/proj',
    '/proj',
    io,
  );
  const f = enriched[0]!;
  assert.equal(f.file, '/proj/src/app.ts');
  assert.equal(f.fileRelative, 'src/app.ts');
  assert.equal(f.isInRepo, true);
  assert.equal(f.sourceMapped, true);
  assert.equal(f.line, 2);
  assert.equal(f.column, 3);
});

test('enrichFrames: unresolvable map leaves the raw dist frame, still repo-relative', () => {
  const io = makeIo({
    '/proj/dist/app.js': `${GEN_BODY}//# sourceMappingURL=app.js.map\n`,
    // map file missing → unresolved → frame untouched by the sourcemap pass
  });
  const enriched = enrichFrames(
    [frameOf('/proj/dist/app.js', 2, 11)],
    '/proj',
    '/proj',
    io,
  );
  const f = enriched[0]!;
  assert.equal(f.file, '/proj/dist/app.js');
  assert.equal(f.fileRelative, 'dist/app.js');
  assert.equal(f.isInRepo, true);
  assert.equal(f.sourceMapped, false);
  assert.equal(f.line, 2);
});

test('end-to-end on real files: hand-compiled 3-line TS project (default fs IO)', () => {
  // Hand-written build output for a 3-line original — no tsc at test time.
  //   src/app.ts                        dist/app.js
  //   1 export function boom(): never { 1 export function boom() {
  //   2   throw new Error('kaboom');    2     throw new Error('kaboom');
  //   3 }                               3 }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatbroke-sourcemap-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      "export function boom(): never {\n  throw new Error('kaboom');\n}\n",
    );
    fs.writeFileSync(
      path.join(root, 'dist', 'app.js'),
      "export function boom() {\n    throw new Error('kaboom');\n}\n//# sourceMappingURL=app.js.map\n",
    );
    fs.writeFileSync(
      path.join(root, 'dist', 'app.js.map'),
      JSON.stringify({
        version: 3,
        file: 'app.js',
        sourceRoot: '',
        sources: ['../src/app.ts'],
        names: [],
        mappings: 'AAAA;IACE;AACF',
      }),
    );

    const crashFrame = frameOf(path.join(root, 'dist', 'app.js'), 2, 15);
    const enriched = enrichFrames([crashFrame], root, root); // real fs
    const f = enriched[0]!;
    assert.ok(f.file!.endsWith(`${path.sep}src${path.sep}app.ts`));
    assert.equal(f.fileRelative, 'src/app.ts');
    assert.equal(f.isInRepo, true);
    assert.equal(f.sourceMapped, true);
    assert.equal(f.line, 2);
    assert.equal(f.column, 3);
    assert.equal(f.isUserCode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
