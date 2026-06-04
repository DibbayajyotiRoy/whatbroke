/**
 * Adapter wiring. Imports register the built-in adapters (node first, so it is
 * the registry fallback), and exposes `selectAdapter` plus a helper to build a
 * `DetectionContext` from a command + captured logs.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CommandSpec, LogBuffer } from '../types.js';
import type { DetectionContext } from './types.js';
import { registerAdapter, selectAdapter } from './registry.js';
import { makeDeclarativeAdapter, makeGenericDeps } from './declarative.js';
import { nodeAdapter } from './node/index.js';
import { pythonGrammar } from './grammars/python.js';
import { goGrammar } from './grammars/go.js';

export const pythonAdapter = makeDeclarativeAdapter(pythonGrammar, {
  collectDeps: makeGenericDeps(
    [
      ['requirements.txt', 'requirements'],
      ['Pipfile.lock', 'pipfile'],
      ['poetry.lock', 'poetry'],
    ],
    'pyproject.toml',
  ),
});

export const goAdapter = makeDeclarativeAdapter(goGrammar, {
  collectDeps: makeGenericDeps([['go.sum', 'go.sum']], 'go.mod'),
});

// Registration order = tie-break order. Node first so it stays the fallback.
registerAdapter(nodeAdapter);
registerAdapter(pythonAdapter);
registerAdapter(goAdapter);

export { selectAdapter, registerAdapter } from './registry.js';
export { nodeAdapter } from './node/index.js';
export type { LanguageAdapter, DetectionContext } from './types.js';

/** Shallow source extensions to sample from cwd for detection. */
const MAX_ENTRIES = 400;

/**
 * Build a `DetectionContext` for a run: the command, a shallow listing of cwd
 * (basenames + distinct extensions), and the captured stderr/stdout tails.
 * Filesystem failures degrade to empty signals — detection still works off argv
 * and stderr markers.
 */
export async function buildDetectionContext(
  command: CommandSpec,
  logs: LogBuffer,
): Promise<DetectionContext> {
  const cwdEntries: string[] = [];
  const fileExtensions = new Set<string>();
  try {
    const entries = await fs.readdir(command.cwd, { withFileTypes: true });
    for (const e of entries.slice(0, MAX_ENTRIES)) {
      cwdEntries.push(e.name);
      if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext) fileExtensions.add(ext);
      }
    }
  } catch {
    // Not readable — rely on argv + stderr signals.
  }

  return {
    command,
    cwdEntries,
    fileExtensions,
    stderrText: logs.stderrTail,
    stdoutText: logs.stdoutTail,
  };
}
