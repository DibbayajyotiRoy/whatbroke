/**
 * Benchmark-harness tests (T3.1). The full ≥30-case suite runs via
 * `npx tsx bench/run.ts` (and gates CI with --gate); this file keeps npm test
 * fast: pure scoring units plus two known-good mini-cases driven end-to-end
 * through the real harness machinery (loadCase → runCase → executePipeline),
 * and the corrupt-case.json path.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pct, scoreCase, summarize } from '../bench/score.js';
import { loadCase, loadCases, runCase } from '../bench/run.js';

// ── scoreCase / pct / summarize (pure) ───────────────────────────────────────

test('scoreCase: culprit at rank 1 hits top1 and top3', () => {
  const s = scoreCase(['a.js', 'b.js'], ['a.js']);
  assert.deepEqual(s, { top1: true, top3: true });
});

test('scoreCase: culprit at rank 3 is a top3-only hit', () => {
  const s = scoreCase(['x.js', 'y.js', 'a.js', 'b.js'], ['a.js']);
  assert.deepEqual(s, { top1: false, top3: true });
});

test('scoreCase: culprit at rank 4 or absent misses both', () => {
  assert.deepEqual(scoreCase(['w.js', 'x.js', 'y.js', 'a.js'], ['a.js']), {
    top1: false,
    top3: false,
  });
  assert.deepEqual(scoreCase(['w.js'], ['a.js']), { top1: false, top3: false });
});

test('scoreCase: empty suspect list misses', () => {
  assert.deepEqual(scoreCase([], ['a.js']), { top1: false, top3: false });
});

test('scoreCase: any culprit counts and paths are normalized', () => {
  const s = scoreCase(['./lib/a.js'], ['other.js', 'lib\\a.js']);
  assert.deepEqual(s, { top1: true, top3: true });
});

test('pct: one-decimal rounding, 0 for empty denominator', () => {
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(27, 31), 87.1);
  assert.equal(pct(0, 0), 0);
});

test('summarize: expectedMiss and errored cases stay out of the headline; flips reported', () => {
  const summary = summarize([
    { name: 'hit', expectedMiss: false, top1: true, top3: true },
    { name: 'top3-only', expectedMiss: false, top1: false, top3: true },
    { name: 'known-miss', expectedMiss: true, top1: false, top3: false },
    { name: 'flipped-miss', expectedMiss: true, top1: false, top3: true },
    { name: 'broken', expectedMiss: false, top1: false, top3: false, error: 'boom' },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.top1, 1);
  assert.equal(summary.top3, 2);
  assert.equal(summary.top1Pct, 50);
  assert.equal(summary.top3Pct, 100);
  assert.equal(summary.knownMissTotal, 2);
  assert.deepEqual(summary.flipped, ['flipped-miss']);
  assert.deepEqual(summary.errors, ['broken']);
});

// ── harness end-to-end on two known-good mini-cases ──────────────────────────

async function makeCaseDir(name: string, spec: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-benchtest-'));
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'case.json'), JSON.stringify(spec, null, 2));
  return dir;
}

test('harness e2e: inline-files case replays green→crash and scores a top-1 hit', async () => {
  const dir = await makeCaseDir('inline-hit', {
    name: 'inline-hit',
    language: 'node',
    culprits: ['main.js'],
    argv: ['node', 'main.js'],
    greenFiles: { 'main.js': "console.log('ok');\n" },
    brokenFiles: { 'main.js': "throw new Error('bench mini-case failure');\n" },
  });
  try {
    const load = await loadCase(dir);
    assert.equal(load.ok, true);
    if (!load.ok) return;
    const result = await runCase(load.case);
    assert.equal(result.error, undefined);
    assert.equal(result.top1, true);
    assert.equal(result.top3, true);
    assert.equal(result.topSuspect, 'main.js');
    assert.equal(result.expectedMiss, false);
  } finally {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  }
});

test('harness e2e: greenDir/brokenDir case hits the changed helper deterministically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-benchtest-'));
  const dir = path.join(root, 'dir-hit');
  try {
    await fs.mkdir(path.join(dir, 'green', 'lib'), { recursive: true });
    await fs.mkdir(path.join(dir, 'broken', 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'green', 'main.js'),
      "const { greet } = require('./lib/helper.js');\nconsole.log(greet());\n",
    );
    await fs.writeFile(
      path.join(dir, 'green', 'lib', 'helper.js'),
      "module.exports = { greet: () => 'hi' };\n",
    );
    await fs.writeFile(
      path.join(dir, 'broken', 'lib', 'helper.js'),
      "module.exports = { greet: () => { throw new Error('helper broke'); } };\n",
    );
    await fs.writeFile(
      path.join(dir, 'case.json'),
      JSON.stringify({
        name: 'dir-hit',
        language: 'node',
        culprits: ['lib/helper.js'],
        argv: ['node', 'main.js'],
        greenDir: 'green',
        brokenDir: 'broken',
      }),
    );
    const load = await loadCase(dir);
    assert.equal(load.ok, true);
    if (!load.ok) return;
    const result = await runCase(load.case);
    assert.equal(result.error, undefined);
    assert.equal(result.top1, true);
    assert.equal(result.top3, true);
    assert.equal(result.topSuspect, 'lib/helper.js');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── malformed cases are reported, never thrown ───────────────────────────────

test('corrupt case.json: loadCase reports a case error and loadCases does not throw', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-benchtest-'));
  try {
    const dir = path.join(root, 'corrupt');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'case.json'), '{ "name": "corrupt",');

    const load = await loadCase(dir);
    assert.equal(load.ok, false);
    if (load.ok) return;
    assert.match(load.error, /malformed case\.json/);
    assert.equal(load.name, 'corrupt');

    // A corrupt case among others degrades to one failed load, not a throw.
    const loads = await loadCases(root);
    assert.equal(loads.length, 1);
    assert.equal(loads[0]?.ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('invalid case shape: missing broken fixture is reported as a load error', async () => {
  const dir = await makeCaseDir('no-broken', {
    name: 'no-broken',
    language: 'node',
    culprits: ['main.js'],
    argv: ['node', 'main.js'],
    greenFiles: { 'main.js': "console.log('ok');\n" },
  });
  try {
    const load = await loadCase(dir);
    assert.equal(load.ok, false);
    if (load.ok) return;
    assert.match(load.error, /brokenFiles.*brokenDir|needs "brokenFiles"/);
  } finally {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  }
});
