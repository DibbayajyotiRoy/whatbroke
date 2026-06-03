import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { fingerprint, openJournal } from './journal.js';
import type { JournalFile } from '../types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-journal-'));
}

test('fingerprint is stable for the same input', () => {
  const a = fingerprint(['npm', 'test'], 'main');
  const b = fingerprint(['npm', 'test'], 'main');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('fingerprint differs by branch and by command', () => {
  assert.notEqual(fingerprint(['npm', 'test'], 'main'), fingerprint(['npm', 'test'], 'dev'));
  assert.notEqual(fingerprint(['npm', 'test'], 'main'), fingerprint(['npm', 'build'], 'main'));
});

test('fingerprint normalizes volatile flags and whitespace', () => {
  const base = fingerprint(['npm', 'test'], 'main');
  assert.equal(fingerprint(['npm', 'test', '--watch'], 'main'), base);
  assert.equal(fingerprint(['npm', 'test', '--coverage', '--verbose'], 'main'), base);
  assert.equal(fingerprint(['npm', ' test '], 'main'), base);
});

test('recordGreen then lookupGreen round-trips and persists', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'nested', 'journal.json');
    const j = await openJournal(file);
    const fp = fingerprint(['npm', 'test'], 'main');
    assert.equal(j.lookupGreen(fp), null);

    await j.recordGreen(fp, 'abc123');
    assert.equal(j.lookupGreen(fp), 'abc123');

    // Re-open from disk: persistence + parent-dir creation worked.
    const j2 = await openJournal(file);
    assert.equal(j2.lookupGreen(fp), 'abc123');

    const list = j2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.entry.runCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recordGreen increments runCount on upsert', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'journal.json');
    const j = await openJournal(file);
    const fp = fingerprint(['npm', 'test'], 'main');
    await j.recordGreen(fp, 'sha1');
    await j.recordGreen(fp, 'sha2');
    assert.equal(j.lookupGreen(fp), 'sha2');
    assert.equal(j.list()[0]?.entry.runCount, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('corrupt file tolerance → empty journal', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'journal.json');
    await fs.writeFile(file, '{ this is not json', 'utf8');
    const j = await openJournal(file);
    assert.equal(j.list().length, 0);
    // Still usable after corruption.
    const fp = fingerprint(['x'], null);
    await j.recordGreen(fp, 'deadbeef');
    assert.equal(j.lookupGreen(fp), 'deadbeef');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('missing file → empty journal', async () => {
  const dir = await tmpDir();
  try {
    const j = await openJournal(path.join(dir, 'does-not-exist.json'));
    assert.equal(j.list().length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('clear empties the journal', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'journal.json');
    const j = await openJournal(file);
    await j.recordGreen(fingerprint(['a'], 'b'), 'sha');
    await j.clear();
    assert.equal(j.list().length, 0);
    const j2 = await openJournal(file);
    assert.equal(j2.list().length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GC drops entries older than 60 days on next write', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'journal.json');
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const seed: JournalFile = {
      version: 1,
      entries: {
        stale: { greenSha: 'old', greenAt: old, runCount: 1 },
      },
    };
    await fs.writeFile(file, JSON.stringify(seed), 'utf8');
    const j = await openJournal(file);
    // Stale entry still present until a write triggers GC.
    assert.equal(j.lookupGreen('stale'), 'old');
    await j.recordGreen('fresh', 'newsha');
    assert.equal(j.lookupGreen('stale'), null);
    assert.equal(j.lookupGreen('fresh'), 'newsha');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
