import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { runCommand } from './runner.js';
import type { CommandSpec } from '../types.js';

const cwd = process.cwd();

function nodeCmd(script: string): CommandSpec {
  return { argv: [process.execPath, '-e', script], cwd };
}

test('exit 0 yields null crash and exitCode 0', async () => {
  const res = await runCommand(nodeCmd('process.stdout.write("hello\\n")'));
  assert.equal(res.exitCode, 0);
  assert.equal(res.signal, null);
  assert.equal(res.crash, null);
  assert.ok(res.logs.stdoutTail.includes('hello'));
});

test('process.exit(3) yields nonzero-exit crash with exitCode 3', async () => {
  const res = await runCommand(nodeCmd('process.exit(3)'));
  assert.equal(res.exitCode, 3);
  assert.ok(res.crash);
  assert.equal(res.crash.kind, 'nonzero-exit');
  assert.equal(res.crash.exitCode, 3);
});

test('thrown error yields uncaught-exception with parsed error', async () => {
  const res = await runCommand(nodeCmd('throw new Error("boom")'));
  assert.notEqual(res.exitCode, 0);
  assert.ok(res.crash);
  assert.equal(res.crash.kind, 'uncaught-exception');
  assert.ok(res.crash.error);
  assert.equal(res.crash.error.name, 'Error');
  assert.equal(res.crash.error.message, 'boom');
  assert.ok(res.crash.error.stack.length > 0);
  assert.ok(res.logs.stderrTail.includes('boom'));
});

test('unhandled rejection (canonical marker) is classified', async () => {
  // Emit the exact stderr shape Node uses when it reports an unhandled
  // rejection via its banner, then exit nonzero. (Modern Node's default
  // rejection output varies by version; the marker is the stable contract.)
  const script =
    'process.stderr.write("node:internal/process/promises:288\\n' +
    'UnhandledPromiseRejection: This error originated either by throwing...\\n' +
    '    at /abs/file.ts:5:1\\n"); process.exit(1)';
  const res = await runCommand(nodeCmd(script));
  assert.notEqual(res.exitCode, 0);
  assert.ok(res.crash);
  assert.equal(res.crash.kind, 'unhandled-rejection');
});

test('stdout is captured into the tail', async () => {
  const res = await runCommand(
    nodeCmd('for (let i=0;i<3;i++) console.log("line"+i)'),
  );
  assert.equal(res.exitCode, 0);
  assert.ok(res.logs.stdoutTail.includes('line0'));
  assert.ok(res.logs.stdoutTail.includes('line2'));
  assert.ok(res.logs.combinedTail.includes('[stdout]'));
});

test('command not found rejects with ENOENT (not a crash)', async () => {
  await assert.rejects(
    runCommand({ argv: ['definitely-not-a-real-binary-xyz'], cwd }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { code?: string }).code, 'ENOENT');
      return true;
    },
  );
});

test('timeout kills child and reports a signal crash', async () => {
  const res = await runCommand(nodeCmd('setInterval(()=>{}, 1000)'), {
    timeoutMs: 100,
  });
  assert.ok(res.crash);
  assert.equal(res.crash.kind, 'signal');
  assert.ok(res.signal);
});

test('ring buffer size override truncates', async () => {
  const res = await runCommand(
    nodeCmd('for (let i=0;i<50;i++) console.log("L"+i)'),
    { logLines: 5 },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.logs.bufferLines, 5);
  assert.equal(res.logs.truncated, true);
  assert.ok(res.logs.stdoutTail.includes('L49'));
  assert.ok(!res.logs.stdoutTail.includes('L0\n'));
});

test('binary stdout does not throw and is noted', async () => {
  const res = await runCommand(
    nodeCmd('process.stdout.write(Buffer.from([0,1,2,3,255,254,0,0]))'),
  );
  assert.equal(res.exitCode, 0);
  assert.ok(res.crash === null);
  assert.ok(
    res.logs.stdoutTail.includes('binary') ||
      res.logs.combinedTail.includes('binary'),
  );
});
