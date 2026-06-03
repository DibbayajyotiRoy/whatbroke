/**
 * Load a persisted bundle by id or path for the `show`/`open` utilities (07).
 * Bundles on disk are already redacted (persisted post-gate), so we trust them
 * as RedactedBundle — readers never recompute (01).
 */
import { promises as fs } from 'node:fs';
import type { RedactedBundle } from '../types.js';
import { BundleStore } from '../mcp/store.js';

export async function loadBundle(
  ref: string,
  bundlesDir: string,
): Promise<RedactedBundle | null> {
  // Path-like reference: read directly.
  if (ref.endsWith('.json') || ref.includes('/') || ref.includes('\\')) {
    try {
      const raw = await fs.readFile(ref, 'utf8');
      return JSON.parse(raw) as RedactedBundle;
    } catch {
      return null;
    }
  }
  // Otherwise treat as a bundle id.
  const store = new BundleStore(bundlesDir);
  return store.get(ref);
}
