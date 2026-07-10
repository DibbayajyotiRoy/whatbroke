/**
 * `whatbroke doctor` — a concise, copy-pasteable diagnostics report for filing a
 * bug against whatbroke ITSELF. It answers "what's my environment + what has
 * whatbroke been doing" so a user can explain a bug in one paste, without us
 * having to ask a dozen follow-up questions.
 *
 * Output goes to stdout (it's meant to be copied); it is read-only and never
 * throws — a broken environment is exactly when you need this to work.
 */
import * as path from 'node:path';
import { collectEnv } from '../collectors/env.js';
import { openJournal } from '../journal/journal.js';
import { BundleStore } from '../mcp/store.js';
import { resolveStorePaths } from '../paths.js';
import { gitHeadAndBranch, getGitRoot } from '../assemble.js';
import { TOOL_VERSION, ISSUES_URL } from '../version.js';
import { makeStyle } from '../util/log.js';
import {
  findMcpRegistration,
  smokeTestMcp,
  DEFAULT_SMOKE_ARGV,
  MCP_SERVER_KEY,
} from './init.js';

export interface DoctorArgs {
  cwd: string;
  out?: string;
  /** Override the argv used for the MCP boot check (tests inject a stub). */
  smokeArgv?: string[];
  /** Override the MCP boot-check timeout in ms (default 5000). */
  smokeTimeoutMs?: number;
}

export async function doctorCmd(args: DoctorArgs): Promise<number> {
  const s = makeStyle(process.stdout.isTTY === true && !process.env['NO_COLOR']);
  const out: string[] = [];
  const row = (k: string, v: string) => out.push(`  ${s.dim(k.padEnd(10))} ${v}`);

  out.push(s.bold('whatbroke doctor'));
  out.push('');
  row('whatbroke', TOOL_VERSION);
  row('node', process.versions.node);
  row('os', `${process.platform} ${process.arch}`);

  // Best-effort environment + repo state. Each guarded; doctor must never throw.
  try {
    const env = await collectEnv(args.cwd);
    const pm = env.packageManager;
    row('pm', pm.name === 'unknown' ? 'unknown' : `${pm.name}${pm.version ? ` (${pm.version})` : ''}`);
  } catch {
    row('pm', 'unknown');
  }

  try {
    const root = await getGitRoot(args.cwd);
    if (root) {
      const { head, branch } = await gitHeadAndBranch(args.cwd);
      row('git', `${branch ?? 'DETACHED'} @ ${head ? head.slice(0, 7) : '?'}`);
    } else {
      row('git', 'not a git repository');
    }
  } catch {
    row('git', 'unknown');
  }

  const store = resolveStorePaths(args.cwd, args.out);

  try {
    const journal = await openJournal(store.journal);
    row('journal', `${journal.list().length} green entries`);
  } catch {
    row('journal', 'unreadable');
  }

  // Bundle count + latest, and any recent self-diagnostics (collectorErrors).
  try {
    const bundles = new BundleStore(store.bundlesDir);
    const list = await bundles.list(1);
    if (list.length === 0) {
      row('bundles', '0');
    } else {
      const latest = list[0]!;
      row('bundles', `latest ${latest.id} (${latest.confidence})`);
      const full = await bundles.get(latest.id);
      const errs = full?.collectorErrors ?? [];
      if (errs.length > 0) {
        out.push('');
        out.push(`  ${s.yellow('recent whatbroke warnings:')}`);
        for (const e of errs.slice(0, 5)) out.push(`    - ${e.collector}: ${e.error}`);
      }
    }
  } catch {
    row('bundles', 'unreadable');
  }

  // Agent-registration health (roadmap 6.1): is whatbroke registered in a
  // project MCP config, and does the server actually boot? The boot check is
  // best-effort — a missing npx or a timeout is a warning, never a failure.
  try {
    const reg = await findMcpRegistration(args.cwd);
    row(
      'mcp reg',
      reg
        ? `${path.relative(args.cwd, reg.file) || reg.file} (${reg.topKey}.${MCP_SERVER_KEY})`
        : 'not registered — run `whatbroke init`',
    );
  } catch {
    row('mcp reg', 'unknown');
  }

  try {
    const smoke = await smokeTestMcp(
      args.smokeArgv ?? DEFAULT_SMOKE_ARGV,
      args.cwd,
      args.smokeTimeoutMs ?? 5000,
    );
    row('mcp start', smoke.ok ? `ok (${smoke.message})` : s.yellow(`warn: ${smoke.message}`));
  } catch {
    row('mcp start', 'unknown');
  }

  out.push('');
  out.push(`Found a bug in whatbroke? Open an issue with the block above:`);
  out.push(`  ${s.cyan(ISSUES_URL)}`);
  out.push(
    s.dim('  Re-run the failing command with WHATBROKE_DEBUG=1 to include a stack trace.'),
  );

  process.stdout.write(out.join('\n') + '\n');
  return 0;
}
