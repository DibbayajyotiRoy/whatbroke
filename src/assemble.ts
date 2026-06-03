/**
 * Bundle assembly (01 data-flow contract). Turns the stage outputs
 * (CrashSignal + RawContext + LogBuffer + ReproInfo) into a single in-memory
 * `Bundle` conforming to the schema (02). Also resolves stack-frame repo
 * locations, which need the git root that capture didn't have.
 *
 * This is the pre-gate assembled bundle; `redact()` (06) turns it into a
 * RedactedBundle before any sink/reader touches it.
 */
import * as path from 'node:path';
import type {
  Bundle,
  CommandSpec,
  CrashInfo,
  CrashSignal,
  LogBuffer,
  LogInfo,
  RawContext,
  ReproInfo,
  StackFrame,
} from './types.js';
import { run } from './util/exec.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

/** Resolve the git repo root for `cwd`, or null if not in a repo. */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout, code } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    });
    if (code !== 0) return null;
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Fill `isInRepo` + `fileRelative` on stack frames now that the repo root is
 * known. Capture (03) leaves these as false/null by design.
 */
export function enrichFrames(frames: StackFrame[], gitRoot: string | null): StackFrame[] {
  if (!gitRoot) return frames;
  const root = path.resolve(gitRoot);
  return frames.map((frame) => {
    if (!frame.file) return frame;
    const abs = path.resolve(frame.file);
    const rel = path.relative(root, abs);
    const inRepo = rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inRepo) return frame;
    return {
      ...frame,
      isInRepo: true,
      fileRelative: rel.split(path.sep).join('/'),
    };
  });
}

function toLogInfo(logs: LogBuffer): LogInfo {
  return {
    stdoutTail: logs.stdoutTail,
    stderrTail: logs.stderrTail,
    combinedTail: logs.combinedTail,
    truncated: logs.truncated,
    bufferLines: logs.bufferLines,
  };
}

function toCrashInfo(crash: CrashSignal, context: RawContext): CrashInfo {
  const info: CrashInfo = {
    kind: crash.kind,
    exitCode: crash.exitCode,
    signal: crash.signal,
  };
  if (crash.error) info.error = crash.error;
  if (context.testFailure) info.testFailure = context.testFailure;
  return info;
}

export interface AssembleParts {
  id: string;
  createdAt: string;
  crash: CrashSignal;
  context: RawContext;
  logs: LogBuffer;
  repro: ReproInfo;
}

export function assembleBundle(parts: AssembleParts): Bundle {
  const { id, createdAt, crash, context, logs, repro } = parts;
  return {
    schemaVersion: 1,
    id,
    createdAt,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    crash: toCrashInfo(crash, context),
    environment: context.env,
    dependencies: context.deps,
    git: context.git,
    logs: toLogInfo(logs),
    repro,
    redaction: { redactedCount: 0, rules: [] },
    collectorErrors: context.collectorErrors,
  };
}

/** Best-effort branch + head for the green-recording path (no full collect). */
export async function gitHeadAndBranch(
  cwd: string,
): Promise<{ head: string | null; branch: string | null }> {
  try {
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd });
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return {
      head: head.code === 0 ? head.stdout.trim() || null : null,
      branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    };
  } catch {
    return { head: null, branch: null };
  }
}

export function relCommandCwd(cwd: string, gitRoot: string | null): string {
  if (!gitRoot) return cwd;
  const rel = path.relative(gitRoot, cwd);
  return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
}
