import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { collectGit } from './git.js';
import { gitDiffProvider } from './gitDiffProvider.js';
import { fingerprint, openJournal } from '../journal/journal.js';
import { run } from '../util/exec.js';
import type { CommandSpec } from '../types.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-git-'));
}

async function git(cwd: string, args: string[]): Promise<void> {
  const { code, stderr } = await run('git', args, { cwd });
  assert.equal(code, 0, `git ${args.join(' ')} failed: ${stderr}`);
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'file.txt'), 'hello\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
}

test('collectGit reports not-a-repo outside any repository', async () => {
  const dir = await tmpDir();
  try {
    const journal = await openJournal(path.join(dir, 'journal.json'));
    const command: CommandSpec = { argv: ['npm', 'test'], cwd: dir };
    const info = await collectGit(command, journal);
    assert.equal(info.isRepo, false);
    assert.equal(info.branch, null);
    assert.equal(info.head, null);
    assert.equal(info.dirty, false);
    assert.deepEqual(info.changedFiles, []);
    assert.equal(info.greenRef, null);
    assert.equal(info.greenRefSource, 'none');
    assert.equal(info.note, 'not a git repository');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectGit reports branch/head/dirty/changedFiles', async () => {
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    // Make an uncommitted change.
    await fs.writeFile(path.join(dir, 'file.txt'), 'hello\nworld\n', 'utf8');

    const journal = await openJournal(path.join(dir, 'journal.json'));
    const command: CommandSpec = { argv: ['npm', 'test'], cwd: dir };
    const info = await collectGit(command, journal);

    assert.equal(info.isRepo, true);
    assert.ok(info.branch && info.branch.length > 0);
    assert.match(info.head ?? '', /^[0-9a-f]{40}$/);
    assert.equal(info.dirty, true);
    assert.equal(info.changedFiles.length, 1);
    assert.equal(info.changedFiles[0]?.path, 'file.txt');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectGit uses journal greenRef and diffVsGreen contains the change', async () => {
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const branch = (
      await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    ).stdout.trim();

    // Record the initial commit as green for this command+branch.
    const journal = await openJournal(path.join(dir, 'journal.json'));
    const command: CommandSpec = { argv: ['npm', 'test'], cwd: dir };
    await journal.recordGreen(fingerprint(command.argv, branch), head);

    // Now introduce an uncommitted change after the green commit.
    await fs.writeFile(path.join(dir, 'file.txt'), 'hello\nDISTINCT_CHANGE\n', 'utf8');

    const info = await collectGit(command, journal, gitDiffProvider);
    assert.equal(info.greenRef, head);
    assert.equal(info.greenRefSource, 'journal');
    assert.ok(info.diffVsGreen, 'expected diffVsGreen');
    assert.equal(info.diffVsGreen?.base, head);
    assert.equal(info.diffVsGreen?.truncated, false);
    assert.match(info.diffVsGreen?.patch ?? '', /DISTINCT_CHANGE/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('collectGit falls back to head~1 when no journal/origin', async () => {
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    // Second commit so HEAD~1 exists.
    await fs.writeFile(path.join(dir, 'file.txt'), 'hello\nsecond\n', 'utf8');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'second']);

    const journal = await openJournal(path.join(dir, 'journal.json'));
    const command: CommandSpec = { argv: ['npm', 'test'], cwd: dir };
    const info = await collectGit(command, journal);

    assert.equal(info.greenRefSource, 'head~1');
    assert.match(info.greenRef ?? '', /^[0-9a-f]{40}$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('gitDiffProvider truncates to maxBytes', async () => {
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    // Big uncommitted change. `git add -N` makes it visible to `git diff` while
    // keeping it uncommitted (working-tree-inclusive diff).
    await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(5000) + '\n', 'utf8');
    await git(dir, ['add', '-N', 'big.txt']);
    const res = await gitDiffProvider.diff(head, { cwd: dir, maxBytes: 100 });
    assert.equal(res.truncated, true);
    assert.ok(Buffer.from(res.patch, 'utf8').length <= 100);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('gitDiffProvider returns empty on bad ref', async () => {
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    const res = await gitDiffProvider.diff('no-such-ref-xyz', { cwd: dir });
    assert.equal(res.patch, '');
    assert.equal(res.truncated, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
