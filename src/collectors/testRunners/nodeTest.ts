/**
 * node:test (TAP) output parser.
 *
 * The built-in node test runner emits TAP:
 *
 *   TAP version 13
 *   not ok 1 - adds two numbers
 *     ---
 *     ...
 *   1..2
 *   # tests 2
 *   # pass 1
 *   # fail 1
 *
 * We detect it by `TAP version` or a `# tests N` line combined with `not ok`/`ok`
 * markers — the TAP shape is the runner-specific marker.
 */
import type { TestFailure } from '../../types.js';

/** `not ok 1 - adds two numbers` — capture the test name. */
const NOT_OK_LINE = /^\s*not ok\s+\d+\s*-?\s*(.*?)\s*$/gm;
const TAP_VERSION = /^\s*TAP version\b/m;
const TESTS_DIRECTIVE = /^#\s*tests\s+(\d+)\s*$/m;
const PASS_DIRECTIVE = /^#\s*pass\s+(\d+)\s*$/m;
const FAIL_DIRECTIVE = /^#\s*fail\s+(\d+)\s*$/m;
/** Generic `ok`/`not ok` TAP point — secondary signal. */
const TAP_POINT = /^\s*(?:not )?ok\s+\d+\b/m;

function toInt(re: RegExp, text: string): number | undefined {
  const m = re.exec(text);
  if (!m || m[1] === undefined) {
    return undefined;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

export function parseNodeTest(text: string): TestFailure | null {
  const hasTapVersion = TAP_VERSION.test(text);
  const hasTestsDirective = TESTS_DIRECTIVE.test(text);
  const hasTapPoint = TAP_POINT.test(text);

  // Require a TAP-specific marker. `# tests N` and `TAP version` are distinctive;
  // a bare `not ok` alone is too generic, so pair it with one of those markers.
  if (!hasTapVersion && !hasTestsDirective) {
    return null;
  }
  if (!hasTapPoint) {
    return null;
  }

  const failingTests: TestFailure['failingTests'] = [];
  for (const m of text.matchAll(NOT_OK_LINE)) {
    // Skip TAP subtest "diagnostic" duplicates by trimming the name.
    const id = (m[1] ?? '').trim();
    if (id.length > 0) {
      failingTests.push({ id, file: null });
    } else {
      failingTests.push({ id: 'unnamed test', file: null });
    }
  }

  const total = toInt(TESTS_DIRECTIVE, text);
  const passed = toInt(PASS_DIRECTIVE, text);
  const failed = toInt(FAIL_DIRECTIVE, text);

  const result: TestFailure = { runner: 'node:test', failingTests };
  if (total !== undefined) {
    result.total = total;
  }
  if (failed !== undefined) {
    result.failed = failed;
  }
  if (passed !== undefined) {
    result.passed = passed;
  }
  return result;
}
