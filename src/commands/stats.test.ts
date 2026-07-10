/**
 * `whatbroke stats` (3.2): aggregation goldens + command-level empty state.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { statsCmd, summarizeStats } from './stats.js';
import { HistoryIndex, historyPath } from '../history/history.js';

test('stats: summarize counts hits over resolved entries only', () => {
  const entries = {
    hit1: { resolved: { top1Hit: true, top3Hit: true } },
    hit3only: { resolved: { top1Hit: false, top3Hit: true } },
    miss: { resolved: { top1Hit: false, top3Hit: false } },
    unresolved: {},
  };
  assert.deepEqual(summarizeStats(entries), { resolved: 3, top1Hits: 1, top3Hits: 2 });
});

test('stats command: empty store → friendly message, exit 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-stats-'));
  const code = await statsCmd({ cwd: dir, verbosity: 'quiet' });
  assert.equal(code, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stats command: seeded index → exit 0 with rates computed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-stats-'));
  const file = historyPath(path.join(dir, '.whatbroke'));
  const h = await HistoryIndex.open(file);
  const res = (top1: boolean, top3: boolean) => ({
    bundleId: 'b',
    commit: 'c',
    at: '2026-07-10T00:00:00.000Z',
    filesTouched: top1 ? ['src/a.ts'] : top3 ? ['src/b.ts'] : ['src/z.ts'],
    suspects: [
      { path: 'src/a.ts', score: 5, reasons: [] },
      { path: 'src/b.ts', score: 3, reasons: [] },
    ],
  });
  h.recordResolution('fp1', res(true, true));
  h.recordResolution('fp2', res(false, true));
  h.recordResolution('fp3', res(false, false));
  await h.persist();

  const code = await statsCmd({ cwd: dir, verbosity: 'quiet' });
  assert.equal(code, 0);
  const reopened = await HistoryIndex.open(file);
  assert.deepEqual(summarizeStats(reopened.entries()), {
    resolved: 3,
    top1Hits: 1,
    top3Hits: 2,
  });
  await fs.rm(dir, { recursive: true, force: true });
});
