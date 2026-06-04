/**
 * Build a full `LanguageAdapter` from a declarative `StackGrammar` plus a set of
 * collectors. New languages register one of these; no imperative parsing code.
 */
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  CrashKind,
  CrashSignal,
  DepInfo,
  EnvInfo,
  LogBuffer,
  StackFrame,
  TestFailure,
} from '../types.js';
import type {
  AdapterCollectors,
  ClassifyInput,
  DetectionContext,
  LanguageAdapter,
} from './types.js';
import { parseWithGrammar, scoreGrammar, type StackGrammar } from './grammar.js';

/**
 * Generic env collector for ecosystems without a bespoke one: OS + a named
 * runtime with an unknown version. Never throws.
 */
export function makeGenericEnv(runtimeName: string) {
  return async function collectEnv(cwd: string): Promise<EnvInfo> {
    return {
      os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      runtime: { name: runtimeName, version: '' },
      packageManager: { name: 'unknown', version: null },
      envKeys: Object.keys(process.env).sort(),
      envValues: {},
      cwd,
    };
  };
}

/**
 * Generic deps collector: detects a manifest/lockfile by basename. No
 * version resolution (that is ecosystem-specific and lands per-language later).
 */
export function makeGenericDeps(
  lockfiles: [string, DepInfo['lockfile']][],
  manifest?: string,
) {
  return async function collectDeps(
    cwd: string,
    _frames: StackFrame[],
  ): Promise<DepInfo> {
    let lockfile: DepInfo['lockfile'] = 'none';
    for (const [file, tag] of lockfiles) {
      try {
        await fs.access(path.join(cwd, file));
        lockfile = tag;
        break;
      } catch {
        // not present
      }
    }
    const deps: DepInfo = { declared: {}, relevantResolved: {}, lockfile };
    if (manifest) deps.manifest = manifest;
    return deps;
  };
}

const noTestFailure = (_logs: LogBuffer): TestFailure | null => null;

export function makeDeclarativeAdapter(
  grammar: StackGrammar,
  collectors?: Partial<AdapterCollectors>,
): LanguageAdapter {
  const collectEnv = collectors?.collectEnv ?? makeGenericEnv(grammar.id);
  const collectDeps =
    collectors?.collectDeps ?? makeGenericDeps([], undefined);
  const parseTestFailure = collectors?.parseTestFailure ?? noTestFailure;

  return {
    id: grammar.id,

    detect(ctx: DetectionContext): number {
      return scoreGrammar(grammar, {
        argv: ctx.command.argv.join(' '),
        cwdEntries: ctx.cwdEntries,
        fileExtensions: ctx.fileExtensions,
        stderrText: ctx.stderrText,
      });
    },

    parseError(stderrText: string) {
      return parseWithGrammar(stderrText, grammar);
    },

    classify(input: ClassifyInput): CrashSignal | null {
      const { exitCode, signal, stderrText, error } = input;
      if (exitCode === 0 && !signal) return null;

      let kind: CrashKind = signal ? 'signal' : 'nonzero-exit';
      if (!signal && error) kind = 'uncaught-exception';
      if (grammar.crashKinds) {
        for (const ck of grammar.crashKinds) {
          if (ck.pattern.test(stderrText)) {
            kind = ck.kind;
            break;
          }
        }
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
}
