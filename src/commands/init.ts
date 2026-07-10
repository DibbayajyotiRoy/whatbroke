/**
 * `whatbroke init` — one-command agent registration (roadmap 6.1, T1.4).
 *
 * Detects which MCP config convention the project already uses (generic
 * `.mcp.json`, Claude Code, Cursor, VS Code), prints the exact server entry,
 * and with `--yes` merges it in non-destructively, drops a CLAUDE.md snippet
 * documenting the crash-fix loop, and smoke-starts the MCP server to prove it
 * boots.
 *
 * The default is a dry run: print what would be written, write nothing.
 * `--yes` applies. There is deliberately no interactive prompt — whatbroke has
 * no TTY-prompt dependency and `init` stays scriptable.
 *
 * Claude Code note: project-scoped MCP servers live in `.mcp.json` at the repo
 * root, NOT in `.claude/settings.json`. A `.claude/` directory is therefore
 * only a signal that the project uses Claude Code; we still write `.mcp.json`.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface InitArgs {
  cwd: string;
  /** Apply changes. Without it, init is a dry run that only prints. */
  yes: boolean;
  verbosity: Verbosity;
  /** Override the argv used to smoke-test the server (tests inject a stub). */
  smokeArgv?: string[];
  /** Override the smoke-test timeout in ms (default 5000). */
  smokeTimeoutMs?: number;
}

/** Key under which whatbroke registers itself in the servers map. */
export const MCP_SERVER_KEY = 'whatbroke';

/** Marker that keeps the CLAUDE.md snippet idempotent. */
export const CLAUDE_MD_MARKER = '<!-- whatbroke-loop -->';

/** Default argv used to smoke-test the server after registration. */
export const DEFAULT_SMOKE_ARGV = ['npx', '-y', '@whatbroke/whatbroke', 'mcp'];

/** The registration value — identical across all supported config formats. */
export function mcpServerEntry(): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', '@whatbroke/whatbroke', 'mcp'] };
}

/** Where the registration goes and under which top-level key. */
export interface InitTarget {
  /** Absolute path of the config file the entry is merged into. */
  file: string;
  /** `mcpServers` everywhere except `.vscode/mcp.json`, which uses `servers`. */
  topKey: 'mcpServers' | 'servers';
  /** Human-readable reason for the choice (shown in output). */
  reason: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pick the config file to write, in priority order:
 * `.mcp.json` → `.claude/` (signal only → still `.mcp.json`) →
 * `.cursor/mcp.json` → `.vscode/mcp.json` → default `.mcp.json`.
 */
export async function resolveInitTarget(cwd: string): Promise<InitTarget> {
  const mcpJson = path.join(cwd, '.mcp.json');
  if (await pathExists(mcpJson)) {
    return { file: mcpJson, topKey: 'mcpServers', reason: 'existing .mcp.json' };
  }
  if (await pathExists(path.join(cwd, '.claude'))) {
    return {
      file: mcpJson,
      topKey: 'mcpServers',
      reason: 'Claude Code project (.claude/ present) — project MCP servers live in .mcp.json',
    };
  }
  const cursor = path.join(cwd, '.cursor', 'mcp.json');
  if (await pathExists(cursor)) {
    return { file: cursor, topKey: 'mcpServers', reason: 'existing .cursor/mcp.json' };
  }
  const vscode = path.join(cwd, '.vscode', 'mcp.json');
  if (await pathExists(vscode)) {
    return { file: vscode, topKey: 'servers', reason: 'existing .vscode/mcp.json' };
  }
  return {
    file: mcpJson,
    topKey: 'mcpServers',
    reason: 'no agent config found — defaulting to .mcp.json (Claude Code convention)',
  };
}

/** An existing whatbroke registration, if any config file contains one. */
export interface McpRegistration {
  file: string;
  topKey: 'mcpServers' | 'servers';
}

/**
 * Scan the known config locations for an existing `whatbroke` server entry.
 * Missing or corrupt files are skipped, never thrown (doctor relies on that).
 */
export async function findMcpRegistration(cwd: string): Promise<McpRegistration | null> {
  const candidates: McpRegistration[] = [
    { file: path.join(cwd, '.mcp.json'), topKey: 'mcpServers' },
    { file: path.join(cwd, '.claude', 'settings.json'), topKey: 'mcpServers' },
    { file: path.join(cwd, '.cursor', 'mcp.json'), topKey: 'mcpServers' },
    { file: path.join(cwd, '.vscode', 'mcp.json'), topKey: 'servers' },
  ];
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(c.file, 'utf8'));
      if (!isRecord(parsed)) continue;
      const servers = parsed[c.topKey];
      if (isRecord(servers) && isRecord(servers[MCP_SERVER_KEY])) return c;
    } catch {
      /* missing or corrupt file → no registration here */
    }
  }
  return null;
}

/**
 * Merge `<topKey>.whatbroke` into the target file, preserving every other key.
 * Output is 2-space-indented JSON with a trailing newline. Corrupt existing
 * JSON is never clobbered: nothing is written and an error is returned.
 */
async function mergeRegistrationInto(
  target: InitTarget,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(target.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: `cannot read ${target.file}: ${errMessage(err)}` };
    }
  }

  let root: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error:
          `${target.file} is not valid JSON (${errMessage(err)}). ` +
          `Fix or remove it and re-run \`whatbroke init --yes\` — refusing to overwrite.`,
      };
    }
    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: `${target.file} does not contain a JSON object at the top level — refusing to overwrite.`,
      };
    }
    root = parsed;
  }

  const existing = root[target.topKey];
  if (existing !== undefined && !isRecord(existing)) {
    return {
      ok: false,
      error: `"${target.topKey}" in ${target.file} is not an object — refusing to overwrite.`,
    };
  }
  const servers: Record<string, unknown> = isRecord(existing) ? existing : {};
  servers[MCP_SERVER_KEY] = mcpServerEntry();
  root[target.topKey] = servers;

  await fs.mkdir(path.dirname(target.file), { recursive: true });
  await fs.writeFile(target.file, JSON.stringify(root, null, 2) + '\n', 'utf8');
  return { ok: true };
}

/** The CLAUDE.md section documenting the agent loop (roadmap 6.1 AC2). */
export function claudeMdSnippet(): string {
  return [
    CLAUDE_MD_MARKER,
    '',
    '## whatbroke — crash-fix loop',
    '',
    'When a command crashes: call get_suspects, read the top suspect + diff, edit, then',
    'call verify_fix; repeat until fixed. Use list_bundles to browse recent crash bundles',
    'and get_history to see how the same crash was fixed before.',
    '',
  ].join('\n');
}

/**
 * Create CLAUDE.md with the loop snippet, or append it to an existing one.
 * Idempotent via CLAUDE_MD_MARKER — a file that already has the marker is
 * left untouched.
 */
export async function ensureClaudeMdSnippet(
  cwd: string,
): Promise<'created' | 'appended' | 'unchanged'> {
  const file = path.join(cwd, 'CLAUDE.md');
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing === null) {
    await fs.writeFile(file, claudeMdSnippet(), 'utf8');
    return 'created';
  }
  if (existing.includes(CLAUDE_MD_MARKER)) return 'unchanged';
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  await fs.writeFile(file, existing + sep + claudeMdSnippet(), 'utf8');
  return 'appended';
}

export interface SmokeTestResult {
  ok: boolean;
  message: string;
}

/**
 * Boot-check an MCP server: spawn `spawnArgv`, send an `initialize` JSON-RPC
 * request over stdin, and wait for any JSON-RPC message line on stdout.
 *
 * Framing: the MCP stdio transport is newline-delimited JSON — one JSON object
 * per `\n`-terminated line (see @modelcontextprotocol/sdk `shared/stdio.ts`:
 * `serializeMessage` is `JSON.stringify(message) + '\n'`). It is NOT
 * LSP-style Content-Length framing.
 *
 * Never rejects and never hangs: resolves `{ ok: false }` on spawn failure,
 * early exit, or timeout, and always kills the child before resolving.
 */
export function smokeTestMcp(
  spawnArgv: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const [cmd, ...argv] = spawnArgv;
    if (cmd === undefined) {
      resolve({ ok: false, message: 'smoke test: empty argv' });
      return;
    }

    let child: ChildProcessWithoutNullStreams | null = null;
    let spawnErr: unknown;
    try {
      child = spawn(cmd, argv, { cwd });
    } catch (err) {
      spawnErr = err;
    }
    if (child === null) {
      resolve({ ok: false, message: `spawn failed: ${errMessage(spawnErr)}` });
      return;
    }
    const proc = child;

    const started = Date.now();
    let settled = false;
    let stdoutBuf = '';
    let stderrTail = '';
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: SmokeTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      settle({ ok: false, message: `no JSON-RPC response within ${timeoutMs}ms` });
    }, timeoutMs);

    proc.on('error', (err) => settle({ ok: false, message: `spawn failed: ${err.message}` }));
    proc.on('exit', (code, signal) => {
      const why = signal !== null ? `signal ${signal}` : `code ${code}`;
      const tail = stderrTail.trim();
      settle({
        ok: false,
        message: `server exited (${why}) before responding${tail ? `: ${tail.slice(0, 200)}` : ''}`,
      });
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400);
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '').trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line !== '') {
          try {
            const msg: unknown = JSON.parse(line);
            if (isRecord(msg) && msg['jsonrpc'] === '2.0') {
              settle({ ok: true, message: `responded in ${Date.now() - started}ms` });
              return;
            }
          } catch {
            /* non-JSON noise on stdout — keep waiting for a real message */
          }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'whatbroke-init', version: '0.0.0' },
      },
    };
    proc.stdin.on('error', () => {
      /* EPIPE when the child dies first — reported via the exit handler */
    });
    proc.stdin.write(JSON.stringify(initialize) + '\n');
  });
}

export async function initCmd(args: InitArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const s = log.style;

  const target = await resolveInitTarget(args.cwd);
  const rel = path.relative(args.cwd, target.file) || target.file;
  const preview = JSON.stringify(
    { [target.topKey]: { [MCP_SERVER_KEY]: mcpServerEntry() } },
    null,
    2,
  );
  const smokeArgv = args.smokeArgv ?? DEFAULT_SMOKE_ARGV;

  if (!args.yes) {
    log.info(`whatbroke init — dry run; nothing written. Re-run with ${s.bold('--yes')} to apply.`);
    log.info('');
    log.info(`Detected: ${target.reason}`);
    log.info(`Would merge this entry into ${s.bold(rel)} (${target.file}):`);
    for (const line of preview.split('\n')) log.info(`  ${line}`);
    log.info('');
    log.info(`Would also add the whatbroke crash-fix loop to CLAUDE.md (marker ${CLAUDE_MD_MARKER})`);
    log.info(`and smoke-test the server with: ${smokeArgv.join(' ')}`);
    return 0;
  }

  const merged = await mergeRegistrationInto(target);
  if (!merged.ok) {
    log.error(`✕ ${merged.error}`);
    return 1;
  }
  log.info(`${s.green('✓')} registered the ${MCP_SERVER_KEY} MCP server in ${rel} (${target.reason})`);

  const claude = await ensureClaudeMdSnippet(args.cwd);
  if (claude === 'created') {
    log.info(`${s.green('✓')} created CLAUDE.md with the whatbroke crash-fix loop`);
  } else if (claude === 'appended') {
    log.info(`${s.green('✓')} appended the whatbroke crash-fix loop to CLAUDE.md`);
  } else {
    log.info(`${s.dim('•')} CLAUDE.md already contains the whatbroke section — left unchanged`);
  }

  log.verbose(`smoke-testing MCP server: ${smokeArgv.join(' ')}`);
  const smoke = await smokeTestMcp(smokeArgv, args.cwd, args.smokeTimeoutMs ?? 5000);
  if (smoke.ok) {
    log.info(`${s.green('✓')} MCP server starts (${smoke.message})`);
  } else {
    log.warn(`⚠ MCP server smoke test failed: ${smoke.message}`);
    log.warn(`  The registration was still written; try \`${DEFAULT_SMOKE_ARGV.join(' ')}\` manually.`);
  }
  return 0;
}
