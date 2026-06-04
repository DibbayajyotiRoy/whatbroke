/**
 * Node/V8 adapter — the first built-in. It reuses the battle-tested imperative
 * parser (`parseErrorBlock`) and the existing Node collectors, so the Node path
 * is byte-identical to pre-v0.2 behaviour; only the seam around it is new.
 */
import type { CrashKind, CrashSignal } from '../../types.js';
import { parseErrorBlock } from '../../capture/stack.js';
import {
  isUncaughtException,
  isUnhandledRejection,
} from '../../capture/classify.js';
import { collectEnv } from '../../collectors/env.js';
import { collectDeps } from '../../collectors/deps.js';
import { parseTestFailure } from '../../collectors/testRunners/index.js';
import type { ClassifyInput, DetectionContext, LanguageAdapter } from '../types.js';

const JS_COMMAND =
  /\b(node|npm|npx|pnpm|yarn|bun|tsx|ts-node|jest|vitest|mocha|playwright|deno)\b/;
const JS_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
];
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
// A V8 frame line: `    at fn (/abs/file.ts:12:34)` or `    at /abs:12:34`.
const V8_FRAME = /^\s+at .+:\d+:\d+\)?\s*$/m;

export const nodeAdapter: LanguageAdapter = {
  id: 'node',

  detect(ctx: DetectionContext): number {
    let s = 0;
    if (JS_COMMAND.test(ctx.command.argv.join(' '))) s += 0.5;
    if (ctx.cwdEntries.some((f) => JS_MANIFESTS.includes(f))) s += 0.3;
    if (JS_EXTENSIONS.some((e) => ctx.fileExtensions.has(e))) s += 0.2;
    if (V8_FRAME.test(ctx.stderrText)) s += 0.6;
    return Math.min(s, 1);
  },

  parseError(stderrText: string) {
    return parseErrorBlock(stderrText);
  },

  classify(input: ClassifyInput): CrashSignal | null {
    const { exitCode, signal, stderrText, error } = input;
    if (exitCode === 0 && !signal) return null;

    let kind: CrashKind = signal ? 'signal' : 'nonzero-exit';
    if (!signal) {
      // Rejection check first — some Node versions print both banners.
      if (isUnhandledRejection(stderrText)) kind = 'unhandled-rejection';
      else if (isUncaughtException(stderrText)) kind = 'uncaught-exception';
    }

    const crash: CrashSignal = { kind, exitCode, signal };
    if (error) {
      crash.error = error;
      crash.rawErrorBlock = error.rawStack;
    }
    return crash;
  },

  collectEnv,
  collectDeps,
  parseTestFailure,
};
