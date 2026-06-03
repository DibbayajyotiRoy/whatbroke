import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { BundleStore } from './store.js';
import type { RedactedBundle } from '../types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-mcp-'));
}

/** Minimal RedactedBundle fixture; cast since we only exercise read paths. */
function fixture(over: {
  id: string;
  createdAt: string;
  confidence?: 'high' | 'medium' | 'low';
  errorMessage?: string;
}): RedactedBundle {
  return {
    schemaVersion: 1,
    id: over.id,
    createdAt: over.createdAt,
    tool: { name: 'whatbroke', version: '0.1.0' },
    crash: {
      kind: 'uncaught-exception',
      exitCode: 1,
      signal: null,
      error: { name: 'TypeError', message: over.errorMessage ?? 'boom', stack: [], rawStack: '' },
    },
    git: {
      isRepo: true,
      branch: 'main',
      head: `head-${over.id}`,
      dirty: false,
      changedFiles: [],
      greenRef: 'green',
      diffVsGreen: { base: 'green', truncated: false, patch: `patch-${over.id}` },
    },
    logs: { stdoutTail: 'out line\nother', stderrTail: 'ERR boom\nquiet', truncated: false, bufferLines: 2 },
    repro: {
      steps: [{ order: 1, text: 'run npm test', provenance: 'observed' }],
      suspects: [{ path: `src/${over.id}.ts`, score: 9, reasons: ['on stack frame 1'] }],
      confidence: over.confidence ?? 'high',
    },
  } as unknown as RedactedBundle;
}

async function writeBundle(dir: string, b: RedactedBundle): Promise<void> {
  await fs.writeFile(path.join(dir, `whatbroke-${b.id}.json`), JSON.stringify(b), 'utf8');
}

test('list returns most-recent-first and honors limit', async () => {
  const dir = await tmpDir();
  try {
    await writeBundle(dir, fixture({ id: 'old', createdAt: '2026-06-01T00:00:00.000Z' }));
    await writeBundle(dir, fixture({ id: 'new', createdAt: '2026-06-03T00:00:00.000Z', confidence: 'low' }));
    const store = new BundleStore(dir);

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.id, 'new');
    assert.equal(all[1]?.id, 'old');
    assert.equal(all[0]?.confidence, 'low');
    assert.match(all[0]?.error ?? '', /TypeError: boom/);

    const limited = await store.list(1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.id, 'new');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('get() returns the latest bundle; get(id) returns the right one', async () => {
  const dir = await tmpDir();
  try {
    await writeBundle(dir, fixture({ id: 'old', createdAt: '2026-06-01T00:00:00.000Z' }));
    await writeBundle(dir, fixture({ id: 'new', createdAt: '2026-06-03T00:00:00.000Z' }));
    const store = new BundleStore(dir);

    const latest = await store.get();
    assert.equal(latest?.id, 'new');

    const byId = await store.get('old');
    assert.equal(byId?.id, 'old');
    assert.equal(byId?.git.head, 'head-old');

    const missing = await store.get('nope');
    assert.equal(missing, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('latestId returns the most recent id', async () => {
  const dir = await tmpDir();
  try {
    await writeBundle(dir, fixture({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }));
    await writeBundle(dir, fixture({ id: 'b', createdAt: '2026-12-01T00:00:00.000Z' }));
    const store = new BundleStore(dir);
    assert.equal(await store.latestId(), 'b');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unparseable files are skipped, valid ones still served', async () => {
  const dir = await tmpDir();
  try {
    await writeBundle(dir, fixture({ id: 'good', createdAt: '2026-06-03T00:00:00.000Z' }));
    await fs.writeFile(path.join(dir, 'whatbroke-bad.json'), '{ not json', 'utf8');
    // A non-matching filename must also be ignored.
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello', 'utf8');
    const store = new BundleStore(dir);

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, 'good');
    assert.equal(await store.latestId(), 'good');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('missing directory yields empty results, not a throw', async () => {
  const store = new BundleStore(path.join(os.tmpdir(), 'whatbroke-does-not-exist-xyz'));
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get(), null);
  assert.equal(await store.latestId(), null);
});
