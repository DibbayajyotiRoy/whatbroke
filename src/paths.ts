/**
 * Filesystem layout for whatbroke's project-local store.
 *
 *   <project>/.whatbroke/
 *     bundles/  whatbroke-<id>.json + whatbroke-<id>.md
 *     journal.json
 *
 * All of it is gitignored; whatbroke writes the .gitignore entry on first run.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface StorePaths {
  root: string; // project root (cwd by default)
  dir: string; // <root>/.whatbroke
  bundlesDir: string; // <root>/.whatbroke/bundles
  journal: string; // <root>/.whatbroke/journal.json
}

export function resolveStorePaths(root: string, outDir?: string): StorePaths {
  const dir = path.join(root, '.whatbroke');
  const bundlesDir = outDir ? path.resolve(root, outDir) : path.join(dir, 'bundles');
  return { root, dir, bundlesDir, journal: path.join(dir, 'journal.json') };
}

export function bundleJsonPath(bundlesDir: string, id: string): string {
  return path.join(bundlesDir, `whatbroke-${id}.json`);
}

export function bundleMdPath(bundlesDir: string, id: string): string {
  return path.join(bundlesDir, `whatbroke-${id}.md`);
}

/** Ensure the store dirs exist and `.whatbroke/` is gitignored. Idempotent. */
export async function ensureStore(paths: StorePaths): Promise<{ createdGitignore: boolean }> {
  await fs.mkdir(paths.bundlesDir, { recursive: true });
  return ensureGitignored(paths.root, '.whatbroke/');
}

/**
 * Ensure `.whatbroke/` is gitignored without creating the bundles dir. Used on the
 * happy path, where the journal write would otherwise leave `.whatbroke/` showing
 * as an untracked file in the next run. Idempotent + silent.
 */
export async function ensureGitignore(root: string): Promise<{ createdGitignore: boolean }> {
  return ensureGitignored(root, '.whatbroke/');
}

async function ensureGitignored(
  root: string,
  entry: string,
): Promise<{ createdGitignore: boolean }> {
  const gi = path.join(root, '.gitignore');
  let content = '';
  let existed = true;
  try {
    content = await fs.readFile(gi, 'utf8');
  } catch {
    existed = false;
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ''))) {
    return { createdGitignore: false };
  }
  const next =
    content.length === 0
      ? `${entry}\n`
      : content.endsWith('\n')
        ? `${content}${entry}\n`
        : `${content}\n${entry}\n`;
  try {
    await fs.writeFile(gi, next, 'utf8');
  } catch {
    // best-effort; never fail the run over gitignore
  }
  return { createdGitignore: !existed };
}
