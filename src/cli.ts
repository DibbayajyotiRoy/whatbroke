#!/usr/bin/env node
/**
 * whatbroke CLI entry (07). Hand-rolled arg parsing (no framework dep) with the
 * one subtlety that `run` takes a verbatim child command after `--`.
 */
import { runCmd, type RunArgs } from './commands/run.js';
import { showCmd } from './commands/show.js';
import { openCmd } from './commands/open.js';
import { journalCmd } from './commands/journal.js';
import { mcpCmd } from './commands/mcp.js';
import { doctorCmd } from './commands/doctor.js';
import { TOOL_VERSION, ISSUES_URL } from './version.js';
import { isDebug, errorDetail } from './util/debug.js';
import type { Verbosity } from './util/log.js';

const HELP = `whatbroke ${TOOL_VERSION} — terminal-side capture layer for local Node crashes

Usage:
  whatbroke run [flags] -- <command> [args...]   Wrap a command; bundle on crash
  whatbroke mcp [--out <dir>]                     Read-only MCP server for this project
  whatbroke show [<id|path>] [--out <dir>]        Re-render a saved bundle as Markdown
  whatbroke open [<id|path>] --github [owner/repo] Send a saved bundle to a sink
  whatbroke journal [--list|--clear]              Inspect/clear the green-commit journal
  whatbroke doctor                                Print diagnostics to report a bug in whatbroke
  whatbroke --version | --help

run flags:
  --out <dir>        Bundle output dir (default ./.whatbroke/bundles)
  --no-file          Do not write bundle files
  --md               Also print rendered Markdown to stdout
  --github [repo]    Open a prefilled GitHub issue (infers repo if omitted)
  --timeout <ms>     Kill + treat as crash if the child hangs
  --log-lines <n>    Ring-buffer size per stream
  --explain          Enable optional LLM narration (requires a configured provider)
  --quiet | --verbose
`;

function verbosityFrom(flags: Set<string>): Verbosity {
  if (flags.has('--quiet')) return 'quiet';
  if (flags.has('--verbose')) return 'verbose';
  return 'normal';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }

  const cwd = process.cwd();

  switch (cmd) {
    case 'run':
      return runCmd(parseRunArgs(rest, cwd));
    case 'mcp': {
      const out = takeValue(rest, '--out');
      const margs: { cwd: string; out?: string } = { cwd };
      if (out) margs.out = out;
      return mcpCmd(margs);
    }
    case 'show': {
      const out = takeValue(rest, '--out');
      const ref = rest.find((a) => !a.startsWith('-'));
      const sargs: {
        cwd: string;
        verbosity: Verbosity;
        ref?: string;
        out?: string;
      } = { cwd, verbosity: verbosityFrom(new Set(rest)) };
      if (ref) sargs.ref = ref;
      if (out) sargs.out = out;
      return showCmd(sargs);
    }
    case 'open': {
      const out = takeValue(rest, '--out');
      const ref = rest.find((a) => !a.startsWith('-'));
      const github = parseGithub(rest);
      const oargs: {
        cwd: string;
        verbosity: Verbosity;
        ref?: string;
        out?: string;
        github?: { repo?: string };
      } = { cwd, verbosity: verbosityFrom(new Set(rest)) };
      if (ref) oargs.ref = ref;
      if (out) oargs.out = out;
      if (github) oargs.github = github;
      return openCmd(oargs);
    }
    case 'journal': {
      const action = rest.includes('--clear') ? 'clear' : 'list';
      return journalCmd({ cwd, action, verbosity: verbosityFrom(new Set(rest)) });
    }
    case 'doctor': {
      const out = takeValue(rest, '--out');
      const dargs: { cwd: string; out?: string } = { cwd };
      if (out) dargs.out = out;
      return doctorCmd(dargs);
    }
    default:
      process.stderr.write(`whatbroke: unknown command '${cmd}'. Try 'whatbroke --help'.\n`);
      return 64;
  }
}

/** Find `--flag value` and return the value, or undefined. */
function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('-') ? v : undefined;
}

/** `--github` is a flag with an OPTIONAL repo value. */
function parseGithub(args: string[]): { repo?: string } | undefined {
  const i = args.indexOf('--github');
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('-') ? { repo: v } : {};
}

function parseRunArgs(rest: string[], cwd: string): RunArgs {
  const sep = rest.indexOf('--');
  const flags = sep === -1 ? rest : rest.slice(0, sep);
  const targetArgv = sep === -1 ? [] : rest.slice(sep + 1);

  const flagSet = new Set(flags);
  const out = takeValue(flags, '--out');
  const logLinesRaw = takeValue(flags, '--log-lines');
  const timeoutRaw = takeValue(flags, '--timeout');
  const github = parseGithub(flags);

  const args: RunArgs = {
    targetArgv,
    cwd,
    verbosity: verbosityFrom(flagSet),
  };
  if (out) args.out = out;
  if (flagSet.has('--no-file')) args.noFile = true;
  if (flagSet.has('--md')) args.md = true;
  if (github) args.github = github;
  if (flagSet.has('--explain')) args.explain = true;
  if (logLinesRaw && Number.isFinite(Number(logLinesRaw))) {
    args.logLines = Number(logLinesRaw);
  }
  if (timeoutRaw && Number.isFinite(Number(timeoutRaw))) {
    args.timeoutMs = Number(timeoutRaw);
  }
  return args;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // An unexpected internal error here is a bug in whatbroke itself. Tell the
    // user plainly, show the stack under WHATBROKE_DEBUG, and point them at the
    // easy report path. Stacks are whatbroke's own, not the child's — no leak.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✕ whatbroke hit an internal error (this is a bug in whatbroke): ${msg}\n`);
    if (isDebug()) {
      process.stderr.write(`${errorDetail(err)}\n`);
    } else {
      process.stderr.write(`  Re-run with WHATBROKE_DEBUG=1 for a full stack trace.\n`);
    }
    process.stderr.write(`  Please report it: run \`whatbroke doctor\` and open an issue at ${ISSUES_URL}\n`);
    process.exitCode = 1;
  });
