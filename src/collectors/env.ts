/**
 * Environment collector → EnvInfo.
 *
 * Captures OS, runtime, package-manager identity+version, env var KEYS (never
 * values — those are filled later by redaction for allowlisted keys only), and
 * the cwd. Degrades gracefully: an undetectable/uninstalled package manager
 * yields name 'unknown' / version null rather than throwing.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EnvInfo } from '../types.js';
import { run } from '../util/exec.js';

type PmName = EnvInfo['packageManager']['name'];

/** Map lockfile basename → package manager. */
const LOCKFILE_PM: Record<string, Exclude<PmName, 'unknown'>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
};

async function detectPmName(cwd: string): Promise<PmName> {
  // 1) Lockfile present in cwd is the strongest signal.
  for (const [file, pm] of Object.entries(LOCKFILE_PM)) {
    try {
      await fs.access(path.join(cwd, file));
      return pm;
    } catch {
      // not present
    }
  }
  // 2) Fall back to the user agent the invoking PM sets.
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  if (ua.startsWith('npm')) return 'npm';
  return 'unknown';
}

async function resolvePmVersion(name: PmName): Promise<string | null> {
  if (name === 'unknown') return null;
  try {
    const { stdout, code } = await run(name, ['--version'], { timeoutMs: 5_000 });
    if (code !== 0) return null;
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function collectEnv(cwd: string): Promise<EnvInfo> {
  const name = await detectPmName(cwd);
  const version = await resolvePmVersion(name);

  const runtime: EnvInfo['runtime'] = { node: process.versions.node };
  if (process.versions.v8) {
    runtime.v8 = process.versions.v8;
  }

  return {
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    runtime,
    packageManager: { name, version },
    envKeys: Object.keys(process.env).sort(),
    // Keys only here. Values are filled later by redaction for allowlisted keys.
    envValues: {},
    cwd,
  };
}
