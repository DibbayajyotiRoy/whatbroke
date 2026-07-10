/**
 * whatbroke's own chatter. Always goes to stderr so it never pollutes the child's
 * stdout (which must stream through unchanged on the happy path, 03/07).
 *
 * Color is gated on an interactive TTY AND the absence of NO_COLOR, so output
 * degrades to clean plain text in pipes, CI, and for users who disable color.
 */
export type Verbosity = 'quiet' | 'normal' | 'verbose';

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export function colorEnabled(): boolean {
  return process.stderr.isTTY === true && !process.env['NO_COLOR'];
}

export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

export function makeStyle(enabled: boolean = colorEnabled()): Style {
  const w = (s: string, c: string) => (enabled ? `${c}${s}${CODES.reset}` : s);
  return {
    enabled,
    bold: (s) => w(s, CODES.bold),
    dim: (s) => w(s, CODES.dim),
    red: (s) => w(s, CODES.red),
    green: (s) => w(s, CODES.green),
    yellow: (s) => w(s, CODES.yellow),
    cyan: (s) => w(s, CODES.cyan),
    gray: (s) => w(s, CODES.gray),
  };
}

export function makeLogger(verbosity: Verbosity, opts?: { color?: boolean }) {
  const style = makeStyle(opts?.color ?? colorEnabled());
  return {
    style,
    /** Print a pre-styled line verbatim (caller owns styling). */
    line(msg = ''): void {
      if (verbosity !== 'quiet') process.stderr.write(`${msg}\n`);
    },
    dim(msg: string): void {
      if (verbosity !== 'quiet') process.stderr.write(`${style.dim(msg)}\n`);
    },
    info(msg: string): void {
      if (verbosity !== 'quiet') process.stderr.write(`${msg}\n`);
    },
    warn(msg: string): void {
      process.stderr.write(`${style.yellow(msg)}\n`);
    },
    error(msg: string): void {
      process.stderr.write(`${style.red(msg)}\n`);
    },
    verbose(msg: string): void {
      if (verbosity === 'verbose') process.stderr.write(`${style.dim(msg)}\n`);
    },
  };
}

export type Logger = ReturnType<typeof makeLogger>;
