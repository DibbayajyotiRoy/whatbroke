/**
 * Crash history index tests (roadmap 3.1/3.2): recurrence matching, flaky
 * detection, resolution ledger, GC, and corrupt-file degradation — plus the
 * full crash → fix+verify → same-crash-again integration through the real
 * pipeline and verify.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HistoryIndex, historyPath } from './history.js';
import { executePipeline } from '../pipeline.js';
import { verifyBundle } from '../verify/verify.js';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveStorePaths } from '../paths.js';
import { createFileSink } from '../sinks/file.js';
import { renderMarkdown } from '../render/markdown.js';
import { summarizeStats } from '../commands/stats.js';

const occ = (n: number, over: Partial<{ head: string | null; at: string }> = {}) => ({
  bundleId: `b${n}`,
  at: over.at ?? `2026-07-0${(n % 9) + 1}T00:00:00.000Z`,
  head: over.head === undefined ? `sha${n}` : over.head,
  suspects: ['src/a.ts', 'src/b.ts'],
});

async function tmpIndex(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-history-'));
  return { dir, file: historyPath(dir) };
}

test('history: unknown fingerprint has no match; recorded crash matches later', async () => {
  const { dir, file } = await tmpIndex();
  const h = await HistoryIndex.open(file);
  assert.equal(h.match('fp1', null), undefined);

  h.recordCrash('fp1', occ(1));
  const m = h.match('fp1', null);
  assert.equal(m?.matchedBundleId, 'b1');
  assert.equal(m?.occurrences, 1);
  assert.equal(m?.provenance, 'derived');
  assert.equal(m?.flaky, undefined);
  assert.equal(m?.resolvedBy, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('history: resolved entries surface resolvedBy; persist round-trips', async () => {
  const { dir, file } = await tmpIndex();
  const h = await HistoryIndex.open(file);
  h.recordCrash('fp1', occ(1));
  h.recordResolution('fp1', {
    bundleId: 'b1',
    commit: 'cafebabe',
    at: '2026-07-02T00:00:00.000Z',
    filesTouched: ['src/a.ts'],
    suspects: [
      { path: 'src/a.ts', score: 5, reasons: [] },
      { path: 'src/z.ts', score: 1, reasons: [] },
    ],
  });
  await h.persist();

  const reopened = await HistoryIndex.open(file);
  const m = reopened.match('fp1', null);
  assert.deepEqual(m?.resolvedBy, { commit: 'cafebabe', filesTouched: ['src/a.ts'] });
  const entry = reopened.entry('fp1');
  assert.equal(entry?.resolved?.top1Hit, true);
  assert.equal(entry?.resolved?.top3Hit, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('history: top1/top3 ledger scores misses correctly', async () => {
  const { dir, file } = await tmpIndex();
  const h = await HistoryIndex.open(file);
  h.recordResolution('fp-miss', {
    bundleId: 'b1',
    commit: 'c',
    at: '2026-07-02T00:00:00.000Z',
    filesTouched: ['src/actual-fix.ts'],
    suspects: [
      { path: 'src/wrong1.ts', score: 5, reasons: [] },
      { path: 'src/wrong2.ts', score: 3, reasons: [] },
      { path: 'src/actual-fix.ts', score: 2, reasons: [] },
    ],
  });
  const e = h.entry('fp-miss');
  assert.equal(e?.resolved?.top1Hit, false);
  assert.equal(e?.resolved?.top3Hit, true, 'third-ranked suspect counts for top-3');

  const stats = summarizeStats(h.entries());
  assert.deepEqual(stats, { resolved: 1, top1Hits: 0, top3Hits: 1 });
  await fs.rm(dir, { recursive: true, force: true });
});

test('history: flaky when a prior occurrence crashed at the journal-green sha', async () => {
  const { dir, file } = await tmpIndex();
  const h = await HistoryIndex.open(file);
  h.recordCrash('fp1', occ(1, { head: 'deadbeef' }));
  assert.equal(h.match('fp1', 'deadbeef')?.flaky, true, 'green+crash at same sha');
  assert.equal(h.match('fp1', 'othersha')?.flaky, undefined);
  assert.equal(h.match('fp1', null)?.flaky, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('history: corrupt index degrades to empty, never throws', async () => {
  const { dir, file } = await tmpIndex();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ not json !!!', 'utf8');
  const h = await HistoryIndex.open(file);
  assert.equal(h.match('anything', null), undefined);
  h.recordCrash('fp1', occ(1));
  await h.persist(); // heals the file
  const reopened = await HistoryIndex.open(file);
  assert.equal(reopened.match('fp1', null)?.matchedBundleId, 'b1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('history: GC evicts stale entries and caps at 200 freshest', async () => {
  const { dir, file } = await tmpIndex();
  const h = await HistoryIndex.open(file);
  const now = new Date('2026-07-10T00:00:00.000Z');

  h.recordCrash('fp-old', occ(1, { at: '2026-01-01T00:00:00.000Z' })); // >60d
  for (let i = 0; i < 205; i++) {
    h.recordCrash(`fp-${i}`, occ(i, { at: `2026-07-0${(i % 9) + 1}T00:00:00.000Z` }));
  }
  h.gc(now);
  const entries = h.entries();
  assert.equal(entries['fp-old'], undefined, 'stale entry evicted');
  assert.equal(Object.keys(entries).length, 200, 'capped at 200');
  await fs.rm(dir, { recursive: true, force: true });
});

// ── Integration: crash → fix+verify → same crash again cites the fix ─────────

const BROKEN = 'function f() { throw new Error("kaboom recurring"); }\nf();\n';
const FIXED = 'process.exit(0);\n';

test('history integration: recurrence cites prior bundle + resolving commit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-hist-e2e-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'app.js'), BROKEN);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  const storePaths = resolveStorePaths(dir);
  const sink = createFileSink({ bundlesDir: storePaths.bundlesDir, render: renderMarkdown });
  const capture = () =>
    executePipeline({
      command: { argv: [process.execPath, 'app.js'], cwd: dir },
      config: DEFAULT_CONFIG,
      storePaths,
      sinks: [sink],
    });

  // 1. First crash: no history block.
  const first = await capture();
  assert.equal(first.outcome, 'crash');
  if (first.outcome !== 'crash') return;
  assert.equal(first.bundle.history, undefined, 'first occurrence has no history');

  // 2. Fix + verify → resolution recorded.
  await fs.writeFile(path.join(dir, 'app.js'), FIXED);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fix'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  const verified = await verifyBundle({ projectCwd: dir });
  assert.equal(verified.status, 'fixed');

  // 3. Reintroduce the same bug: history block names the fix.
  await fs.writeFile(path.join(dir, 'app.js'), BROKEN);
  const second = await capture();
  assert.equal(second.outcome, 'crash');
  if (second.outcome !== 'crash') return;
  const hist = second.bundle.history;
  assert.ok(hist, 'recurrence must carry a history block');
  assert.equal(hist!.matchedBundleId, first.bundle.id);
  assert.equal(hist!.provenance, 'derived');
  assert.equal(hist!.resolvedBy?.commit, head);
  assert.ok(
    hist!.resolvedBy!.filesTouched.some((f) => f.includes('app.js')),
    `filesTouched should cite app.js, got: ${hist!.resolvedBy!.filesTouched.join(', ')}`,
  );

  await fs.rm(dir, { recursive: true, force: true });
});
