import type { CrashKind, CrashSignal } from '../types.js';
import { parseErrorBlock } from './stack.js';

/**
 * Classify how a child process terminated.
 *
 * Returns null for a green run (exit 0, no signal). Otherwise produces a
 * `CrashSignal`:
 *   - `kind: 'signal'` when terminated by a signal,
 *   - otherwise `kind: 'nonzero-exit'`, upgraded to `'uncaught-exception'` or
 *     `'unhandled-rejection'` by scanning the captured stderr,
 * attaching the parsed `error` + raw error block when one is found.
 */
export function classifyCrash(args: {
  exitCode: number | null;
  signal: string | null;
  stderrText: string;
}): CrashSignal | null {
  const { exitCode, signal, stderrText } = args;

  // Green run: clean exit with no terminating signal.
  if (exitCode === 0 && !signal) {
    return null;
  }

  let kind: CrashKind;
  if (signal) {
    kind = 'signal';
  } else {
    kind = 'nonzero-exit';
    // Upgrade based on stderr content. Rejection check first since some Node
    // versions print the uncaught banner alongside rejection output.
    if (isUnhandledRejection(stderrText)) {
      kind = 'unhandled-rejection';
    } else if (isUncaughtException(stderrText)) {
      kind = 'uncaught-exception';
    }
  }

  const crash: CrashSignal = {
    kind,
    exitCode,
    signal,
  };

  // Attach a parsed error block when stderr contains one. This is meaningful for
  // any kind (even a plain nonzero-exit may print an error), so always attempt.
  const error = parseErrorBlock(stderrText);
  if (error) {
    crash.error = error;
    crash.rawErrorBlock = error.rawStack;
  }

  return crash;
}

export function isUncaughtException(stderr: string): boolean {
  // Node prints lines like:
  //   `node:internal/process/...` followed by the error, and on newer versions
  //   an explicit banner. Match the common markers.
  if (stderr.includes('Uncaught')) {
    return true;
  }
  // The classic uncaught path surfaces the thrown error with a stack but no
  // rejection marker; a `*Error:` header with `at` frames is a strong signal.
  return /^\s*[\w$.]*Error:.*$/m.test(stderr) && /^\s*at\s/m.test(stderr);
}

export function isUnhandledRejection(stderr: string): boolean {
  return (
    stderr.includes('UnhandledPromiseRejection') ||
    stderr.includes('unhandledRejection') ||
    /\bunhandled promise rejection\b/i.test(stderr)
  );
}
