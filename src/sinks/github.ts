/**
 * GitHub issue sink (07, `--github [owner/repo]`).
 *
 * Two strategies, chosen at runtime:
 *  1. If the `gh` CLI is available, create the issue with the Markdown body
 *     passed as a FILE (`--body-file`) to avoid URL length limits.
 *  2. Otherwise, build a `https://github.com/<repo>/issues/new?...` URL. Because
 *     GitHub caps URL body length (~a few KB), the body is truncated to a safe
 *     size with a note that the full bundle is saved locally.
 *
 * The repo can be passed explicitly or inferred from `git remote get-url origin`
 * (both https and ssh forms). All I/O lives inside the returned Sink. The
 * Markdown renderer is injected per the 07 decoupling note. The sink never
 * throws: any failure resolves to `{ ok: false, ... }`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../util/exec.js';
import type { RedactedBundle, Sink, SinkResult } from '../types.js';

export interface GithubSinkOptions {
  /** Explicit `owner/repo`; inferred from the git origin remote if omitted. */
  repo?: string;
  /** Working directory used for git remote inference and `gh` invocation. */
  cwd: string;
  /** Injected Markdown renderer (pure: RedactedBundle -> string). */
  render: (b: RedactedBundle) => string;
}

/** Max title length before truncation (excluding the `[bug] ` prefix budget). */
const TITLE_MESSAGE_MAX = 80;

/**
 * Approximate ceiling on the full prefilled-issue URL. GitHub rejects very long
 * URLs; keep well under typical limits so the request actually goes through.
 */
const URL_MAX = 6000;

/**
 * Parse an `owner/repo` slug from a `git remote get-url origin` value. Handles:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 * Returns null if no GitHub-style owner/repo can be extracted.
 */
export function inferRepo(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  // scp-like ssh form: git@host:owner/repo(.git)
  const scp = /^[^@/]+@[^:/]+:([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (scp && scp[1]) return scp[1];

  // https:// or ssh:// forms: <scheme>://[user@]host/owner/repo(.git)
  const proto = /^[a-z]+:\/\/(?:[^@/]+@)?[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
    url,
  );
  if (proto && proto[1]) return proto[1];

  return null;
}

/** Build the issue title: `[bug] <error name>: <short message>`. */
export function buildIssueTitle(bundle: RedactedBundle): string {
  const error = bundle.crash.error;
  if (error) {
    const name = error.name || 'Error';
    const msg = truncate(firstLine(error.message), TITLE_MESSAGE_MAX);
    return msg ? `[bug] ${name}: ${msg}` : `[bug] ${name}`;
  }
  // No structured error: fall back to the crash kind.
  return `[bug] ${bundle.crash.kind}`;
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Build a prefilled `issues/new` URL, truncating the body if the full URL would
 * exceed URL_MAX. Exported for testing. When truncated, a trailing note tells
 * the reader the full bundle is saved locally.
 */
export function buildIssueUrl(
  repo: string,
  title: string,
  body: string,
): { url: string; truncated: boolean } {
  const base = `https://github.com/${repo}/issues/new`;
  const titleParam = `title=${encodeURIComponent(title)}`;

  const make = (b: string): string =>
    `${base}?${titleParam}&body=${encodeURIComponent(b)}`;

  const full = make(body);
  if (full.length <= URL_MAX) {
    return { url: full, truncated: false };
  }

  const note =
    '\n\n---\n*Body truncated — the full whatbroke bundle is saved locally.*';
  // Binary-search the largest body prefix that fits once the note is appended.
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(body.slice(0, mid) + note).length <= URL_MAX) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { url: make(body.slice(0, lo) + note), truncated: true };
}

/** True if the `gh` CLI is available and responds to `--version`. */
async function ghAvailable(cwd: string): Promise<boolean> {
  const res = await run('gh', ['--version'], { cwd });
  return res.code === 0;
}

async function resolveRepo(
  explicit: string | undefined,
  cwd: string,
): Promise<string | null> {
  if (explicit && explicit.trim()) return explicit.trim();
  const res = await run('git', ['remote', 'get-url', 'origin'], { cwd });
  if (res.code !== 0) return null;
  return inferRepo(res.stdout);
}

export function createGithubSink(opts: GithubSinkOptions): Sink {
  const { repo: explicitRepo, cwd, render } = opts;

  return async function githubSink(
    bundle: RedactedBundle,
  ): Promise<SinkResult> {
    const repo = await resolveRepo(explicitRepo, cwd);
    if (!repo) {
      return {
        sink: 'github',
        ok: false,
        message:
          'could not determine GitHub repo: pass owner/repo explicitly or run inside a repo with a github origin remote',
      };
    }

    const title = buildIssueTitle(bundle);
    const body = render(bundle);

    if (await ghAvailable(cwd)) {
      try {
        const dir = await mkdtemp(join(tmpdir(), 'whatbroke-gh-'));
        const bodyFile = join(dir, `whatbroke-${bundle.id}.md`);
        await writeFile(bodyFile, body, 'utf8');

        const res = await run(
          'gh',
          [
            'issue',
            'create',
            '--repo',
            repo,
            '--title',
            title,
            '--body-file',
            bodyFile,
          ],
          { cwd },
        );

        if (res.code === 0) {
          const url = extractIssueUrl(res.stdout);
          return {
            sink: 'github',
            ok: true,
            message: url ? `created issue ${url}` : 'created issue',
            ...(url ? { url } : {}),
          };
        }
        return {
          sink: 'github',
          ok: false,
          message: `gh issue create failed: ${
            res.stderr.trim() || `exit ${res.code}`
          }`,
        };
      } catch (err) {
        return {
          sink: 'github',
          ok: false,
          message: `gh issue create errored: ${String(err)}`,
        };
      }
    }

    // Fallback: prefilled issues/new URL (length-limited).
    const { url, truncated } = buildIssueUrl(repo, title, body);
    return {
      sink: 'github',
      ok: true,
      message: truncated
        ? 'built prefilled issue URL (body truncated; full bundle saved locally)'
        : 'built prefilled issue URL',
      url,
    };
  };
}

/** Pull the first github.com/.../issues/<n> URL out of `gh` stdout. */
function extractIssueUrl(stdout: string): string | undefined {
  const m = /https:\/\/github\.com\/\S+\/issues\/\d+/.exec(stdout);
  return m ? m[0] : undefined;
}
