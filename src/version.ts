/** Tool identity for the bundle's `tool` field. Read from package.json at load. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/version.js -> ../package.json ; src/version.ts -> ../package.json
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const TOOL_NAME = 'whatbroke';
export const TOOL_VERSION = readVersion();

/** Where users report bugs in whatbroke itself. */
export const ISSUES_URL = 'https://github.com/DibbayajyotiRoy/whatbroke/issues';
