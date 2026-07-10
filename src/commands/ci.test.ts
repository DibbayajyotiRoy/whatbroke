/**
 * CI mode (roadmap 2.1): stable machine line on stdout, no ANSI anywhere,
 * bundle always written, redaction gate identical to local mode.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ciModeEnabled } from './run.js';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

const MACHINE_LINE = /^::whatbroke bundle=(\S+) confidence=(high|medium|low) suspect=(\S+)$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

async function makeTmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-ci-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(
    path.join(dir, 'boom.js'),
    // The fake AWS key must be scrubbed from every CI output surface.
    'throw new Error("db down AKIAIOSFODNN7EXAMPLE ouch");\n',
  );
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function runCli(dir: string, args: string[], env: Record<string, string | undefined>) {
  return execFileP(TSX, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    reject: false,
  } as never).catch((err: { code?: number; stdout: string; stderr: string }) => err);
}

test('ciModeEnabled: flag wins, else CI env convention', () => {
  assert.equal(ciModeEnabled(true, {}), true);
  assert.equal(ciModeEnabled(false, { CI: 'true' }), false);
  assert.equal(ciModeEnabled(undefined, { CI: 'true' }), true);
  assert.equal(ciModeEnabled(undefined, { CI: '1' }), true);
  assert.equal(ciModeEnabled(undefined, { CI: 'false' }), false);
  assert.equal(ciModeEnabled(undefined, { CI: '0' }), false);
  assert.equal(ciModeEnabled(undefined, {}), false);
});

test('CI crash run: one machine line, no ANSI, bundle written, secrets scrubbed', async () => {
  const dir = await makeTmpRepo();
  const res = (await runCli(dir, ['run', '--ci', '--', process.execPath, 'boom.js'], {
    CI: undefined,
  })) as { code?: number; stdout: string; stderr: string };

  const machineLines = res.stdout.split('\n').filter((l) => l.startsWith('::whatbroke '));
  assert.equal(machineLines.length, 1, `stdout was: ${res.stdout}`);
  const m = MACHINE_LINE.exec(machineLines[0]!);
  assert.ok(m, `machine line did not match contract: ${machineLines[0]}`);

  assert.equal(ANSI.test(res.stdout), false, 'ANSI escape in stdout');
  assert.equal(ANSI.test(res.stderr), false, 'ANSI escape in stderr');

  const bundlePath = m![1]!;
  const raw = await fs.readFile(bundlePath, 'utf8');
  const bundle = JSON.parse(raw) as { schemaVersion: number };
  assert.equal(bundle.schemaVersion, 1);

  // Redaction gate unchanged in CI mode (2.1 AC4). The child's OWN stderr
  // passthrough may echo whatever the child printed (that is the user's
  // terminal data, by design); every whatbroke-authored surface must be clean.
  assert.equal(raw.includes('AKIAIOSFODNN7EXAMPLE'), false, 'secret leaked into bundle');
  assert.equal(res.stdout.includes('AKIAIOSFODNN7EXAMPLE'), false, 'secret leaked to stdout');
  const whatbrokeLines = res.stderr
    .split('\n')
    .filter((l) => l.includes('whatbroke') || l.trimStart().startsWith('✕'));
  assert.equal(
    whatbrokeLines.some((l) => l.includes('AKIAIOSFODNN7EXAMPLE')),
    false,
    `secret leaked into whatbroke-authored stderr: ${whatbrokeLines.join('\n')}`,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('CI auto-detect via env: machine line appears without --ci flag', async () => {
  const dir = await makeTmpRepo();
  const res = (await runCli(dir, ['run', '--', process.execPath, 'boom.js'], {
    CI: 'true',
  })) as { stdout: string };
  assert.equal(
    res.stdout.split('\n').filter((l) => l.startsWith('::whatbroke ')).length,
    1,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('--no-ci suppresses the machine line even when CI env is set', async () => {
  const dir = await makeTmpRepo();
  const res = (await runCli(dir, ['run', '--no-ci', '--', process.execPath, 'boom.js'], {
    CI: 'true',
  })) as { stdout: string };
  assert.equal(res.stdout.includes('::whatbroke '), false);
  await fs.rm(dir, { recursive: true, force: true });
});
