import type { GitInfo } from '../types.js';

/**
 * Shared "what changed since it last worked" derivation, used by BOTH suspect
 * ranking and confidence so the two can never disagree (05).
 *
 * The set is the union of:
 *   - working-tree changes (`git status --porcelain`) — uncommitted edits, and
 *   - files in the diff-vs-green patch — committed deltas since the green ref.
 *
 * When there is no green ref, only the working-tree (uncommitted) changes are
 * known; `hasGreen` is false and callers label/score that case as uncommitted
 * rather than "since green" (confidence stays `low` per spec).
 */
export interface ChangedSet {
  files: Set<string>;
  hasGreen: boolean;
}

/** Normalize a repo-relative path: unify separators to '/' and drop leading './'. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  return out;
}

const DIFF_GIT_LINE = /^diff --git a\/.+ b\/(.+)$/gm;

/** Extract changed file paths (new-side) from a unified diff patch. */
export function diffPaths(patch: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DIFF_GIT_LINE.lastIndex = 0;
  while ((m = DIFF_GIT_LINE.exec(patch)) !== null) {
    const p = m[1];
    if (p) out.push(normalizePath(p.trim()));
  }
  return out;
}

/**
 * whatbroke's own footprint must never be ranked as a suspect or counted as a
 * code change: the `.whatbroke/` store, and the root `.gitignore` line it manages
 * on first run (a .gitignore is never on a stack, so it is never a crash cause).
 */
export function isWhatbrokeArtifact(p: string): boolean {
  return p === '.whatbroke' || p.startsWith('.whatbroke/') || p === '.gitignore';
}

export function changedSinceGreen(git: GitInfo): ChangedSet {
  const files = new Set<string>();
  for (const cf of git.changedFiles) {
    const p = normalizePath(cf.path);
    if (!isWhatbrokeArtifact(p)) files.add(p);
  }
  const hasGreen = git.isRepo && !!git.greenRef;
  if (hasGreen && git.diffVsGreen?.patch) {
    for (const p of diffPaths(git.diffVsGreen.patch)) {
      if (!isWhatbrokeArtifact(p)) files.add(p);
    }
  }
  return { files, hasGreen };
}
