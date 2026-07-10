import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { doctorCmd } from './doctor.js';
import { findMcpRegistration } from './init.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-doctor-'));
}

/** Same offline stand-in MCP server as init.test.ts (newline-delimited JSON-RPC). */
const RESPONDER_ARGV = [
  process.execPath,
  '-e',
  "process.stdin.on('data',()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n')});setInterval(()=>{},1000);",
];

const REGISTRATION = {
  mcpServers: { whatbroke: { command: 'npx', args: ['-y', '@whatbroke/whatbroke', 'mcp'] } },
};

/** Capture everything doctor writes to stdout while `fn` runs. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, output };
  } finally {
    process.stdout.write = original;
  }
}

// ── findMcpRegistration ─────────────────────────────────────────────────────

test('findMcpRegistration: .mcp.json with whatbroke entry is found', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify(REGISTRATION), 'utf8');
    const reg = await findMcpRegistration(dir);
    assert.ok(reg);
    assert.equal(reg.file, path.join(dir, '.mcp.json'));
    assert.equal(reg.topKey, 'mcpServers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findMcpRegistration: .vscode/mcp.json uses the `servers` key', async () => {
  const dir = await tmpDir();
  try {
    await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: REGISTRATION.mcpServers }),
      'utf8',
    );
    const reg = await findMcpRegistration(dir);
    assert.ok(reg);
    assert.equal(reg.file, path.join(dir, '.vscode', 'mcp.json'));
    assert.equal(reg.topKey, 'servers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findMcpRegistration: empty dir → null; config without whatbroke → null', async () => {
  const dir = await tmpDir();
  try {
    assert.equal(await findMcpRegistration(dir), null);

    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      'utf8',
    );
    assert.equal(await findMcpRegistration(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findMcpRegistration: corrupt file is skipped, later candidate still found', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, '.mcp.json'), '{ not json', 'utf8');
    await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.cursor', 'mcp.json'),
      JSON.stringify(REGISTRATION),
      'utf8',
    );
    const reg = await findMcpRegistration(dir);
    assert.ok(reg);
    assert.equal(reg.file, path.join(dir, '.cursor', 'mcp.json'));
    assert.equal(reg.topKey, 'mcpServers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── doctorCmd integration ───────────────────────────────────────────────────

test('doctor reports an existing registration and a booting server', async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify(REGISTRATION), 'utf8');
    const { result, output } = await captureStdout(() =>
      doctorCmd({ cwd: dir, smokeArgv: RESPONDER_ARGV, smokeTimeoutMs: 5000 }),
    );
    assert.equal(result, 0);
    assert.match(output, /mcp reg\s+\.mcp\.json \(mcpServers\.whatbroke\)/);
    assert.match(output, /mcp start\s+ok \(responded in \d+ms\)/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor reports a missing registration and warns (not fails) on a dead server', async () => {
  const dir = await tmpDir();
  try {
    const { result, output } = await captureStdout(() =>
      doctorCmd({
        cwd: dir,
        smokeArgv: [process.execPath, '-e', 'process.exit(1)'],
        smokeTimeoutMs: 2000,
      }),
    );
    assert.equal(result, 0); // doctor never fails
    assert.match(output, /mcp reg\s+not registered — run `whatbroke init`/);
    assert.match(output, /mcp start\s+warn: /);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
