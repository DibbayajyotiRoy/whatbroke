import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { collectEnv } from './env.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-env-'));
}

test('collectEnv reports node runtime and os', async () => {
  const dir = await tmpDir();
  try {
    const info = await collectEnv(dir);
    assert.equal(info.runtime.node, process.versions.node);
    assert.equal(info.os.platform, os.platform());
    assert.equal(info.os.arch, os.arch());
    assert.equal(info.cwd, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectEnv returns env KEYS but no values', async () => {
  const dir = await tmpDir();
  try {
    const info = await collectEnv(dir);
    assert.ok(info.envKeys.length > 0, 'expected some env keys');
    // Sorted.
    const sorted = [...info.envKeys].sort();
    assert.deepEqual(info.envKeys, sorted);
    // Values are empty by default (redaction fills allowlisted ones later).
    assert.deepEqual(info.envValues, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectEnv detects npm from a package-lock.json', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}', 'utf8');
    const info = await collectEnv(dir);
    assert.equal(info.packageManager.name, 'npm');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectEnv detects pnpm from a pnpm-lock.yaml', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    const info = await collectEnv(dir);
    assert.equal(info.packageManager.name, 'pnpm');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectEnv yields unknown pm with null version when undetectable', async () => {
  const dir = await tmpDir();
  const saved = process.env['npm_config_user_agent'];
  delete process.env['npm_config_user_agent'];
  try {
    const info = await collectEnv(dir);
    assert.equal(info.packageManager.name, 'unknown');
    assert.equal(info.packageManager.version, null);
  } finally {
    if (saved !== undefined) process.env['npm_config_user_agent'] = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
