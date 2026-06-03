/**
 * Library surface for whatbroke.
 *
 * Primary use is the CLI (`whatbroke run`). This module also exposes the
 * programmatic hook (03, v1.5) for long-running processes where wrapping is
 * awkward, plus the building blocks for embedders. Note the documented gap:
 * hook mode has no stdout/stderr ring buffer (the process owns those streams),
 * so `logs` are empty unless the caller provides them.
 */
import type {
  Bundle,
  CommandSpec,
  CrashSignal,
  LogBuffer,
  RedactedBundle,
} from './types.js';
import { parseErrorBlock, parseStack } from './capture/stack.js';
import { collectAll } from './collectors/index.js';
import { reconstruct } from './repro/reconstruct.js';
import { redact } from './redaction/redact.js';
import { renderMarkdown } from './render/markdown.js';
import { createFileSink } from './sinks/file.js';
import { openJournal, fingerprint } from './journal/journal.js';
import {
  assembleBundle,
  enrichFrames,
  getGitRoot,
  gitHeadAndBranch,
} from './assemble.js';
import { bundleId } from './ids.js';
import { resolveStorePaths, ensureStore } from './paths.js';

export * from './types.js';
export { redact } from './redaction/redact.js';
export { renderMarkdown } from './render/markdown.js';
export { reconstruct } from './repro/reconstruct.js';
export { rankSuspects } from './repro/suspects.js';
export { parseStack, parseErrorBlock } from './capture/stack.js';
export { runCommand } from './capture/runner.js';

const EMPTY_LOGS: LogBuffer = {
  stdoutTail: '',
  stderrTail: '',
  combinedTail: '',
  truncated: false,
  bufferLines: 0,
};

export interface CaptureContext {
  tags?: string[];
  cwd?: string;
  command?: string[];
  logs?: LogBuffer;
  /** Write the bundle to ./.whatbroke/bundles. Default true. */
  write?: boolean;
}

/**
 * Capture a caught error into a redacted bundle (and persist it by default).
 * Returns the redacted bundle. Deterministic — no LLM.
 */
export async function capture(
  err: unknown,
  ctx: CaptureContext = {},
): Promise<RedactedBundle> {
  const cwd = ctx.cwd ?? process.cwd();
  const command: CommandSpec = { argv: ctx.command ?? process.argv.slice(1), cwd };

  const error = errorToInfo(err);
  const crash: CrashSignal = {
    kind: 'uncaught-exception',
    exitCode: null,
    signal: null,
  };
  if (error) crash.error = error;

  const gitRoot = await getGitRoot(cwd);
  if (crash.error) crash.error.stack = enrichFrames(crash.error.stack, gitRoot);

  const journal = await openJournal(resolveStorePaths(cwd).journal);
  const context = await collectAll({
    command,
    journal,
    frames: crash.error?.stack ?? [],
    logs: ctx.logs ?? EMPTY_LOGS,
  });

  const repro = reconstruct({ crash, context, command });
  const bundle: Bundle = assembleBundle({
    id: bundleId(),
    createdAt: new Date().toISOString(),
    crash,
    context,
    logs: ctx.logs ?? EMPTY_LOGS,
    repro,
  });

  const redacted = redact(bundle);

  if (ctx.write !== false) {
    const store = resolveStorePaths(cwd);
    await ensureStore(store);
    await createFileSink({ bundlesDir: store.bundlesDir, render: renderMarkdown })(redacted);
  }
  return redacted;
}

/**
 * Register process-level handlers (03). On an uncaught exception / unhandled
 * rejection, capture a bundle, then re-raise so the runtime behaves normally
 * (we do not swallow the crash).
 */
export function install(ctx: CaptureContext = {}): void {
  process.on('uncaughtException', (err) => {
    void capture(err, ctx).finally(() => {
      throw err;
    });
  });
  process.on('unhandledRejection', (reason) => {
    void capture(reason, ctx);
  });
}

function errorToInfo(err: unknown) {
  if (err instanceof Error) {
    const stack = err.stack ?? '';
    return {
      name: err.name,
      message: err.message,
      stack: parseStack(stack),
      rawStack: stack,
    };
  }
  // Non-Error throw: still record what we can.
  const parsed = typeof err === 'string' ? parseErrorBlock(err) : null;
  return (
    parsed ?? {
      name: 'NonError',
      message: typeof err === 'string' ? err : JSON.stringify(err),
      stack: [],
      rawStack: '',
    }
  );
}

/** Recompute the journal fingerprint for a command (exposed for tooling). */
export { fingerprint };
