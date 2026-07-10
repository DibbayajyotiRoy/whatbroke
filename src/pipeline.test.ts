/**
 * E2E tests for the shared pipeline orchestrator (ADR-0007): a green run
 * records the journal and stays bundle-free; a crashing run produces a
 * redacted bundle through the file sink.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executePipeline, SpawnFailedError } from './pipeline.js';
import { DEFAULT_CONFIG } from './config.js';
import { resolveStorePaths } from './paths.js';
import { openJournal } from './journal/journal.js';
import { createFileSink } from './sinks/file.js';
import { renderMarkdown } from './render/markdown.js';

async function makeTmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-pipeline-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'ok.js'), 'process.exit(0);\n');
  await fs.writeFile(
    path.join(dir, 'boom.js'),
    'function explode() { throw new Error("kaboom from boom.js"); }\nexplode();\n',
  );
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function optsFor(dir: string, argv: string[], sinks: Parameters<typeof executePipeline>[0]['sinks']) {
  return {
    command: { argv, cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths: resolveStorePaths(dir),
    sinks,
  };
}

test('pipeline: green run records journal green and returns outcome green', async () => {
  const dir = await makeTmpRepo();
  const result = await executePipeline(optsFor(dir, [process.execPath, 'ok.js'], []));
  assert.equal(result.outcome, 'green');
  assert.equal(result.exitCode, 0);

  const journal = await openJournal(path.join(dir, '.whatbroke', 'journal.json'));
  assert.equal(journal.list().length, 1);
  // No bundle store should exist after a green run.
  await assert.rejects(fs.access(path.join(dir, '.whatbroke', 'bundles')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('pipeline: crash run writes a redacted bundle via the file sink', async () => {
  const dir = await makeTmpRepo();
  const storePaths = resolveStorePaths(dir);
  const sink = createFileSink({ bundlesDir: storePaths.bundlesDir, render: renderMarkdown });
  const result = await executePipeline(optsFor(dir, [process.execPath, 'boom.js'], [sink]));

  assert.equal(result.outcome, 'crash');
  if (result.outcome !== 'crash') return;
  assert.equal(result.exitCode, 1);
  assert.equal(result.bundle.crash.error?.message.includes('kaboom'), true);
  assert.equal(result.sinkResults.length, 1);
  assert.equal(result.sinkResults[0]?.ok, true);

  const files = await fs.readdir(storePaths.bundlesDir);
  assert.equal(files.some((f) => f.endsWith('.json')), true);
  assert.equal(files.some((f) => f.endsWith('.md')), true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('pipeline: unspawnable command throws SpawnFailedError with ENOENT', async () => {
  const dir = await makeTmpRepo();
  await assert.rejects(
    executePipeline(optsFor(dir, ['definitely-not-a-real-command-xyz'], [])),
    (err: unknown) => err instanceof SpawnFailedError && err.code === 'ENOENT',
  );
  await fs.rm(dir, { recursive: true, force: true });
});
