/**
 * Read-only bundle access for the whatbroke VS Code extension.
 *
 * This is a *reader*. It mirrors the subset of the core `RedactedBundle` schema
 * (`src/types.ts` in the CLI package, spec 02) that the views need, locates the
 * newest `whatbroke-<id>.json` in a workspace's `.whatbroke/bundles/` directory,
 * parses it, and hands it back. It computes nothing and writes nothing — the
 * redaction guarantee holds because the files on disk were already gated by the
 * CLI before they were persisted.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Schema subset (mirrors core src/types.ts; additive fields tolerated) ──────

export interface StackFrame {
  functionName: string | null;
  file: string | null; // absolute path
  fileRelative: string | null; // relative to repo root if inside repo
  line: number | null;
  column: number | null;
  isUserCode: boolean;
  isInRepo: boolean;
  sourceMapped: boolean;
}

export interface SuspectFile {
  path: string;
  score: number;
  reasons: string[];
}

export interface ChangedFile {
  path: string;
  status: string;
}

export interface Bundle {
  schemaVersion: number;
  id: string;
  createdAt: string;
  tool: { name: string; version: string };
  language?: string;
  crash: {
    kind: string;
    exitCode: number | null;
    signal: string | null;
    error?: { name: string; message: string; stack: StackFrame[]; rawStack: string };
    testFailure?: {
      runner: string;
      failingTests: { id: string; file: string | null; message?: string }[];
    };
  };
  git: {
    isRepo: boolean;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    changedFiles: ChangedFile[];
    greenRef: string | null;
    greenRefSource?: string;
    diffVsGreen?: { base: string; truncated: boolean; patch: string };
    note?: string;
  };
  logs: {
    stdoutTail: string;
    stderrTail: string;
    combinedTail?: string;
    truncated: boolean;
    bufferLines: number;
  };
  repro: {
    suspects: SuspectFile[];
    confidence: string;
    narration?: string;
  };
}

const FILE_RE = /^whatbroke-(.+)\.json$/;

/**
 * Normalize a path as it appears in a bundle into an absolute filesystem path.
 *
 * Bundle paths are heterogeneous by origin: Node ESM stack frames are stored as
 * `file://` URLs (and `fileRelative` can be a malformed `file:/…` string), while
 * git-derived suspect/changed paths are repo-relative. This collapses all of
 * those to one absolute fs path the editor can open.
 */
export function toFsPath(raw: string, workspaceRoot: string): string {
  let p = raw;
  if (/^file:/i.test(p)) {
    // Re-form a canonical file URL (handles file:/x, file://x, file:///x) then convert.
    const rest = p.replace(/^file:\/*/i, '');
    try {
      p = fileURLToPath('file:///' + rest);
    } catch {
      p = '/' + rest;
    }
  }
  return path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
}

/** A short, human-friendly label: workspace-relative when inside, else basename. */
export function displayPath(raw: string, workspaceRoot: string): string {
  const abs = toFsPath(raw, workspaceRoot);
  const rel = path.relative(workspaceRoot, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(abs);
}

export function bundlesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.whatbroke', 'bundles');
}

export function journalPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.whatbroke', 'journal.json');
}

/** One-line error summary, same shape the MCP store uses. */
export function errorSummary(bundle: Bundle): string {
  const err = bundle.crash?.error;
  if (err && (err.name || err.message)) {
    const name = err.name || 'Error';
    return err.message ? `${name}: ${err.message}` : name;
  }
  const crash = bundle.crash;
  if (crash) {
    if (crash.signal) return `signal ${crash.signal}`;
    if (typeof crash.exitCode === 'number') return `exit ${crash.exitCode} (${crash.kind})`;
    return crash.kind;
  }
  return 'unknown crash';
}

/** The single highest-ranked user frame, used to anchor diagnostics/codelens. */
export function topUserFrame(bundle: Bundle): StackFrame | undefined {
  const frames = bundle.crash?.error?.stack ?? [];
  return frames.find((f) => f.isUserCode && f.isInRepo && f.file && f.line != null);
}

/** The user-code frames, in order, that point at a real file:line. */
export function userFrames(bundle: Bundle): StackFrame[] {
  const frames = bundle.crash?.error?.stack ?? [];
  return frames.filter((f) => f.isUserCode && f.file && f.line != null);
}

export interface LatestBundle {
  bundle: Bundle;
  jsonPath: string;
  /** Sibling Markdown render path, if the CLI wrote one. */
  markdownPath: string;
}

async function readBundle(jsonPath: string): Promise<Bundle | null> {
  try {
    const text = await fs.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string') {
      return parsed as Bundle;
    }
    return null;
  } catch {
    return null; // tolerant: skip anything unreadable
  }
}

/**
 * Newest bundle in a workspace, or null. "Newest" is decided by `createdAt`
 * (falling back to file mtime), matching the CLI/MCP most-recent-first ordering.
 */
export async function loadLatest(workspaceRoot: string): Promise<LatestBundle | null> {
  const dir = bundlesDir(workspaceRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }

  const candidates: { bundle: Bundle; jsonPath: string; sortKey: number }[] = [];
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const jsonPath = path.join(dir, name);
    const bundle = await readBundle(jsonPath);
    if (!bundle) continue;
    let sortKey = Date.parse(bundle.createdAt);
    if (Number.isNaN(sortKey)) {
      try {
        sortKey = (await fs.stat(jsonPath)).mtimeMs;
      } catch {
        sortKey = 0;
      }
    }
    candidates.push({ bundle, jsonPath, sortKey });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.sortKey - a.sortKey);
  const winner = candidates[0];
  return {
    bundle: winner.bundle,
    jsonPath: winner.jsonPath,
    markdownPath: winner.jsonPath.replace(/\.json$/, '.md'),
  };
}

/**
 * Whether a green (passing) run happened *after* this crash bundle was written.
 * The CLI writes no bundle on green runs — it only touches `.whatbroke/journal.json`
 * — so a journal mtime newer than the crash means "you've since run green; this
 * crash is resolved." Used to clear diagnostics, per spec 09.
 */
export async function greenSinceBundle(workspaceRoot: string, bundle: Bundle): Promise<boolean> {
  try {
    const stat = await fs.stat(journalPath(workspaceRoot));
    const created = Date.parse(bundle.createdAt);
    if (Number.isNaN(created)) return false;
    return stat.mtimeMs > created + 1000; // 1s slack: the crash also writes the journal
  } catch {
    return false;
  }
}

/**
 * Whether a stack location may have drifted since the crash was captured.
 * Stale if HEAD moved off the captured `git.head`, or if the file itself was
 * modified after the bundle was written. Either way the pinned `file:line` can
 * no longer be trusted to point at the crash origin (spec 09).
 */
export async function isLocationStale(
  workspaceRoot: string,
  bundle: Bundle,
  absFile: string,
): Promise<boolean> {
  const head = await currentHead(workspaceRoot);
  if (head && bundle.git?.head && head !== bundle.git.head) return true;

  const created = Date.parse(bundle.createdAt);
  if (Number.isNaN(created)) return false;
  try {
    const stat = await fs.stat(absFile);
    return stat.mtimeMs > created + 1000;
  } catch {
    return false;
  }
}

/**
 * Best-effort read of the workspace's current HEAD sha straight from `.git`,
 * without shelling out. Used only to decide whether a bundle's pinned locations
 * may be stale (spec 09 "the one real bug to handle").
 */
export async function currentHead(workspaceRoot: string): Promise<string | null> {
  try {
    const headFile = path.join(workspaceRoot, '.git', 'HEAD');
    const head = (await fs.readFile(headFile, 'utf8')).trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) {
      return head || null; // detached HEAD: the file holds a raw sha
    }
    const ref = refMatch[1].trim();
    try {
      const sha = (await fs.readFile(path.join(workspaceRoot, '.git', ref), 'utf8')).trim();
      if (sha) return sha;
    } catch {
      // ref not loose — fall through to packed-refs
    }
    const packed = await fs.readFile(path.join(workspaceRoot, '.git', 'packed-refs'), 'utf8');
    for (const rawLine of packed.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.split(/\s+/, 2);
      if (name === ref) return sha;
    }
    return null;
  } catch {
    return null;
  }
}
