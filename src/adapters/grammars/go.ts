/**
 * Go panic grammar.
 *
 * Panics are top-first; each frame is two lines — a function line, then a
 * tab-indented `file:line +offset`:
 *
 *   panic: runtime error: index out of range [3] with length 2
 *
 *   goroutine 1 [running]:
 *   main.process(...)
 *   \t/home/u/app/process.go:24 +0x1d
 *   main.main()
 *   \t/home/u/app/main.go:11 +0x65
 *   exit status 2
 */
import type { StackGrammar } from '../grammar.js';

export const goGrammar: StackGrammar = {
  id: 'go',
  detect: {
    commands: [/\bgo\s+(run|test|build)\b/, /\bgotestsum\b/],
    extensions: ['.go'],
    cwdFiles: ['go.mod', 'go.sum'],
    stderrMarkers: [/^panic:/m, /^goroutine \d+ \[/m, /^fatal error:/m],
  },
  error: {
    header: /^(?<name>panic|fatal error):\s?(?<message>.*)$/,
    headerAfterFrames: false,
  },
  frame: {
    // The tab-indented location line. `funcLine` carries the name from above.
    line: /^\t(?<file>.+\.go):(?<line>\d+)(?::(?<col>\d+))?(?: \+0x[0-9a-f]+)?\s*$/,
    funcLine: /^(?<func>[\w./*()[\]]+)\(.*\)$/,
    order: 'top-first',
  },
  userCode: {
    vendorPatterns: [
      /[\\/]go[\\/]pkg[\\/]mod[\\/]/,
      /[\\/]usr[\\/](?:local[\\/])?go[\\/]src[\\/]/,
      /[\\/]runtime[\\/][\w.]+\.go$/,
    ],
  },
  crashKinds: [{ pattern: /^fatal error:/m, kind: 'uncaught-exception' }],
};
