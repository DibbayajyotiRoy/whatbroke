/**
 * Watch mode tests (roadmap 6.2): debounce, fingerprint dedup (one bundle per
 * distinct failure per session), green recording — session core driven
 * directly, no fs.watch flakiness.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWatchSession, shouldIgnorePath } from './watch.js';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveStorePaths } from '../paths.js';
import { openJournal } from '../journal/journal.js';
import type { PipelineResult } from '../pipeline.js';
import type { CommandSpec, Sink } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSessionHarness(results: () => PipelineResult) {
  const calls: CommandSpec[] = [];
  const runPipeline = async (command: CommandSpec, _sinks: Sink[]): Promise<PipelineResult> => {
    calls.push(command);
    return results();
  };
  return { calls, runPipeline };
}

const GREEN: PipelineResult = { outcome: 'green', exitCode: 0 };

test('watch: 3 rapid triggers within the debounce window run once', async () => {
  const { calls, runPipeline } = fakeSessionHarness(() => GREEN);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-watch-'));
  const session = createWatchSession({
    command: { argv: ['x'], cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths: resolveStorePaths(dir),
    debounceMs: 50,
    runPipeline,
  });

  session.trigger();
  session.trigger();
  session.trigger();
  await sleep(120);
  await session.idle();
  assert.equal(calls.length, 1, 'rapid triggers must coalesce into one run');

  session.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('watch: triggers during a run coalesce into exactly one follow-up run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-watch-'));
  let calls = 0;
  const runPipeline = async (): Promise<PipelineResult> => {
    calls += 1;
    await sleep(80);
    return GREEN;
  };
  const session = createWatchSession({
    command: { argv: ['x'], cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths: resolveStorePaths(dir),
    debounceMs: 10,
    runPipeline,
  });

  const first = session.runNow();
  await sleep(20); // run in flight
  session.trigger();
  session.trigger();
  await sleep(30);
  session.trigger();
  await first;
  await sleep(200);
  await session.idle();
  assert.equal(calls, 2, 'in-flight triggers coalesce to a single follow-up');

  session.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('watch e2e: same crash twice → 1 bundle; A then B then A → 2 bundles; green recorded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-watch-e2e-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  const app = path.join(dir, 'app.js');
  const CRASH_A = 'function a() { throw new Error("failure alpha"); }\na();\n';
  const CRASH_B = 'function b() { throw new TypeError("failure beta entirely"); }\nb();\n';
  await fs.writeFile(app, CRASH_A);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  const storePaths = resolveStorePaths(dir);
  const events: string[] = [];
  const session = createWatchSession({
    command: { argv: [process.execPath, 'app.js'], cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths,
    debounceMs: 10,
    onEvent: (ev) => events.push(ev.kind),
  });

  const bundles = async () => {
    try {
      return (await fs.readdir(storePaths.bundlesDir)).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  };

  await session.runNow(); // crash A → bundle 1
  assert.equal(await bundles(), 1);
  await session.runNow(); // crash A again → deduped
  assert.equal(await bundles(), 1, 'identical failure must not create a second bundle');

  await fs.writeFile(app, CRASH_B);
  await session.runNow(); // crash B → bundle 2
  assert.equal(await bundles(), 2, 'a different failure gets its own bundle');

  await fs.writeFile(app, CRASH_A);
  await session.runNow(); // crash A recurs → still deduped (once per session)
  assert.equal(await bundles(), 2, 'at most one bundle per distinct failure per session');

  await fs.writeFile(app, 'process.exit(0);\n');
  await session.runNow(); // green
  const journal = await openJournal(storePaths.journal);
  assert.equal(journal.list().length, 1, 'green recorded while watching');

  assert.deepEqual(
    events,
    ['run-start', 'new-crash', 'run-start', 'same-crash', 'run-start', 'new-crash', 'run-start', 'same-crash', 'run-start', 'green'],
  );
  assert.equal(session.capturedFingerprints().length, 2);

  session.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('watch: ignore rules skip noise dirs and dotfiles', () => {
  assert.equal(shouldIgnorePath(path.join('node_modules', 'x', 'y.js')), true);
  assert.equal(shouldIgnorePath(path.join('.whatbroke', 'bundles', 'b.json')), true);
  assert.equal(shouldIgnorePath(path.join('.git', 'HEAD')), true);
  assert.equal(shouldIgnorePath(path.join('dist', 'app.js')), true);
  assert.equal(shouldIgnorePath(path.join('.cache', 'z')), true);
  assert.equal(shouldIgnorePath(path.join('src', 'app.ts')), false);
  assert.equal(shouldIgnorePath('app.js'), false);
});
