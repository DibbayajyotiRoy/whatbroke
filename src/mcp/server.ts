/**
 * whatbroke MCP server (08): the primary delivery surface.
 *
 * A read-only stdio MCP server that lets a coding agent read whatbroke's persisted
 * bundles directly. It reads `RedactedBundle` JSON via a `BundleStore`, parses,
 * and serves. It computes nothing and makes no LLM/network calls.
 *
 * The ONE deliberate exception to read-only (ADR-0002): `verify_fix` re-runs a
 * bundle's OWN captured argv — never a caller-supplied command; there is no
 * input through which an MCP caller can influence what gets executed beyond
 * choosing which bundle to verify.
 *
 * Tools return focused payloads so the agent can pull the conclusion without the
 * whole blob. `id` defaults to the latest crash bundle everywhere. Tools that
 * surface file references include the bundle's captured `git.head` so the agent
 * knows the revision; the server never silently re-resolves against the working
 * tree (staleness is the agent's to reconcile).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as path from 'node:path';
import { BundleStore } from './store.js';
import { verifyBundle, VerifyError, DEFAULT_VERIFY_TIMEOUT_MS } from '../verify/verify.js';
import { HistoryIndex, historyPath } from '../history/history.js';
import { crashFingerprint } from '../repro/fingerprint.js';
import type { RedactedBundle } from '../types.js';

export interface StartMcpServerOptions {
  bundlesDir: string;
  /** Project root; enables verify_fix (defaults derived from bundlesDir's project). */
  projectCwd?: string;
  /** Custom bundles dir (mirrors --out) so verify writes where the store reads. */
  out?: string;
}

/** Standard text tool result. */
function textResult(payload: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/** A "nothing found" message (returned as text, never thrown). */
function notFound(id: string | undefined): { content: [{ type: 'text'; text: string }] } {
  const which = id === undefined ? 'latest bundle' : `bundle "${id}"`;
  return {
    content: [{ type: 'text', text: `No ${which} found in the whatbroke bundles directory.` }],
  };
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  const store = new BundleStore(opts.bundlesDir);

  const server = new McpServer({ name: 'whatbroke', version: '0.1.0' });

  // ── Tools ────────────────────────────────────────────────────────────────

  server.registerTool(
    'list_bundles',
    {
      title: 'List crash bundles',
      description:
        'List recent whatbroke crash bundles, most-recent-first. Returns id, createdAt, ' +
        'a one-line error summary, and confidence. Call this first to discover which ' +
        'bundles exist and find a specific bundle id to pass to the other tools.',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => {
      const bundles = await store.list(limit);
      return textResult({ bundles });
    },
  );

  server.registerTool(
    'get_bundle',
    {
      title: 'Get full bundle',
      description:
        'Get the full RedactedBundle JSON (crash, environment, dependencies, git, logs, ' +
        'repro). Use when you need the complete captured context; for a quick start prefer ' +
        'get_suspects. Defaults to the latest crash bundle when id is omitted.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      const bundle = await store.get(id);
      if (!bundle) return notFound(id);
      return textResult(bundle);
    },
  );

  server.registerTool(
    'get_suspects',
    {
      title: 'Get ranked suspect files',
      description:
        'The most likely files responsible for the latest crash, ranked, with ' +
        'deterministic reasons — start here before reading the full bundle. Returns ' +
        'suspects (path, score, reasons), overall confidence, and the captured git.head ' +
        'so you know which revision the paths refer to. Defaults to the latest bundle.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      const bundle = await store.get(id);
      if (!bundle) return notFound(id);
      return textResult({
        suspects: bundle.repro?.suspects ?? [],
        confidence: bundle.repro?.confidence ?? 'unknown',
        head: bundle.git?.head ?? null,
      });
    },
  );

  server.registerTool(
    'get_diff_vs_green',
    {
      title: 'Get diff since last green',
      description:
        'The unified diff between the last known-good (green) commit and the repo state at ' +
        'crash time, plus the base sha. Use to see exactly what changed and likely ' +
        'introduced the failure. Defaults to the latest bundle.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      const bundle = await store.get(id);
      if (!bundle) return notFound(id);
      const diff = bundle.git?.diffVsGreen;
      if (!diff) {
        return textResult({
          note: 'No diff-vs-green captured for this bundle (no green ref, not a git repo, or no changes).',
          head: bundle.git?.head ?? null,
        });
      }
      return textResult({
        base: diff.base,
        truncated: diff.truncated,
        patch: diff.patch,
        head: bundle.git?.head ?? null,
      });
    },
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Get redacted log tail',
      description:
        'The redacted tail of the crashed process output (stdout + stderr). Optionally pass ' +
        'grep to keep only lines containing that substring (case-insensitive). Use to read ' +
        'the failure output without pulling the whole bundle. Defaults to the latest bundle.',
      inputSchema: { id: z.string().optional(), grep: z.string().optional() },
    },
    async ({ id, grep }) => {
      const bundle = await store.get(id);
      if (!bundle) return notFound(id);
      const logs = bundle.logs;
      const filter = (text: string): string => {
        if (!grep) return text;
        const needle = grep.toLowerCase();
        return text
          .split('\n')
          .filter((line) => line.toLowerCase().includes(needle))
          .join('\n');
      };
      return textResult({
        stdoutTail: filter(logs?.stdoutTail ?? ''),
        stderrTail: filter(logs?.stderrTail ?? ''),
        truncated: logs?.truncated ?? false,
        ...(grep ? { grep } : {}),
      });
    },
  );

  server.registerTool(
    'get_repro',
    {
      title: 'Get reproduction steps',
      description:
        'The ordered, deterministic steps to reproduce the crash, with provenance for each ' +
        'step. Use to understand how to trigger the failure. Defaults to the latest bundle.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      const bundle = await store.get(id);
      if (!bundle) return notFound(id);
      return textResult({
        steps: bundle.repro?.steps ?? [],
        confidence: bundle.repro?.confidence ?? 'unknown',
      });
    },
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get prior occurrences of a crash',
      description:
        'Crash history for a fingerprint or bundle id (defaults to the latest ' +
        "bundle's crash): prior occurrences, whether it was resolved, by which " +
        'commit touching which files, and a flaky annotation when the same ' +
        'fingerprint has both green and crashing runs at the same commit. ' +
        'Read-only, served from the local .whatbroke/index.json.',
      inputSchema: {
        id: z.string().optional(),
        fingerprint: z.string().optional(),
      },
    },
    async ({ id, fingerprint }) => {
      let fp = fingerprint;
      if (fp === undefined) {
        const bundle = await store.get(id);
        if (!bundle) return notFound(id);
        fp = crashFingerprint(bundle.crash);
      }
      // The index lives in .whatbroke/ next to the journal, even when bundles
      // are redirected via --out.
      const storeDir = opts.projectCwd
        ? path.join(opts.projectCwd, '.whatbroke')
        : path.dirname(opts.bundlesDir);
      const history = await HistoryIndex.open(historyPath(storeDir));
      const entry = history.entry(fp);
      if (!entry) {
        return textResult({ fingerprint: fp, note: 'No prior occurrences of this crash.' });
      }
      return textResult({ fingerprint: fp, ...entry });
    },
  );

  if (opts.projectCwd !== undefined) {
    const projectCwd = opts.projectCwd;
    server.registerTool(
      'verify_fix',
      {
        title: 'Verify a fix by re-running the captured command',
        description:
          "Re-run the bundle's OWN captured command (never a caller-supplied one; " +
          'ADR-0002) and report whether the crash is fixed. Returns status ' +
          "'fixed' | 'same-failure' | 'different-failure', a crash delta with " +
          'reasons when still failing, and newBundleId on a different failure so ' +
          'you can iterate. On fixed, the bundle is marked resolved and the green ' +
          'run is recorded. Defaults to the latest bundle. The typical loop: ' +
          'get_suspects → edit code → verify_fix → repeat until fixed.',
        inputSchema: {
          id: z.string().optional(),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .max(30 * 60 * 1000)
            .optional(),
        },
      },
      async ({ id, timeoutMs }) => {
        try {
          const vOpts: Parameters<typeof verifyBundle>[0] = { projectCwd };
          if (id !== undefined) vOpts.id = id;
          if (opts.out !== undefined) vOpts.out = opts.out;
          vOpts.timeoutMs = timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
          const outcome = await verifyBundle(vOpts);
          const payload: Record<string, unknown> = {
            status: outcome.status,
            bundleId: outcome.bundleId,
            exitCode: outcome.exitCode,
          };
          if (outcome.delta) payload['delta'] = outcome.delta;
          if (outcome.newBundleId) payload['newBundleId'] = outcome.newBundleId;
          if (outcome.resolvedCommit) payload['resolvedCommit'] = outcome.resolvedCommit;
          return textResult(payload);
        } catch (err) {
          if (err instanceof VerifyError) {
            return textResult({ error: { kind: err.kind, message: err.message } });
          }
          return textResult({ error: { kind: 'internal', message: String(err) } });
        }
      },
    );
  }

  // ── Resources (mirror high-value tools; same store) ────────────────────────

  /** Resource read result for a single bundle (or a not-found note). */
  const bundleResource = (uri: URL, bundle: RedactedBundle | null) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: bundle
          ? JSON.stringify(bundle, null, 2)
          : JSON.stringify({ note: 'No matching bundle found.' }, null, 2),
      },
    ],
  });

  server.registerResource(
    'latest-bundle',
    'whatbroke://bundle/latest',
    {
      title: 'Latest bundle',
      description: 'The full RedactedBundle JSON for the most recent crash.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const bundle = await store.get();
      return bundleResource(uri, bundle);
    },
  );

  server.registerResource(
    'bundle-by-id',
    new ResourceTemplate('whatbroke://bundle/{id}', { list: undefined }),
    {
      title: 'Bundle by id',
      description: 'The full RedactedBundle JSON for a specific bundle id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = Array.isArray(raw) ? raw[0] : raw;
      const bundle = await store.get(typeof id === 'string' ? id : undefined);
      return bundleResource(uri, bundle);
    },
  );

  server.registerResource(
    'latest-suspects',
    'whatbroke://suspects/latest',
    {
      title: 'Latest suspects',
      description:
        'Ranked suspect files for the most recent crash, with reasons, confidence, and the ' +
        'captured git.head revision.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const bundle = await store.get();
      const payload = bundle
        ? {
            suspects: bundle.repro?.suspects ?? [],
            confidence: bundle.repro?.confidence ?? 'unknown',
            head: bundle.git?.head ?? null,
          }
        : { note: 'No latest bundle found.' };
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
