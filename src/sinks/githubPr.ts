/**
 * GitHub PR comment sink (roadmap 2.2, `--github-pr`).
 *
 * Posts a single STICKY comment on the pull request: the body always starts
 * with the hidden marker `<!-- whatbroke-sticky -->`; on every run the sink
 * lists the PR's comments, finds the FIRST one carrying the marker and updates
 * it in place — only when none exists is a new comment created. Re-runs
 * therefore never spam a second comment.
 *
 * Transport is a tiny injectable seam (`PrTransport`) so tests never touch the
 * network. The default transport is chosen at call time:
 *   1. `gh api` (via the repo's spawn helper) when the `gh` CLI is on PATH —
 *      it brings its own auth;
 *   2. otherwise raw `fetch` against https://api.github.com authorized with
 *      `GITHUB_TOKEN` (or `GH_TOKEN`).
 * PR context for the default transport is resolved from opts or the standard
 * Actions env: owner/repo from `opts.repo` / `GITHUB_REPOSITORY`; PR number
 * from `opts.prNumber` / `GITHUB_REF` (refs/pull/<n>/…) / the
 * `GITHUB_EVENT_PATH` payload (`pull_request.number`).
 *
 * The comment body is deliberately compact (headline, top-3 suspects,
 * diff-vs-green line, `npx whatbroke show <id>`), NOT the full Markdown bundle
 * render — `renderPrComment` is self-contained and exported for tests.
 *
 * The sink NEVER throws: every failure (no PR context, missing token,
 * transport/API error) resolves to `{ sink: 'github-pr', ok: false, message }`
 * so a red CI run is never made redder by the comment step.
 */
import { readFile } from 'node:fs/promises';

import { run } from '../util/exec.js';
import type {
  CrashInfo,
  GitInfo,
  RedactedBundle,
  Sink,
  SinkResult,
  SuspectFile,
} from '../types.js';

/** Hidden HTML marker identifying whatbroke's sticky comment. STABLE — changing it orphans existing comments. */
export const STICKY_MARKER = '<!-- whatbroke-sticky -->';

const SINK_NAME = 'github-pr';

/** Max suspects shown in the comment. */
const MAX_SUSPECTS = 3;

/** Max headline message length before truncation. */
const HEADLINE_MESSAGE_MAX = 120;

/**
 * Comments fetched per list call. The sticky comment is posted by us, so it is
 * effectively always within the first page; we deliberately avoid `--paginate`
 * (multi-array output is awkward to parse portably across gh versions).
 */
const LIST_PER_PAGE = 100;

/** Minimal comment API used by the sink; injectable so tests mock it. */
export interface PrTransport {
  listComments(): Promise<Array<{ id: number; body: string }>>;
  createComment(body: string): Promise<{ url?: string }>;
  updateComment(id: number, body: string): Promise<{ url?: string }>;
}

export interface GithubPrSinkOptions {
  /** Working directory used for `gh` invocation. */
  cwd: string;
  /** Explicit `owner/repo`; falls back to the GITHUB_REPOSITORY env var. */
  repo?: string;
  /** Explicit PR number; falls back to GITHUB_REF / GITHUB_EVENT_PATH. */
  prNumber?: number;
  /** Injected transport (tests). When present, repo/PR resolution is skipped. */
  transport?: PrTransport;
}

// ── comment body ─────────────────────────────────────────────────────────────

/**
 * Render the compact sticky-comment Markdown for a redacted bundle.
 * Self-contained on purpose: the full `renderMarkdown` bundle report is far too
 * long for a PR comment (and lives in a collapsible step summary instead).
 */
export function renderPrComment(bundle: RedactedBundle): string {
  const parts: string[] = [
    STICKY_MARKER,
    renderHeadline(bundle.crash),
    renderSuspects(bundle.repro.suspects),
    renderDiffVsGreen(bundle.git),
    [
      'Inspect the full bundle locally:',
      '',
      '```',
      `npx whatbroke show ${bundle.id}`,
      '```',
    ].join('\n'),
    `<sub>whatbroke · bundle \`${bundle.id}\` · confidence: ${bundle.repro.confidence} · updated on every red run</sub>`,
  ];
  return parts.join('\n\n') + '\n';
}

/** H3 headline: error name + first-line message, or the crash kind. */
function renderHeadline(crash: CrashInfo): string {
  if (crash.error) {
    const name = crash.error.name || 'Error';
    const msg = truncate(oneLine(crash.error.message), HEADLINE_MESSAGE_MAX);
    return msg ? `### ${name}: ${msg}` : `### ${name}`;
  }
  let detail: string;
  if (crash.signal) {
    detail = `terminated by signal ${crash.signal}`;
  } else if (crash.exitCode !== null) {
    detail = `exited with code ${crash.exitCode}`;
  } else {
    detail = 'crashed';
  }
  return `### ${crash.kind}: ${detail}`;
}

/** Up to MAX_SUSPECTS ranked suspects, each with its score and first reason. */
function renderSuspects(suspects: SuspectFile[]): string {
  if (suspects.length === 0) {
    return '**Top suspects**\n\n_None identified._';
  }
  const lines = suspects.slice(0, MAX_SUSPECTS).map((s, i) => {
    const first = s.reasons[0];
    const why = first ? ` — ${oneLine(first)}` : '';
    return `${i + 1}. \`${s.path}\` (score ${s.score})${why}`;
  });
  return ['**Top suspects**', '', ...lines].join('\n');
}

/** One line about the diff vs the last green run (or why there isn't one). */
function renderDiffVsGreen(git: GitInfo): string {
  if (git.diffVsGreen) {
    const base = git.diffVsGreen.base.slice(0, 7);
    const trunc = git.diffVsGreen.truncated ? ', truncated' : '';
    return `**Diff vs green:** base \`${base}\`${trunc} — see the bundle for the patch.`;
  }
  if (git.greenRef) {
    return `**Diff vs green:** base \`${git.greenRef.slice(0, 7)}\` — no diff captured.`;
  }
  return '**Diff vs green:** unavailable — no green baseline recorded yet.';
}

/** Collapse whitespace so a value stays on one Markdown line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

// ── PR context resolution (default transport only) ───────────────────────────

function resolveRepoSlug(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const candidate = (explicit ?? env.GITHUB_REPOSITORY ?? '').trim();
  if (!candidate) return null;
  return /^[^/\s]+\/[^/\s]+$/.test(candidate) ? candidate : null;
}

async function resolvePrNumber(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  // Actions sets GITHUB_REF to refs/pull/<n>/merge on pull_request events.
  const ref = env.GITHUB_REF;
  if (ref) {
    const m = /^refs\/pull\/(\d+)\//.exec(ref);
    if (m && m[1]) return Number(m[1]);
  }
  // Fall back to the event payload (pull_request.number).
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const raw = await readFile(eventPath, 'utf8');
      const event = JSON.parse(raw) as { pull_request?: { number?: unknown } };
      const n = event.pull_request?.number;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
    } catch {
      // unreadable / unparsable event payload: fall through to null
    }
  }
  return null;
}

// ── default transports ───────────────────────────────────────────────────────

/** True if the `gh` CLI is available and responds to `--version`. */
async function ghAvailable(cwd: string): Promise<boolean> {
  const res = await run('gh', ['--version'], { cwd });
  return res.code === 0;
}

/** Extract the comment URL from a GitHub API comment JSON payload. */
function commentUrl(payload: unknown): { url?: string } {
  const url = (payload as { html_url?: unknown } | null)?.html_url;
  return typeof url === 'string' && url ? { url } : {};
}

function toCommentList(payload: unknown): Array<{ id: number; body: string }> {
  if (!Array.isArray(payload)) {
    throw new Error('unexpected GitHub API response: expected a comment array');
  }
  const out: Array<{ id: number; body: string }> = [];
  for (const c of payload as Array<{ id?: unknown; body?: unknown }>) {
    if (typeof c?.id === 'number') {
      out.push({ id: c.id, body: typeof c.body === 'string' ? c.body : '' });
    }
  }
  return out;
}

/** Transport backed by `gh api` (auth handled by gh itself). */
function createGhCliTransport(
  repo: string,
  prNumber: number,
  cwd: string,
): PrTransport {
  const api = async (args: string[], input?: string): Promise<unknown> => {
    const res = await run('gh', ['api', ...args], {
      cwd,
      ...(input !== undefined ? { input } : {}),
    });
    if (res.code !== 0) {
      throw new Error(`gh api failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    try {
      return JSON.parse(res.stdout) as unknown;
    } catch {
      throw new Error('gh api returned unparsable JSON');
    }
  };

  return {
    async listComments() {
      const payload = await api([
        `repos/${repo}/issues/${prNumber}/comments?per_page=${LIST_PER_PAGE}`,
      ]);
      return toCommentList(payload);
    },
    async createComment(body: string) {
      // Body travels over stdin (--input -) so size/quoting never hits argv limits.
      const payload = await api(
        ['--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '--input', '-'],
        JSON.stringify({ body }),
      );
      return commentUrl(payload);
    },
    async updateComment(id: number, body: string) {
      const payload = await api(
        ['--method', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', '-'],
        JSON.stringify({ body }),
      );
      return commentUrl(payload);
    },
  };
}

/** Transport backed by raw fetch + GITHUB_TOKEN (no gh CLI present). */
function createFetchTransport(
  repo: string,
  prNumber: number,
  token: string,
): PrTransport {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'whatbroke',
      'x-github-api-version': '2022-11-28',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(
        `GitHub API ${method} ${path} responded ${res.status}${text ? `: ${text}` : ''}`,
      );
    }
    return (await res.json()) as unknown;
  };

  return {
    async listComments() {
      const payload = await call(
        'GET',
        `/repos/${repo}/issues/${prNumber}/comments?per_page=${LIST_PER_PAGE}`,
      );
      return toCommentList(payload);
    },
    async createComment(body: string) {
      const payload = await call(
        'POST',
        `/repos/${repo}/issues/${prNumber}/comments`,
        { body },
      );
      return commentUrl(payload);
    },
    async updateComment(id: number, body: string) {
      const payload = await call('PATCH', `/repos/${repo}/issues/comments/${id}`, {
        body,
      });
      return commentUrl(payload);
    },
  };
}

type TransportResolution = { transport: PrTransport } | { error: string };

async function resolveDefaultTransport(
  opts: GithubPrSinkOptions,
  env: NodeJS.ProcessEnv,
): Promise<TransportResolution> {
  const repo = resolveRepoSlug(opts.repo, env);
  const prNumber = await resolvePrNumber(opts.prNumber, env);

  const missing: string[] = [];
  if (!repo) missing.push('repo (pass owner/repo or set GITHUB_REPOSITORY)');
  if (prNumber === null) {
    missing.push(
      'PR number (pass it explicitly or run in a pull_request workflow so GITHUB_REF/GITHUB_EVENT_PATH identify the PR)',
    );
  }
  if (missing.length > 0 || !repo || prNumber === null) {
    return { error: `no PR context: missing ${missing.join(' and ')}` };
  }

  if (await ghAvailable(opts.cwd)) {
    return { transport: createGhCliTransport(repo, prNumber, opts.cwd) };
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    return {
      error:
        'no GitHub credentials: gh CLI not found on PATH and GITHUB_TOKEN is not set',
    };
  }
  return { transport: createFetchTransport(repo, prNumber, token) };
}

// ── the sink ─────────────────────────────────────────────────────────────────

export function createGithubPrSink(opts: GithubPrSinkOptions): Sink {
  return async function githubPrSink(
    bundle: RedactedBundle,
  ): Promise<SinkResult> {
    try {
      const resolved: TransportResolution = opts.transport
        ? { transport: opts.transport }
        : await resolveDefaultTransport(opts, process.env);
      if ('error' in resolved) {
        return { sink: SINK_NAME, ok: false, message: resolved.error };
      }

      const body = renderPrComment(bundle);
      const comments = await resolved.transport.listComments();
      const existing = comments.find((c) => c.body.includes(STICKY_MARKER));

      if (existing) {
        const { url } = await resolved.transport.updateComment(existing.id, body);
        return {
          sink: SINK_NAME,
          ok: true,
          message: url
            ? `updated sticky PR comment ${url}`
            : 'updated sticky PR comment',
          ...(url ? { url } : {}),
        };
      }

      const { url } = await resolved.transport.createComment(body);
      return {
        sink: SINK_NAME,
        ok: true,
        message: url
          ? `posted sticky PR comment ${url}`
          : 'posted sticky PR comment',
        ...(url ? { url } : {}),
      };
    } catch (err) {
      // Never throw: a failed comment must not fail the build.
      const why = err instanceof Error ? err.message : String(err);
      return {
        sink: SINK_NAME,
        ok: false,
        message: `posting PR comment failed: ${why}`,
      };
    }
  };
}
