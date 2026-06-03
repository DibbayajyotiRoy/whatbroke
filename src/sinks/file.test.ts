import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFileSink } from './file.js';
import type { RedactedBundle } from '../types.js';

const fixture = {
  id: 'abc123',
  crash: { kind: 'nonzero-exit', error: { name: 'Error', message: 'boom' } },
} as unknown as RedactedBundle;

test('file sink writes json + md and returns both paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whatbroke-file-test-'));
  try {
    const sink = createFileSink({ bundlesDir: dir, render: () => '# md' });
    const result = await sink(fixture);

    assert.equal(result.sink, 'file');
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.paths) && result.paths.length === 2);

    const jsonPath = join(dir, 'whatbroke-abc123.json');
    const mdPath = join(dir, 'whatbroke-abc123.md');
    assert.deepEqual(result.paths, [jsonPath, mdPath]);

    const json = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(json);
    assert.equal(parsed.id, 'abc123');

    const md = await readFile(mdPath, 'utf8');
    assert.equal(md, '# md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file sink creates the bundles dir if missing (mkdir -p)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'whatbroke-file-test-'));
  const nested = join(base, 'deep', 'bundles');
  try {
    const sink = createFileSink({ bundlesDir: nested, render: () => '# md' });
    const result = await sink(fixture);
    assert.equal(result.ok, true);
    const json = await readFile(join(nested, 'whatbroke-abc123.json'), 'utf8');
    assert.ok(json.includes('abc123'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
