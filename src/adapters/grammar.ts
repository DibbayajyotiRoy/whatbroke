/**
 * Declarative stack-trace grammar engine.
 *
 * A `StackGrammar` is pure data: a handful of regexes describing how one
 * ecosystem prints an error and its stack frames. The engine here turns that
 * data into a parsed `ErrorInfo` — so adding a language is a ~40-line config,
 * not new parsing code. The battle-tested Node/V8 parser stays imperative (see
 * `capture/stack.ts`); this engine serves Python, Go, and the long tail.
 *
 * Frame ordering convention: the produced `StackFrame[]` is most-recent-first
 * (V8 convention), regardless of how the source language prints it, so the
 * suspect ranker and renderer treat every language uniformly.
 */
import type { CrashKind, ErrorInfo, StackFrame } from '../types.js';

export interface StackGrammar {
  id: string;

  /** Auto-detection signals; all optional, OR-combined into a score. */
  detect: {
    /** Matched against the joined argv, e.g. /\bpython3?\b/. */
    commands?: RegExp[];
    /** Source extensions whose presence in cwd bumps the score, e.g. ['.py']. */
    extensions?: string[];
    /** Manifest/lock files in cwd, e.g. ['requirements.txt', 'go.mod']. */
    cwdFiles?: string[];
    /** Strongest signal: markers in stderr, e.g. /^Traceback/m, /^panic:/m. */
    stderrMarkers?: RegExp[];
  };

  error: {
    /**
     * Locates the error header. Named groups `name` and `message` are extracted
     * when present. Set `headerAfterFrames` when the header trails the frames
     * (Python). For top-of-block headers (Go `panic:`), leave it false.
     */
    header: RegExp;
    headerAfterFrames?: boolean;
    /**
     * Splits chained traces (Python "During handling of the above exception…").
     * The engine keeps the LAST segment — the exception that actually propagated.
     */
    chainSeparator?: RegExp;
  };

  frame: {
    /**
     * Matches ONE frame line. Named groups (all optional): `func`, `file`,
     * `line`, `col`. Non-matching lines are skipped.
     */
    line: RegExp;
    /**
     * For two-line frames (Go: a function line, then a tab-indented location),
     * this matches the preceding line carrying the function name. Optional.
     */
    funcLine?: RegExp;
    /** Order frames appear in raw text. Output is always normalized to top-first. */
    order: 'top-first' | 'bottom-first';
  };

  /** A frame is library/non-user code if its file matches ANY of these. */
  userCode: { vendorPatterns: RegExp[] };

  /** Map stderr content onto a specific CrashKind (e.g. Go `fatal error:`). */
  crashKinds?: { pattern: RegExp; kind: CrashKind }[];
}

interface RawFrame {
  functionName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

function toNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function frameFromMatch(
  groups: Record<string, string> | undefined,
  funcName: string | null,
): RawFrame {
  const g = groups ?? {};
  const file = g['file'] && g['file'].length > 0 ? g['file'] : null;
  const func = funcName ?? (g['func'] && g['func'].length > 0 ? g['func'] : null);
  return {
    functionName: func === '<anonymous>' ? null : func,
    file,
    line: toNum(g['line']),
    column: toNum(g['col']),
  };
}

function isVendor(file: string | null, patterns: RegExp[]): boolean {
  if (!file) return false;
  return patterns.some((p) => p.test(file));
}

/**
 * Collect every frame line in `lines`, returning the raw frames plus the
 * [start, end) line range they span. Non-frame lines interleaved with frames
 * (Python's source-echo lines, Go's function lines, blank lines) are tolerated —
 * frames need not be strictly contiguous. The frame regexes are specific enough
 * (`File "...", line N` / a tab-indented `*.go:N`) that stray log lines don't
 * match. Returns null if no frames are found.
 */
function collectFrameBlock(
  lines: string[],
  grammar: StackGrammar,
): { frames: RawFrame[]; start: number; end: number } | null {
  const { line, funcLine } = grammar.frame;
  let start = -1;
  let end = -1;
  const frames: RawFrame[] = [];
  let pendingFunc: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';

    const m = line.exec(raw);
    if (m) {
      if (start === -1) start = i;
      frames.push(frameFromMatch(m.groups, pendingFunc));
      pendingFunc = null;
      end = i + 1;
      continue;
    }

    // Two-line frames (Go): a function line precedes its tab-indented location.
    if (funcLine) {
      const fm = funcLine.exec(raw);
      if (fm) {
        pendingFunc = fm.groups?.['func'] ?? null;
      }
    }
  }

  if (start === -1 || frames.length === 0) return null;
  return { frames, start, end };
}

/** Parse a single (already chain-split) segment into an ErrorInfo, or null. */
function parseSegment(segment: string, grammar: StackGrammar): ErrorInfo | null {
  const lines = segment.split('\n');
  const block = collectFrameBlock(lines, grammar);
  if (!block) return null;

  // Find the header relative to the frame block.
  let headerName = grammar.id;
  let headerMessage = '';
  let headerIdx = -1;

  if (grammar.error.headerAfterFrames) {
    // The header trails the frames (Python). Scan forward for the first line
    // matching the header regex, skipping the indented source-echo lines that
    // sit between/after frames. Bounded to a few lines past the block to avoid
    // latching onto an unrelated later line.
    const limit = Math.min(lines.length, block.end + 8);
    for (let i = block.end; i < limit; i++) {
      const t = (lines[i] ?? '').trim();
      if (t.length === 0) continue;
      const hm = grammar.error.header.exec(t);
      if (hm) {
        headerName = hm.groups?.['name'] ?? grammar.id;
        headerMessage = (hm.groups?.['message'] ?? '').trim();
        headerIdx = i;
        break;
      }
    }
  } else {
    // Last header line at or before the frame block start.
    for (let i = block.start; i >= 0; i--) {
      const t = (lines[i] ?? '').trim();
      const hm = grammar.error.header.exec(t);
      if (hm) {
        headerName = hm.groups?.['name'] ?? grammar.id;
        headerMessage = (hm.groups?.['message'] ?? '').trim();
        headerIdx = i;
        break;
      }
    }
  }

  // Normalize to top-first (most recent frame first).
  const ordered =
    grammar.frame.order === 'bottom-first'
      ? [...block.frames].reverse()
      : block.frames;

  const stack: StackFrame[] = ordered.map((f) => ({
    functionName: f.functionName,
    file: f.file,
    fileRelative: null,
    line: f.line,
    column: f.column,
    isUserCode: !isVendor(f.file, grammar.userCode.vendorPatterns),
    isInRepo: false,
    sourceMapped: false,
  }));

  // rawStack: the verbatim block spanning header + frames.
  const lo = headerIdx === -1 ? block.start : Math.min(headerIdx, block.start);
  const hi = headerIdx === -1 ? block.end : Math.max(headerIdx + 1, block.end);
  const rawStack = lines.slice(lo, hi).join('\n');

  return { name: headerName, message: headerMessage, stack, rawStack };
}

/** Parse an ErrorInfo out of stderr using a declarative grammar, or null. */
export function parseWithGrammar(
  stderr: string,
  grammar: StackGrammar,
): ErrorInfo | null {
  const sep = grammar.error.chainSeparator;
  if (sep) {
    // Keep the LAST segment that yields a parseable error (the exception that
    // actually propagated out of a chained traceback).
    const segments = stderr.split(sep);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg === undefined) continue;
      const parsed = parseSegment(seg, grammar);
      if (parsed) return parsed;
    }
    return null;
  }
  return parseSegment(stderr, grammar);
}

/** Score a grammar's detection signals against a detection context. */
export function scoreGrammar(
  grammar: StackGrammar,
  ctx: {
    argv: string;
    cwdEntries: string[];
    fileExtensions: Set<string>;
    stderrText: string;
  },
): number {
  const d = grammar.detect;
  let s = 0;
  if (d.commands?.some((re) => re.test(ctx.argv))) s += 0.5;
  if (d.cwdFiles?.some((f) => ctx.cwdEntries.includes(f))) s += 0.3;
  if (d.extensions?.some((e) => ctx.fileExtensions.has(e))) s += 0.2;
  if (d.stderrMarkers?.some((re) => re.test(ctx.stderrText))) s += 0.6;
  return Math.min(s, 1);
}
