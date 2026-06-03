/**
 * Dependency collector → DepInfo.
 *
 * - `declared`:        merged deps + devDeps from <cwd>/package.json.
 * - `lockfile`:        which lockfile (if any) sits in cwd.
 * - `relevantResolved`: the high-signal part — package names that appear in the
 *   crash's stack frames (via `node_modules/<name>/...`), resolved to their
 *   installed versions. Capped so we never dump the whole tree.
 *
 * Tolerates a missing/corrupt package.json and unresolvable packages.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { DepInfo, StackFrame } from '../types.js';

/** Max number of resolved packages to include from the stack trace. */
const MAX_RESOLVED = 20;

/** Lockfile basename → DepInfo.lockfile tag. Checked in this order. */
const LOCKFILES: [string, DepInfo['lockfile']][] = [
  ['package-lock.json', 'package-lock'],
  ['pnpm-lock.yaml', 'pnpm-lock'],
  ['yarn.lock', 'yarn.lock'],
  ['bun.lockb', 'bun.lockb'],
];

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readDeclared(pkg: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pkg) return out;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block = pkg[field];
    if (typeof block === 'object' && block !== null) {
      for (const [name, range] of Object.entries(block as Record<string, unknown>)) {
        if (typeof range === 'string') out[name] = range;
      }
    }
  }
  return out;
}

async function detectLockfile(cwd: string): Promise<DepInfo['lockfile']> {
  for (const [file, tag] of LOCKFILES) {
    try {
      await fs.access(path.join(cwd, file));
      return tag;
    } catch {
      // not present
    }
  }
  return 'none';
}

/**
 * Extract a package name from a path that contains a `node_modules/` segment.
 * Handles scoped packages (`@scope/name`). Returns null when no package can be
 * identified. Uses the LAST `node_modules/` segment so nested installs resolve
 * to the actually-loaded package.
 */
function packageNameFromPath(file: string): string | null {
  const marker = 'node_modules/';
  const normalized = file.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = normalized.slice(idx + marker.length);
  const parts = rest.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const first = parts[0];
  if (first === undefined) return null;
  if (first.startsWith('@')) {
    const second = parts[1];
    if (second === undefined) return null;
    return `${first}/${second}`;
  }
  return first;
}

/** Collect distinct package names from stack frames, in first-seen order. */
function relevantNames(frames: StackFrame[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const frame of frames) {
    if (!frame.file) continue;
    const name = packageNameFromPath(frame.file);
    if (name && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

async function resolveVersion(cwd: string, name: string): Promise<string | null> {
  const pkgPath = path.join(cwd, 'node_modules', ...name.split('/'), 'package.json');
  const pkg = await readJson(pkgPath);
  if (pkg && typeof pkg['version'] === 'string') {
    return pkg['version'];
  }
  return null;
}

export async function collectDeps(cwd: string, frames: StackFrame[]): Promise<DepInfo> {
  const pkg = await readJson(path.join(cwd, 'package.json'));
  const declared = readDeclared(pkg);
  const lockfile = await detectLockfile(cwd);

  const relevantResolved: Record<string, string> = {};
  const names = relevantNames(frames).slice(0, MAX_RESOLVED);
  for (const name of names) {
    const version = await resolveVersion(cwd, name);
    if (version !== null) {
      relevantResolved[name] = version;
    }
  }

  return { declared, relevantResolved, lockfile };
}
