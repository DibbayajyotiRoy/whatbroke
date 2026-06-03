import type { ErrorInfo, StackFrame } from '../types.js';

/**
 * Parse the Node.js stack-trace format into structured frames.
 *
 * Handles the common shapes emitted by V8:
 *   - `at fn (/abs/file.ts:12:34)`
 *   - `at /abs/file.ts:12:34`
 *   - `at async fn (/abs/file.ts:12:34)`
 *   - `at Object.<anonymous> (/abs/file.ts:1:1)`
 *   - `at node:internal/modules/cjs/loader:1234:5`
 *   - `at eval (eval at <anonymous> (/abs/file.ts:1:1), <anonymous>:1:1)`
 *   - `at <anonymous>`
 *
 * Location-less frames (e.g. native, or a bare `at <anonymous>`) get null
 * file/line/column. `isInRepo`, `fileRelative`, and `sourceMapped` are filled in
 * later by integration once the git root is known.
 */
export function parseStack(rawStack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = rawStack.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('at ')) {
      continue;
    }
    const frame = parseFrameLine(line);
    if (frame) {
      frames.push(frame);
    }
  }
  return frames;
}

function parseFrameLine(line: string): StackFrame | null {
  // Strip the leading "at " and an optional "async " marker.
  let rest = line.slice(3).trim();
  if (rest.startsWith('async ')) {
    rest = rest.slice('async '.length).trim();
  }

  let functionName: string | null = null;
  let locationText: string;

  // Form: `fn (location)` — function name followed by a parenthesised location.
  const parenIdx = rest.indexOf('(');
  if (parenIdx !== -1 && rest.endsWith(')')) {
    const name = rest.slice(0, parenIdx).trim();
    functionName = normalizeFunctionName(name);
    locationText = rest.slice(parenIdx + 1, -1).trim();
  } else {
    // Form: `location` only (no function name).
    functionName = null;
    locationText = rest;
  }

  const loc = parseLocation(locationText);

  const file = loc.file;
  const isUserCode =
    file !== null &&
    !file.includes('node_modules') &&
    !file.startsWith('node:');

  return {
    functionName,
    file,
    fileRelative: null,
    line: loc.line,
    column: loc.column,
    isUserCode,
    isInRepo: false,
    sourceMapped: false,
  };
}

function normalizeFunctionName(name: string): string | null {
  if (name.length === 0) {
    return null;
  }
  if (name === '<anonymous>') {
    return null;
  }
  return name;
}

interface Location {
  file: string | null;
  line: number | null;
  column: number | null;
}

function parseLocation(text: string): Location {
  if (text.length === 0 || text === '<anonymous>') {
    return { file: null, line: null, column: null };
  }

  // eval frames look like:
  //   eval at <anonymous> (/abs/file.ts:1:1), <anonymous>:1:1
  // V8 nests the real source location inside an inner paren group. Pull that out.
  if (text.startsWith('eval at ')) {
    const inner = extractInnerParen(text);
    if (inner !== null) {
      return parseLocation(inner);
    }
    return { file: null, line: null, column: null };
  }

  // Match a trailing `:line:column`. Use the LAST occurrence so Windows-style
  // `C:\...` or `node:internal/...:12:34` paths keep their leading colons.
  const m = /^(.*):(\d+):(\d+)$/.exec(text);
  if (m) {
    const file = m[1] ?? null;
    const lineStr = m[2];
    const colStr = m[3];
    return {
      file: file && file.length > 0 ? file : null,
      line: lineStr !== undefined ? Number.parseInt(lineStr, 10) : null,
      column: colStr !== undefined ? Number.parseInt(colStr, 10) : null,
    };
  }

  // Some frames carry only `:line` with no column.
  const m2 = /^(.*):(\d+)$/.exec(text);
  if (m2) {
    const file = m2[1] ?? null;
    const lineStr = m2[2];
    return {
      file: file && file.length > 0 ? file : null,
      line: lineStr !== undefined ? Number.parseInt(lineStr, 10) : null,
      column: null,
    };
  }

  // No numeric location: treat the whole thing as a file-ish token (e.g.
  // `node:internal/...` without a position, or `native`).
  if (text === 'native') {
    return { file: null, line: null, column: null };
  }
  return { file: text, line: null, column: null };
}

function extractInnerParen(text: string): string | null {
  const open = text.indexOf('(');
  if (open === -1) {
    return null;
  }
  // Find the matching close paren for the first open.
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, i).trim();
      }
    }
  }
  return null;
}

/**
 * Detect and parse a Node error / exception block out of raw stderr text.
 *
 * Recognises:
 *   - a `<Name>: <message>` header line followed by `    at ...` frames,
 *   - the uncaught-exception banner Node prints before the error,
 *   - `UnhandledPromiseRejection` warnings.
 *
 * Returns null if no error block is found. `rawStack` is the verbatim matched
 * block (pre-redaction).
 */
export function parseErrorBlock(stderr: string): ErrorInfo | null {
  const lines = stderr.split('\n');

  // First pass: find the index of a header line that begins an error block.
  // An error header is a line shaped like `ErrorName: message` (optionally a
  // bare `ErrorName`) that is immediately or shortly followed by `at` frames.
  const headerIdx = findErrorHeader(lines);
  if (headerIdx === -1) {
    return null;
  }

  const headerLine = (lines[headerIdx] ?? '').trim();
  const parsed = parseHeader(headerLine);
  if (!parsed) {
    return null;
  }

  // The message can span multiple lines until the first `at` frame line. Collect
  // continuation lines (those that are not stack frames and not blank-noise).
  const blockLines: string[] = [headerLine];
  const messageParts: string[] = [parsed.message];
  let i = headerIdx + 1;
  let seenFrame = false;

  for (; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('at ')) {
      seenFrame = true;
      blockLines.push(raw);
      continue;
    }
    if (seenFrame) {
      // Once frames have started, a non-frame line ends the block.
      break;
    }
    // Pre-frame continuation lines are part of a multi-line message, unless we
    // hit a blank line which we treat as the end of the message section.
    if (trimmed.length === 0) {
      break;
    }
    messageParts.push(trimmed);
    blockLines.push(raw);
  }

  const rawStack = blockLines.join('\n');
  const stack = parseStack(rawStack);
  const message = messageParts.join('\n').trim();

  return {
    name: parsed.name,
    message,
    stack,
    rawStack,
  };
}

interface ParsedHeader {
  name: string;
  message: string;
}

function parseHeader(line: string): ParsedHeader | null {
  // `Name: message`
  const colon = line.indexOf(':');
  if (colon !== -1) {
    const name = line.slice(0, colon).trim();
    const message = line.slice(colon + 1).trim();
    if (isErrorName(name)) {
      return { name, message };
    }
    return null;
  }
  // Bare error name with no message.
  if (isErrorName(line)) {
    return { name: line, message: '' };
  }
  return null;
}

/** A token that plausibly names a JS error class. */
function isErrorName(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  // Must be a single identifier-ish token (no spaces) ending in "Error", or one
  // of the known non-"Error" rejection/exception markers.
  if (/\s/.test(token)) {
    return false;
  }
  // A valid JS identifier (optionally namespaced like `assert.AssertionError`)
  // whose final segment ends in "Error".
  if (/^[\w$.]+$/.test(token)) {
    const segment = token.includes('.')
      ? (token.split('.').pop() ?? token)
      : token;
    if (/Error$/.test(segment)) {
      return true;
    }
  }
  return (
    token === 'UnhandledPromiseRejection' ||
    token === 'UnhandledPromiseRejectionWarning'
  );
}

function findErrorHeader(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseHeader(trimmed);
    if (!parsed) {
      continue;
    }
    // Confirm this header is followed (within a few lines, skipping a possible
    // multi-line message) by at least one stack frame. This avoids matching a
    // stray `Foo: bar` log line that merely looks like an error header.
    if (hasFollowingFrame(lines, i)) {
      return i;
    }
  }
  return -1;
}

function hasFollowingFrame(lines: string[], headerIdx: number): boolean {
  for (let j = headerIdx + 1; j < lines.length; j++) {
    const trimmed = (lines[j] ?? '').trim();
    if (trimmed.startsWith('at ')) {
      return true;
    }
    if (trimmed.length === 0) {
      // Allow the message section to be terminated by a blank line, but a blank
      // line with no frames yet means this is probably not an error block.
      return false;
    }
    // Keep scanning across multi-line message continuation lines.
  }
  return false;
}
