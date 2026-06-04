/**
 * Python traceback grammar.
 *
 * Tracebacks are bottom-first (most-recent call last) and the exception header
 * trails the frames:
 *
 *   Traceback (most recent call last):
 *     File "/app/svc/handler.py", line 42, in handle
 *       result = compute(payload)
 *     File "/app/svc/math.py", line 7, in compute
 *       return 1 / divisor
 *   ZeroDivisionError: division by zero
 */
import type { StackGrammar } from '../grammar.js';

export const pythonGrammar: StackGrammar = {
  id: 'python',
  detect: {
    commands: [/\bpython3?\b/, /\bpytest\b/, /\buvicorn\b/, /\bgunicorn\b/, /\bmanage\.py\b/],
    extensions: ['.py'],
    cwdFiles: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg'],
    stderrMarkers: [/^Traceback \(most recent call last\):/m],
  },
  error: {
    // Trailing `ExceptionName: message` after the frame block.
    header:
      /^(?<name>[A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit|KeyboardInterrupt)):?\s?(?<message>.*)$/,
    headerAfterFrames: true,
    // Keep the last traceback in a chained exception (the one that propagated).
    chainSeparator:
      /^(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)$/m,
  },
  frame: {
    line: /^\s*File "(?<file>[^"]+)", line (?<line>\d+), in (?<func>\S+)\s*$/,
    order: 'bottom-first',
  },
  userCode: {
    vendorPatterns: [
      /[\\/]site-packages[\\/]/,
      /[\\/]dist-packages[\\/]/,
      /[\\/]lib[\\/]python\d/,
      /<frozen [^>]*>/,
    ],
  },
  crashKinds: [{ pattern: /^SystemExit:/m, kind: 'nonzero-exit' }],
};
