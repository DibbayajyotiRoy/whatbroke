/**
 * E2E tests for `whatbroke verify` (roadmap 1.1): the crash → fix → verify
 * loop, delta classification on still-failing runs, typed never-hang errors,
 * and the AC5 security invariant (argv re-run verbatim, no shell).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyBundle, VerifyError } from '../verify/verify.js';
import { executePipeline } from '../pipeline.js';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveStorePaths, bundleJsonPath } from '../paths.js';
import { createFileSink } from '../sinks/file.js';
import { renderMarkdown } from '../render/markdown.js';
import { openJournal } from '../journal/journal.js';

const BROKEN = 'function f() { throw new Error("kaboom original"); }\nf();\n';
const FIXED = 'process.exit(0);\n';
const DIFFERENT = 'function g() { throw new TypeError("totally different beast"); }\ng();\n';

async function makeRepo(entry = BROKEN): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'app.js'), entry);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** Capture a crash bundle for `node app.js` in dir; returns the bundle id. */
async function captureCrash(dir: string, argv?: string[]): Promise<string> {
  const storePaths = resolveStorePaths(dir);
  const result = await executePipeline({
    command: { argv: argv ?? [process.execPath, 'app.js'], cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths,
    sinks: [createFileSink({ bundlesDir: storePaths.bundlesDir, render: renderMarkdown })],
  });
  assert.equal(result.outcome, 'crash', 'fixture must crash on capture');
  if (result.outcome !== 'crash') throw new Error('unreachable');
  return result.bundle.id;
}

async function bundleCount(dir: string): Promise<number> {
  const files = await fs.readdir(path.join(dir, '.whatbroke', 'bundles'));
  return files.filter((f) => f.endsWith('.json')).length;
}

test('verify: fixed → exit 0, resolution stamped with commit, journal green', async () => {
  const dir = await makeRepo();
  const id = await captureCrash(dir);

  await fs.writeFile(path.join(dir, 'app.js'), FIXED);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fix'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

  const outcome = await verifyBundle({ projectCwd: dir });
  assert.equal(outcome.status, 'fixed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.bundleId, id);
  assert.equal(outcome.resolvedCommit, head);

  const stored = JSON.parse(
    await fs.readFile(bundleJsonPath(path.join(dir, '.whatbroke', 'bundles'), id), 'utf8'),
  ) as { resolution?: { status: string; commit: string } };
  assert.equal(stored.resolution?.status, 'resolved');
  assert.equal(stored.resolution?.commit, head);

  const journal = await openJournal(path.join(dir, '.whatbroke', 'journal.json'));
  assert.equal(journal.list().length, 1, 'green recorded in journal');

  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: still broken → same-failure, child exit code, no new bundle, no stamp', async () => {
  const dir = await makeRepo();
  const id = await captureCrash(dir);

  const outcome = await verifyBundle({ projectCwd: dir });
  assert.equal(outcome.status, 'same-failure');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.delta?.verdict, 'same');
  assert.equal(outcome.newBundleId, undefined);
  assert.equal(await bundleCount(dir), 1, 'same failure must not spam a new bundle');

  const stored = JSON.parse(
    await fs.readFile(bundleJsonPath(path.join(dir, '.whatbroke', 'bundles'), id), 'utf8'),
  ) as { resolution?: unknown };
  assert.equal(stored.resolution, undefined);

  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: different crash → different-failure with a captured new bundle', async () => {
  const dir = await makeRepo();
  await captureCrash(dir);

  await fs.writeFile(path.join(dir, 'app.js'), DIFFERENT);

  const outcome = await verifyBundle({ projectCwd: dir });
  assert.equal(outcome.status, 'different-failure');
  assert.notEqual(outcome.delta?.verdict, 'same');
  assert.ok(outcome.newBundleId, 'new bundle id returned for iteration');
  assert.equal(await bundleCount(dir), 2, 'the different failure is persisted');
  assert.ok((outcome.delta?.reasons.length ?? 0) > 0, 'delta carries reasons');

  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: empty store → typed bundle-not-found', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-verify-empty-'));
  await assert.rejects(
    verifyBundle({ projectCwd: dir }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'bundle-not-found',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: bundle without captured command → typed no-command', async () => {
  const dir = await makeRepo();
  const id = await captureCrash(dir);
  const p = bundleJsonPath(path.join(dir, '.whatbroke', 'bundles'), id);
  const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as { command?: unknown };
  delete parsed.command;
  await fs.writeFile(p, JSON.stringify(parsed));

  await assert.rejects(
    verifyBundle({ projectCwd: dir }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'no-command',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: captured cwd deleted → typed cwd-missing, no hang', async () => {
  // Store lives in projectDir; the captured command ran in a separate repoDir.
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-verify-store-'));
  const repoDir = await makeRepo();
  const storePaths = resolveStorePaths(projectDir);
  const result = await executePipeline({
    command: { argv: [process.execPath, 'app.js'], cwd: repoDir },
    config: DEFAULT_CONFIG,
    storePaths,
    sinks: [createFileSink({ bundlesDir: storePaths.bundlesDir, render: renderMarkdown })],
  });
  assert.equal(result.outcome, 'crash');

  await fs.rm(repoDir, { recursive: true, force: true });
  await assert.rejects(
    verifyBundle({ projectCwd: projectDir }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'cwd-missing',
  );
  await fs.rm(projectDir, { recursive: true, force: true });
});

test('verify: captured command gone → typed command-missing', async () => {
  const dir = await makeRepo();
  const id = await captureCrash(dir);
  const p = bundleJsonPath(path.join(dir, '.whatbroke', 'bundles'), id);
  const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as {
    command: { argv: string[]; cwd: string };
  };
  parsed.command.argv = ['definitely-not-a-real-command-xyz'];
  await fs.writeFile(p, JSON.stringify(parsed));

  await assert.rejects(
    verifyBundle({ projectCwd: dir }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'command-missing',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: hanging re-run is killed → typed timeout, never hangs', async () => {
  const dir = await makeRepo();
  // First capture: crashes. Re-run: hangs (marker file flips the behavior).
  await fs.writeFile(
    path.join(dir, 'app.js'),
    `const fs = require('node:fs');
if (fs.existsSync('marker.txt')) { setInterval(() => {}, 1000); }
else { throw new Error('kaboom original'); }
`,
  );
  await captureCrash(dir);
  await fs.writeFile(path.join(dir, 'marker.txt'), '1');

  const started = Date.now();
  await assert.rejects(
    verifyBundle({ projectCwd: dir, timeoutMs: 500 }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'timeout',
  );
  assert.ok(Date.now() - started < 30_000, 'timeout path returned promptly');
  await fs.rm(dir, { recursive: true, force: true });
});

test('verify: secret in argv is scrubbed in the bundle AND verify fails closed', async () => {
  const dir = await makeRepo();
  // A real-shaped AWS key passed as a CLI arg: the known-format detector must
  // scrub it from the stored bundle, and verify must refuse to execute the
  // placeholder-containing argv rather than run a corrupted command.
  const id = await captureCrash(dir, [
    process.execPath,
    'app.js',
    '--token=AKIAIOSFODNN7EXAMPLE',
  ]);
  const raw = await fs.readFile(
    bundleJsonPath(path.join(dir, '.whatbroke', 'bundles'), id),
    'utf8',
  );
  assert.equal(raw.includes('AKIAIOSFODNN7EXAMPLE'), false, 'secret must not persist');

  await assert.rejects(
    verifyBundle({ projectCwd: dir }),
    (e: unknown) => e instanceof VerifyError && e.kind === 'argv-redacted',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('verify AC5: re-runs the recorded argv verbatim — array spawn, no shell', async () => {
  const dir = await makeRepo();
  // The script records its argv, then crashes. Hostile-looking args must arrive
  // as literal strings; shell interpolation would split/execute them.
  await fs.writeFile(
    path.join(dir, 'app.js'),
    `require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
throw new Error('kaboom original');
`,
  );
  const hostile = ['abc; touch pwned.txt', '$(echo injected)', '&& echo no'];
  await captureCrash(dir, [process.execPath, 'app.js', ...hostile]);
  await fs.rm(path.join(dir, 'argv.json'));

  const outcome = await verifyBundle({ projectCwd: dir });
  assert.equal(outcome.status, 'same-failure');

  const argvSeen = JSON.parse(await fs.readFile(path.join(dir, 'argv.json'), 'utf8'));
  assert.deepEqual(argvSeen, hostile, 're-run argv must be byte-identical');
  await assert.rejects(fs.access(path.join(dir, 'pwned.txt')), 'shell metachars must be inert');
  await fs.rm(dir, { recursive: true, force: true });
});
