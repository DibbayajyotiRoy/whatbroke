/**
 * Short, sortable-enough, dependency-free id for bundles.
 * Time prefix (base36 ms) + random suffix (crypto). ~ "lq8x3k-7f9a2c".
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function base36(n: number): string {
  let out = '';
  let v = Math.max(0, Math.floor(n));
  if (v === 0) return '0';
  while (v > 0) {
    out = ALPHABET[v % 36] + out;
    v = Math.floor(v / 36);
  }
  return out;
}

function randomSuffix(len = 6): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 36];
  return out;
}

/** Generate a short bundle id. Pass a timestamp for deterministic tests. */
export function bundleId(now: number = Date.now()): string {
  return `${base36(now)}-${randomSuffix()}`;
}
