import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  initCmd,
  smokeTestMcp,
  mcpServerEntry,
  resolveInitTarget,
  CLAUDE_MD_MARKER,
  MCP_SERVER_KEY,
  type InitArgs,
} from './init.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-init-'));
}

/**
 * A stand-in MCP server: replies to any stdin with a newline-delimited
 * JSON-RPC message (the framing the real SDK stdio transport uses), then
 * stays alive. Keeps the tests offline — no npx, no network.
 */
const RESPONDER_ARGV = [
  process.execPath,
  '-e',
  "process.stdin.on('data',()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n')});setInterval(()=>{},1000);",
];

function argsFor(dir: string, yes: boolean, extra?: Partial<InitArgs>): InitArgs {
  return { cwd: dir, yes, verbosity: 'quiet', smokeArgv: RESPONDER_ARGV, ...extra };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const EXPECTED_ENTRY = { command: 'npx', args: ['-y', '@whatbroke/whatbroke', 'mcp'] };

// ── initCmd: writing ────────────────────────────────────────────────────────

test('fresh dir + --yes creates .mcp.json (golden) and CLAUDE.md with the marker', async () => {
  const dir = await tmpDir();
  try {
    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);

    const raw = await fs.readFile(path.join(dir, '.mcp.json'), 'utf8');
    // Exact bytes: 2-space indent + trailing newline.
    assert.equal(
      raw,
      JSON.stringify({ mcpServers: { whatbroke: EXPECTED_ENTRY } }, null, 2) + '\n',
    );
    assert.deepEqual(JSON.parse(raw), { mcpServers: { whatbroke: EXPECTED_ENTRY } });

    const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes(CLAUDE_MD_MARKER));
    for (const tool of ['get_suspects', 'verify_fix', 'list_bundles', 'get_history']) {
      assert.ok(md.includes(tool), `CLAUDE.md snippet should mention ${tool}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('existing .mcp.json: whatbroke added, other servers and top-level keys preserved', async () => {
  const dir = await tmpDir();
  try {
    const existing = {
      mcpServers: {
        other: { command: 'other-server', args: ['--flag'], env: { KEY: 'value' } },
      },
      unrelatedTopLevel: { keep: true, n: 42 },
    };
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify(existing, null, 2) + '\n',
      'utf8',
    );

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);

    const parsed = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
      unrelatedTopLevel: unknown;
    };
    assert.deepEqual(parsed, {
      mcpServers: {
        other: { command: 'other-server', args: ['--flag'], env: { KEY: 'value' } },
        whatbroke: EXPECTED_ENTRY,
      },
      unrelatedTopLevel: { keep: true, n: 42 },
    });
    // The pre-existing server entry survived untouched.
    assert.deepEqual(parsed.mcpServers['other'], existing.mcpServers.other);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('idempotency: running twice yields byte-identical config and a single CLAUDE.md marker', async () => {
  const dir = await tmpDir();
  try {
    assert.equal(await initCmd(argsFor(dir, true)), 0);
    const configAfterFirst = await fs.readFile(path.join(dir, '.mcp.json'), 'utf8');
    const mdAfterFirst = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');

    assert.equal(await initCmd(argsFor(dir, true)), 0);
    const configAfterSecond = await fs.readFile(path.join(dir, '.mcp.json'), 'utf8');
    const mdAfterSecond = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');

    assert.equal(configAfterSecond, configAfterFirst);
    assert.equal(mdAfterSecond, mdAfterFirst);

    const servers = (JSON.parse(configAfterSecond) as { mcpServers: Record<string, unknown> })
      .mcpServers;
    assert.deepEqual(Object.keys(servers), [MCP_SERVER_KEY]);
    assert.equal(countOccurrences(mdAfterSecond, CLAUDE_MD_MARKER), 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('corrupt .mcp.json: exit 1, file bytes untouched, no CLAUDE.md written', async () => {
  const dir = await tmpDir();
  try {
    const corrupt = '{ this is not json\n';
    await fs.writeFile(path.join(dir, '.mcp.json'), corrupt, 'utf8');

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 1);
    assert.equal(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), corrupt);
    await assert.rejects(fs.access(path.join(dir, 'CLAUDE.md')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dry run (yes: false): exit 0 and no files created or modified', async () => {
  const dir = await tmpDir();
  try {
    const code = await initCmd(argsFor(dir, false));
    assert.equal(code, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('.vscode/mcp.json variant: entry written under `servers`, no .mcp.json created', async () => {
  const dir = await tmpDir();
  try {
    await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { other: { command: 'x' } }, inputs: [] }, null, 2) + '\n',
      'utf8',
    );

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);

    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, '.vscode', 'mcp.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      servers: { other: { command: 'x' }, whatbroke: EXPECTED_ENTRY },
      inputs: [],
    });
    await assert.rejects(fs.access(path.join(dir, '.mcp.json')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('.cursor/mcp.json variant: entry written under `mcpServers` in that file', async () => {
  const dir = await tmpDir();
  try {
    await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(dir, '.cursor', 'mcp.json'), '{}\n', 'utf8');

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);

    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, '.cursor', 'mcp.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed, { mcpServers: { whatbroke: EXPECTED_ENTRY } });
    await assert.rejects(fs.access(path.join(dir, '.mcp.json')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('.claude/ presence targets .mcp.json and leaves .claude/settings.json untouched', async () => {
  const dir = await tmpDir();
  try {
    const settings = JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2) + '\n';
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'settings.json'), settings, 'utf8');

    const target = await resolveInitTarget(dir);
    assert.equal(target.file, path.join(dir, '.mcp.json'));
    assert.equal(target.topKey, 'mcpServers');

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')), {
      mcpServers: { whatbroke: EXPECTED_ENTRY },
    });
    assert.equal(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'), settings);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('existing CLAUDE.md without marker gets the snippet appended, content preserved', async () => {
  const dir = await tmpDir();
  try {
    const original = '# My project\n\nSome instructions.\n';
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), original, 'utf8');

    const code = await initCmd(argsFor(dir, true));
    assert.equal(code, 0);

    const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.startsWith(original));
    assert.equal(countOccurrences(md, CLAUDE_MD_MARKER), 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── smokeTestMcp ────────────────────────────────────────────────────────────

test('smokeTestMcp: server that answers with a JSON-RPC line → ok: true', async () => {
  const dir = await tmpDir();
  try {
    const res = await smokeTestMcp(RESPONDER_ARGV, dir, 5000);
    assert.equal(res.ok, true, res.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('smokeTestMcp: argv that exits immediately → ok: false', async () => {
  const dir = await tmpDir();
  try {
    const res = await smokeTestMcp([process.execPath, '-e', 'process.exit(3)'], dir, 5000);
    assert.equal(res.ok, false);
    assert.match(res.message, /exited/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('smokeTestMcp: silently hanging argv times out fast', async () => {
  const dir = await tmpDir();
  try {
    const started = Date.now();
    const res = await smokeTestMcp(
      [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      dir,
      300,
    );
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.match(res.message, /within 300ms/);
    assert.ok(elapsed < 3000, `should resolve near the 300ms timeout, took ${elapsed}ms`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('smokeTestMcp: nonexistent command → ok: false spawn error', async () => {
  const dir = await tmpDir();
  try {
    const res = await smokeTestMcp(['definitely-not-a-command-xyz'], dir, 2000);
    assert.equal(res.ok, false);
    assert.ok(res.message.length > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('mcpServerEntry matches the documented registration value', () => {
  assert.deepEqual(mcpServerEntry(), EXPECTED_ENTRY);
});

test('resolveInitTarget defaults to .mcp.json when no agent config exists', async () => {
  const dir = await tmpDir();
  try {
    const target = await resolveInitTarget(dir);
    assert.equal(target.file, path.join(dir, '.mcp.json'));
    assert.equal(target.topKey, 'mcpServers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
