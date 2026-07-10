import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseImports,
  resolveSpecifier,
  buildOneHopEdges,
  defaultFileExists,
  defaultReadFile,
} from './importGraph.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function existsIn(files: string[]): (p: string) => boolean {
  const set = new Set(files);
  return (p) => set.has(p);
}

/** Fake repo: repoRoot-joined reads/probes against an in-memory file map. */
function fsFor(files: Record<string, string>, root = '/r') {
  const reads: string[] = [];
  const rel = (p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  return {
    reads,
    readFile: (p: string): string | null => {
      reads.push(p);
      const r = rel(p);
      return Object.hasOwn(files, r) ? files[r]! : null;
    },
    fileExists: (p: string): boolean => Object.hasOwn(files, rel(p)),
  };
}

function serialize(m: Map<string, Set<string>>): [string, string[]][] {
  return [...m].map(([k, v]) => [k, [...v]]);
}

// ── parseImports ─────────────────────────────────────────────────────────────

test('parseImports: extracts every supported import form in source order', () => {
  const src = `
import def from './a.js';
import { one, two as three } from './b.js';
import * as ns from './c.js';
import './side.js';
export { x } from './d.js';
export * from './e.js';
const dyn = await import('./f.js');
const req = require('./g.cjs');
import 'bare-side';
import pkg from "react";
`;
  assert.deepEqual(parseImports(src), [
    './a.js',
    './b.js',
    './c.js',
    './side.js',
    './d.js',
    './e.js',
    './f.js',
    './g.cjs',
    'bare-side',
    'react',
  ]);
});

test('parseImports: multi-line clauses, no-semicolon style, TS import-require', () => {
  const src = [
    'import {',
    '  alpha,',
    '  beta as b,',
    "} from './multi.js'",
    "import next from './next.js'",
    "import legacy = require('./legacy.js');",
  ].join('\n');
  assert.deepEqual(parseImports(src), ['./multi.js', './next.js', './legacy.js']);
});

test('parseImports: type-only imports and re-exports are ignored', () => {
  const src = `
import type { T } from './types.js';
import type Def from './def-types.js';
import type * as NS from './ns-types.js';
export type { U } from './u.js';
import { real } from './real.js';
`;
  assert.deepEqual(parseImports(src), ['./real.js']);
});

test("parseImports: `import type from './x'` is a VALUE import of a binding named type", () => {
  assert.deepEqual(parseImports("import type from './odd.js';"), ['./odd.js']);
});

test('parseImports: specifiers inside comments are ignored; strings are comment-safe', () => {
  const src = [
    "// import gone from './line.js';",
    "/* import gone2 from './block.js'; */",
    '/**',
    " * import gone3 from './jsdoc.js';",
    ' */',
    // The '//' inside the URL string must NOT start a comment (string-aware strip).
    "const url = 'https://example.com/x'; import { after } from './after.js';",
    "import { kept } from './kept.js'; // import tail from './tail.js'",
  ].join('\n');
  assert.deepEqual(parseImports(src), ['./after.js', './kept.js']);
});

test('parseImports: non-literal dynamic imports and requires are ignored', () => {
  const src = [
    'const a = await import(modulePath);',
    "const b = await import('./lit' + suffix);",
    'const c = require(name);',
    'const d = await import(`./tpl-${x}.js`);', // template literal: ignored by design
    "const e = await import('./real-dyn.js');",
    'const f = require("./real-req.js");',
    "const g = await import('./attr.js', { with: { type: 'json' } });",
  ].join('\n');
  assert.deepEqual(parseImports(src), ['./real-dyn.js', './real-req.js', './attr.js']);
});

test('parseImports: deduplicates repeated specifiers, first occurrence wins', () => {
  const src = "import a from './x.js'; import b from './y.js'; const c = require('./x.js');";
  assert.deepEqual(parseImports(src), ['./x.js', './y.js']);
});

test('parseImports: determinism — same source twice gives identical arrays', () => {
  const src = "import a from './x.js';\nexport * from './y.js';\nimport './z.js';";
  assert.deepEqual(parseImports(src), parseImports(src));
});

// ── resolveSpecifier ─────────────────────────────────────────────────────────

test('resolveSpecifier: exact match wins over every remap/probe', () => {
  const exists = existsIn(['src/x.js', 'src/x.ts']);
  assert.equal(resolveSpecifier('src/a.ts', './x.js', exists), 'src/x.js');
});

test('resolveSpecifier: TS-ESM style ./x.js resolves to x.ts when only the .ts exists', () => {
  assert.equal(
    resolveSpecifier('src/a.ts', './x.js', existsIn(['src/x.ts'])),
    'src/x.ts',
  );
});

test('resolveSpecifier: extensionless specifiers probe extensions in fixed order', () => {
  const from = 'src/a.ts';
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.ts', 'src/x.tsx', 'src/x.js'])), 'src/x.ts');
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.tsx', 'src/x.js'])), 'src/x.tsx');
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.mts', 'src/x.js'])), 'src/x.mts');
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.js', 'src/x.mjs'])), 'src/x.js');
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.mjs', 'src/x.cjs'])), 'src/x.mjs');
  assert.equal(resolveSpecifier(from, './x', existsIn(['src/x.cjs'])), 'src/x.cjs');
});

test('resolveSpecifier: directory specifiers probe index files in fixed order', () => {
  const from = 'src/a.ts';
  assert.equal(
    resolveSpecifier(from, './lib', existsIn(['src/lib/index.ts', 'src/lib/index.js'])),
    'src/lib/index.ts',
  );
  assert.equal(
    resolveSpecifier(from, './lib', existsIn(['src/lib/index.tsx', 'src/lib/index.js'])),
    'src/lib/index.tsx',
  );
  assert.equal(
    resolveSpecifier(from, './lib', existsIn(['src/lib/index.js'])),
    'src/lib/index.js',
  );
  // A file probe beats the index probe (extension order comes first).
  assert.equal(
    resolveSpecifier(from, './lib', existsIn(['src/lib.ts', 'src/lib/index.ts'])),
    'src/lib.ts',
  );
});

test('resolveSpecifier: ../ climbs directories; root-level importer works', () => {
  assert.equal(
    resolveSpecifier('src/deep/a.ts', '../shared.ts', existsIn(['src/shared.ts'])),
    'src/shared.ts',
  );
  assert.equal(
    resolveSpecifier('main.ts', './util', existsIn(['util.ts'])),
    'util.ts',
  );
});

test('resolveSpecifier: bare, builtin, absolute, and escaping specifiers → null', () => {
  const exists = existsIn(['src/x.ts', 'react', 'node_modules/react/index.js']);
  assert.equal(resolveSpecifier('src/a.ts', 'react', exists), null);
  assert.equal(resolveSpecifier('src/a.ts', 'node:fs', exists), null);
  assert.equal(resolveSpecifier('src/a.ts', '/abs/x.ts', exists), null);
  assert.equal(resolveSpecifier('src/a.ts', '../../outside.ts', exists), null);
  assert.equal(resolveSpecifier('a.ts', '../outside.ts', exists), null);
});

test('resolveSpecifier: no candidate exists → null', () => {
  assert.equal(resolveSpecifier('src/a.ts', './nope', existsIn([])), null);
});

// ── buildOneHopEdges ─────────────────────────────────────────────────────────

test('buildOneHopEdges: adjacency is repo-relative; edge-less importers omitted', () => {
  const { readFile, fileExists } = fsFor({
    'src/a.ts': "import { b } from './b.js';\nimport 'react';",
    'src/b.ts': 'export const b = 1;',
  });
  const edges = buildOneHopEdges({
    repoRoot: '/r',
    files: ['src/a.ts', 'src/b.ts'],
    readFile,
    fileExists,
  });
  assert.deepEqual(serialize(edges), [['src/a.ts', ['src/b.ts']]]);
});

test('buildOneHopEdges: determinism — shuffled input and repeat runs agree; sets sorted', () => {
  const files: Record<string, string> = {
    'src/hub.ts': "import './zz.js';\nimport './aa.js';\nimport 'left-pad';",
    'src/zz.ts': "export * from './aa.js';",
    'src/aa.ts': 'export const aa = 1;',
  };
  const build = (order: string[]) => {
    const { readFile, fileExists } = fsFor(files);
    return buildOneHopEdges({ repoRoot: '/r', files: order, readFile, fileExists });
  };
  const a = build(['src/hub.ts', 'src/zz.ts', 'src/aa.ts']);
  const b = build(['src/aa.ts', 'src/zz.ts', 'src/hub.ts']);
  const c = build(['src/aa.ts', 'src/zz.ts', 'src/hub.ts']);
  assert.deepEqual(serialize(a), serialize(b));
  assert.deepEqual(serialize(b), serialize(c));
  // Keys in sorted file order; each set sorted (aa before zz despite source order).
  assert.deepEqual(serialize(a), [
    ['src/hub.ts', ['src/aa.ts', 'src/zz.ts']],
    ['src/zz.ts', ['src/aa.ts']],
  ]);
});

test('buildOneHopEdges: maxFiles cap — only the first N sorted candidates are read', () => {
  const { reads, readFile, fileExists } = fsFor({
    'a.ts': "import './b.js';",
    'b.ts': "import './c.js';",
    'c.ts': '',
    'd.ts': "import './a.js';",
    'e.ts': "import './a.js';",
  });
  const edges = buildOneHopEdges({
    repoRoot: '/r',
    files: ['d.ts', 'b.ts', 'e.ts', 'a.ts', 'c.ts'], // unsorted on purpose
    readFile,
    fileExists,
    maxFiles: 2,
  });
  assert.deepEqual(reads, ['/r/a.ts', '/r/b.ts']);
  assert.deepEqual(serialize(edges), [
    ['a.ts', ['b.ts']],
    ['b.ts', ['c.ts']], // targets may lie beyond the parsed set — ≤1 hop still holds
  ]);
});

test('buildOneHopEdges: maxBytes cap — oversize file is skipped after the read', () => {
  const { reads, readFile, fileExists } = fsFor({
    'big.ts': `import './b.js';\n${'x'.repeat(64)}`,
    'ok.ts': "import './b.js';",
    'b.ts': '',
  });
  const edges = buildOneHopEdges({
    repoRoot: '/r',
    files: ['big.ts', 'ok.ts'],
    readFile,
    fileExists,
    maxBytes: 32,
  });
  assert.deepEqual(reads, ['/r/big.ts', '/r/ok.ts']);
  assert.equal(edges.has('big.ts'), false);
  assert.deepEqual([...edges.get('ok.ts')!], ['b.ts']);
});

test('buildOneHopEdges: non-source candidates skipped without reads; self/bare imports drop out', () => {
  const { reads, readFile, fileExists } = fsFor({
    'a.ts': "import './b.js';",
    'b.ts': '',
    'bare.ts': "import 'lodash';",
    'self.ts': "import './self.js';",
  });
  const edges = buildOneHopEdges({
    repoRoot: '/r',
    files: ['notes.md', 'data.json', 'requirements.txt', 'a.ts', 'bare.ts', 'self.ts'],
    readFile,
    fileExists,
  });
  assert.deepEqual(reads, ['/r/a.ts', '/r/bare.ts', '/r/self.ts']);
  assert.deepEqual(serialize(edges), [['a.ts', ['b.ts']]]);
});

test('buildOneHopEdges: unreadable candidates (readFile → null) are skipped', () => {
  const { readFile, fileExists } = fsFor({ 'b.ts': '' });
  const edges = buildOneHopEdges({
    repoRoot: '/r',
    files: ['missing.ts'],
    readFile,
    fileExists,
  });
  assert.equal(edges.size, 0);
});

// ── default fs helpers ───────────────────────────────────────────────────────

test('default fs helpers: real files read; missing paths and directories rejected', () => {
  const selfPath = fileURLToPath(import.meta.url);
  assert.equal(defaultFileExists(selfPath), true);
  assert.equal(defaultFileExists(`${selfPath}.nope`), false);
  assert.equal(defaultFileExists(dirname(selfPath)), false, 'directories are not files');

  const content = defaultReadFile(selfPath);
  assert.ok(content !== null && content.includes('defaultReadFile'));
  assert.equal(defaultReadFile(`${selfPath}.nope`), null);
});
