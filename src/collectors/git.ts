/**
 * Git collector → GitInfo.
 *
 * All git interaction goes through the `run` subprocess helper (never throws on
 * nonzero exit) and the `DiffProvider` seam. If the cwd is not inside a git
 * repository, returns a fully-populated "not a repo" GitInfo and stops.
 *
 * greenRef resolution order (best → fallback):
 *   1. journal.lookupGreen(fingerprint(argv, branch))  → source 'journal'
 *   2. git merge-base HEAD origin/<defaultBranch>       → source 'merge-base'
 *      (tries origin/main then origin/master)
 *   3. git rev-parse HEAD~1                              → source 'head~1'
 *   4. none                                             → source 'none'
 *
 * `diffVsGreen` (when a greenRef exists) is the working-tree-inclusive diff from
 * the greenRef, produced by the injected DiffProvider (defaults to git). The
 * patch is left RAW here; redaction (06) scrubs it downstream.
 */
import type {
  ChangedFile,
  CommandSpec,
  DiffProvider,
  GitInfo,
} from '../types.js';
import type { Journal } from '../journal/journal.js';
import { fingerprint } from '../journal/journal.js';
import { gitDiffProvider } from './gitDiffProvider.js';
import { run } from '../util/exec.js';

const DEFAULT_BRANCHES = ['origin/main', 'origin/master'];

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const { stdout, code } = await run('git', args, { cwd, timeoutMs: 10_000 });
  if (code !== 0) return null;
  return stdout.trim();
}

/**
 * Parse `git status --porcelain=v1` output into ChangedFile[].
 * Each line is `XY <path>` (X=index, Y=worktree). Renames/copies appear as
 * `R  old -> new` (or `C  old -> new`); we record the destination path.
 */
function parsePorcelain(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    // Status is the first two columns; path starts at column 3.
    const status = line.slice(0, 2);
    let pathPart = line.slice(3);
    if (pathPart.length === 0) continue;
    // Rename/copy: "old -> new". Keep the destination.
    const arrow = pathPart.indexOf(' -> ');
    if (arrow !== -1) {
      pathPart = pathPart.slice(arrow + 4);
    }
    files.push({ path: pathPart, status: status.trim() });
  }
  return files;
}

async function resolveGreenRef(
  cwd: string,
  command: CommandSpec,
  branch: string | null,
  journal: Journal,
): Promise<{ ref: string | null; source: NonNullable<GitInfo['greenRefSource']> }> {
  // 1) Journal.
  const fromJournal = journal.lookupGreen(fingerprint(command.argv, branch));
  if (fromJournal) {
    return { ref: fromJournal, source: 'journal' };
  }
  // 2) merge-base with a default branch.
  for (const def of DEFAULT_BRANCHES) {
    const mb = await gitOut(cwd, ['merge-base', 'HEAD', def]);
    if (mb) return { ref: mb, source: 'merge-base' };
  }
  // 3) HEAD~1.
  const prev = await gitOut(cwd, ['rev-parse', 'HEAD~1']);
  if (prev) return { ref: prev, source: 'head~1' };
  // 4) none.
  return { ref: null, source: 'none' };
}

export async function collectGit(
  command: CommandSpec,
  journal: Journal,
  diff?: DiffProvider,
): Promise<GitInfo> {
  const cwd = command.cwd;

  const toplevel = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) {
    return {
      isRepo: false,
      branch: null,
      head: null,
      dirty: false,
      changedFiles: [],
      greenRef: null,
      greenRefSource: 'none',
      note: 'not a git repository',
    };
  }

  const branch = await gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await gitOut(cwd, ['rev-parse', 'HEAD']);

  // Porcelain status is parsed raw (NOT via gitOut, which trims and would strip
  // the leading status-column space, e.g. " M file.txt" → "M file.txt").
  const status = await run('git', ['status', '--porcelain=v1'], {
    cwd,
    timeoutMs: 10_000,
  });
  const changedFiles = status.code === 0 ? parsePorcelain(status.stdout) : [];
  const dirty = changedFiles.length > 0;

  const { ref: greenRef, source: greenRefSource } = await resolveGreenRef(
    cwd,
    command,
    branch,
    journal,
  );

  const info: GitInfo = {
    isRepo: true,
    branch,
    head,
    dirty,
    changedFiles,
    greenRef,
    greenRefSource,
  };

  if (greenRef) {
    const provider = diff ?? gitDiffProvider;
    const { patch, truncated } = await provider.diff(greenRef, { cwd });
    info.diffVsGreen = { base: greenRef, truncated, patch };
  }

  return info;
}
