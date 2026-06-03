import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { collectDeps } from './deps.js';
import type { StackFrame } from '../types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-deps-'));
}

function frame(file: string | null): StackFrame {
  return {
    functionName: null,
    file,
    fileRelative: null,
    line: null,
    column: null,
    isUserCode: false,
    isInRepo: false,
    sourceMapped: false,
  };
}

async function writeModule(dir: string, name: string, version: string): Promise<void> {
  const modDir = path.join(dir, 'node_modules', ...name.split('/'));
  await fs.mkdir(modDir, { recursive: true });
  await fs.writeFile(
    path.join(modDir, 'package.json'),
    JSON.stringify({ name, version }),
    'utf8',
  );
}

test('collectDeps merges deps + devDeps, detects lockfile, resolves relevant', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { left: '^1.0.0' },
        devDependencies: { '@scope/right': '^2.0.0' },
      }),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}', 'utf8');
    await writeModule(dir, 'left', '1.4.2');
    await writeModule(dir, '@scope/right', '2.7.0');

    const frames: StackFrame[] = [
      frame(path.join(dir, 'node_modules', 'left', 'index.js')),
      frame(path.join(dir, 'node_modules', '@scope', 'right', 'lib', 'x.js')),
      frame(path.join(dir, 'src', 'app.js')), // user code, no node_modules
    ];

    const info = await collectDeps(dir, frames);
    assert.deepEqual(info.declared, { left: '^1.0.0', '@scope/right': '^2.0.0' });
    assert.equal(info.lockfile, 'package-lock');
    assert.equal(info.relevantResolved['left'], '1.4.2');
    assert.equal(info.relevantResolved['@scope/right'], '2.7.0');
    assert.equal(Object.keys(info.relevantResolved).length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectDeps tolerates missing package.json', async () => {
  const dir = await tmpDir();
  try {
    const info = await collectDeps(dir, []);
    assert.deepEqual(info.declared, {});
    assert.deepEqual(info.relevantResolved, {});
    assert.equal(info.lockfile, 'none');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectDeps skips packages not installed', async () => {
  const dir = await tmpDir();
  try {
    const frames = [frame(path.join(dir, 'node_modules', 'ghost', 'index.js'))];
    const info = await collectDeps(dir, frames);
    assert.equal(info.relevantResolved['ghost'], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectDeps detects pnpm-lock', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    const info = await collectDeps(dir, []);
    assert.equal(info.lockfile, 'pnpm-lock');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
