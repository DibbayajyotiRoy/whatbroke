/**
 * Default DiffProvider implementation — shells out to `git`.
 *
 * This is the v1 seam: collectors depend only on the `DiffProvider` interface,
 * so a future `diffcore`-backed provider (structural / language-aware diffs)
 * can be swapped in by changing this one file, without touching git.ts.
 *
 * `diff(baseRef)` runs `git diff <baseRef> --`, which is working-tree-inclusive:
 * it shows everything that changed between `baseRef` and the CURRENT working
 * tree, including uncommitted edits. That's exactly "what changed since it last
 * worked". The patch is truncated to `maxBytes` (default 200 KB) and `truncated`
 * is set accordingly. Any failure (bad ref, not a repo) degrades to an empty,
 * non-truncated result.
 */
import type { DiffOptions, DiffProvider, DiffResult } from '../types.js';
import { run } from '../util/exec.js';

const DEFAULT_MAX_BYTES = 200_000;

export const gitDiffProvider: DiffProvider = {
  async diff(baseRef: string, opts: DiffOptions): Promise<DiffResult> {
    const { cwd, maxBytes = DEFAULT_MAX_BYTES } = opts;
    try {
      const { stdout, code } = await run('git', ['diff', baseRef, '--'], {
        cwd,
        timeoutMs: 15_000,
      });
      if (code !== 0) {
        return { patch: '', truncated: false };
      }
      return truncate(stdout, maxBytes);
    } catch {
      return { patch: '', truncated: false };
    }
  },
};

function truncate(patch: string, maxBytes: number): DiffResult {
  // Measure in bytes (UTF-8), not characters, to respect the byte cap.
  const buf = Buffer.from(patch, 'utf8');
  if (buf.length <= maxBytes) {
    return { patch, truncated: false };
  }
  // Slice at the byte boundary, then decode back to a (possibly shorter) string.
  // toString may split a multibyte char at the edge; that's acceptable for a
  // truncated patch and never throws.
  const sliced = buf.subarray(0, maxBytes).toString('utf8');
  return { patch: sliced, truncated: true };
}
