/**
 * Mocha output parser.
 *
 * Mocha's `spec` reporter prints a summary block:
 *
 *   2 passing (15ms)
 *   1 failing
 *
 *   1) Array #indexOf should return -1 when not present:
 *      AssertionError: expected -1 to equal 0
 *
 * We detect mocha by a `N passing` line and/or a numbered failure list (`  1) ...:`).
 * Mocha does not report file paths in this block, so `file` is null.
 */
import type { TestFailure } from '../../types.js';

/** `2 passing (15ms)` */
const PASSING_LINE = /^\s*(\d+)\s+passing\b/m;
/** `1 failing` */
const FAILING_LINE = /^\s*(\d+)\s+failing\b/m;
/** `1) Array #indexOf should return -1 when not present:` — numbered failure header. */
const FAILURE_ITEM = /^\s*(\d+)\)\s+(.+?):\s*$/gm;

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) {
    return undefined;
  }
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

export function parseMocha(text: string): TestFailure | null {
  const passingMatch = PASSING_LINE.exec(text);
  const failingMatch = FAILING_LINE.exec(text);

  const failingTests: TestFailure['failingTests'] = [];
  for (const m of text.matchAll(FAILURE_ITEM)) {
    if (m[2] === undefined) {
      continue;
    }
    const id = m[2].trim();
    if (id.length > 0) {
      failingTests.push({ id, file: null });
    }
  }

  // Conservative detection: require a mocha-shaped summary marker. A lone numbered
  // list could come from anything, so do not match on it alone.
  if (!passingMatch && !failingMatch) {
    return null;
  }

  const passed = toInt(passingMatch?.[1]);
  const failed = toInt(failingMatch?.[1]);

  const result: TestFailure = { runner: 'mocha', failingTests };
  if (failed !== undefined) {
    result.failed = failed;
  }
  if (passed !== undefined) {
    result.passed = passed;
  }
  if (passed !== undefined || failed !== undefined) {
    result.total = (passed ?? 0) + (failed ?? 0);
  }
  return result;
}
