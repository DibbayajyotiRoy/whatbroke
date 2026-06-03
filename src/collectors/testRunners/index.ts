/**
 * Test-runner collector entry point.
 *
 * Combines the captured stdout/stderr tail and tries each runner-specific parser in a
 * sensible order, returning the first confident match. Every parser is conservative: it
 * returns null unless a runner-specific marker is present, so we never misattribute one
 * runner's output to another. A complete miss yields null (the caller degrades to the
 * `unknown` runner).
 */
import type { LogBuffer, TestFailure } from '../../types.js';
import { parseJest } from './jest.js';
import { parseVitest } from './vitest.js';
import { parsePlaywright } from './playwright.js';
import { parseMocha } from './mocha.js';
import { parseNodeTest } from './nodeTest.js';

export { parseJest } from './jest.js';
export { parseVitest } from './vitest.js';
export { parsePlaywright } from './playwright.js';
export { parseMocha } from './mocha.js';
export { parseNodeTest } from './nodeTest.js';

/** Parsers in priority order. Jest and vitest are mutually exclusive by marker. */
const PARSERS: ((text: string) => TestFailure | null)[] = [
  parseJest,
  parseVitest,
  parsePlaywright,
  parseMocha,
  parseNodeTest,
];

export function parseTestFailure(logs: LogBuffer): TestFailure | null {
  // Parse the CLEAN per-stream tails, not `combinedTail`: the combined buffer
  // is line-tagged (`[stdout] ...`) for human-readable interleaving, which
  // breaks the parsers' line-anchored markers (`not ok`, `# tests`, `FAIL`).
  const text = `${logs.stdoutTail}\n${logs.stderrTail}`;

  for (const parse of PARSERS) {
    try {
      const result = parse(text);
      if (result !== null) {
        return result;
      }
    } catch {
      // Tolerant by contract: a throwing parser must never break the pipeline.
    }
  }
  return null;
}
