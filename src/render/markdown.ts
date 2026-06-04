/**
 * Markdown renderer (07).
 *
 * Pure `(RedactedBundle) => string`. No I/O. Produces valid GitHub-flavored
 * Markdown following the render contract in 02-bundle-schema.md:
 *
 *   1. Summary          (always open, not folded)
 *   2. Repro steps      ┐
 *   3. Suspect files    │
 *   4. Error + stack    │ each wrapped in <details>
 *   5. Environment      │
 *   6. Git context      │
 *   7. Dependencies     │
 *   8. Logs             ┘
 *   9. Redaction footer (always visible — the trust mechanism)
 *
 * Sections degrade gracefully: an empty section is omitted (or carries a short
 * note explaining why). The content is already redacted upstream, so there are
 * no secret concerns; outside code fences we only take care not to break
 * Markdown structure.
 */
import type {
  RedactedBundle,
  CrashInfo,
  ErrorInfo,
  StackFrame,
  ReproStep,
  SuspectFile,
  EnvInfo,
  GitInfo,
  DepInfo,
  LogInfo,
  RedactionReport,
} from '../types.js';

export function renderMarkdown(bundle: RedactedBundle): string {
  const parts: string[] = [];

  parts.push(renderSummary(bundle.crash, bundle.repro.confidence));

  const repro = renderRepro(bundle.repro.steps);
  if (repro) parts.push(details('🔁 Repro steps', repro));

  const suspects = renderSuspects(bundle.repro.suspects);
  if (suspects) parts.push(details('🎯 Suspect files', suspects));

  const stack = renderErrorAndStack(bundle.crash);
  if (stack) parts.push(details('🧨 Error + stack', stack));

  parts.push(details('🖥️ Environment', renderEnvironment(bundle.environment)));

  parts.push(details('🌿 Git context', renderGit(bundle.git)));

  const deps = renderDependencies(bundle.dependencies);
  if (deps) parts.push(details('📦 Relevant dependencies', deps));

  const logs = renderLogs(bundle.logs);
  if (logs) parts.push(details('📜 Logs', logs));

  const diagnostics = renderDiagnostics(bundle.collectorErrors);
  if (diagnostics) parts.push(details('🩺 whatbroke diagnostics', diagnostics));

  parts.push(renderRedactionFooter(bundle.redaction));

  return parts.join('\n\n') + '\n';
}

// ── 1. Summary ────────────────────────────────────────────────────────────────

function renderSummary(crash: CrashInfo, confidence: string): string {
  if (crash.error) {
    const { name, message } = crash.error;
    const frame = topUserFrame(crash.error.stack);
    const where = frame ? ` — first app frame ${frameLocation(frame)}` : '';
    const msg = oneLine(message);
    return `## 🐛 ${name}: ${msg}${where} · confidence: ${confidence}`;
  }

  // No structured error: signal / nonzero-exit / etc. Summarize the crash kind.
  let detail: string;
  if (crash.signal) {
    detail = `terminated by signal ${crash.signal}`;
  } else if (crash.exitCode !== null) {
    detail = `exited with code ${crash.exitCode}`;
  } else {
    detail = 'crashed';
  }
  return `## 🐛 ${crash.kind}: ${detail} · confidence: ${confidence}`;
}

function topUserFrame(stack: StackFrame[]): StackFrame | null {
  for (const f of stack) {
    if (f.isUserCode) return f;
  }
  return null;
}

function frameLocation(f: StackFrame): string {
  const file = f.fileRelative ?? f.file ?? '<unknown>';
  if (f.line !== null) {
    return f.column !== null ? `${file}:${f.line}:${f.column}` : `${file}:${f.line}`;
  }
  return file;
}

// ── 2. Repro steps ──────────────────────────────────────────────────────────

function renderRepro(steps: ReproStep[]): string | null {
  if (steps.length === 0) return null;
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  const lines = ordered.map((s) => `${s.order}. ${oneLine(s.text)} _(${s.provenance})_`);
  return lines.join('\n');
}

// ── 3. Suspect files ──────────────────────────────────────────────────────────

function renderSuspects(suspects: SuspectFile[]): string | null {
  if (suspects.length === 0) return null;
  const header = '| path | score | reasons |\n| --- | --- | --- |';
  const rows = suspects.map((s) => {
    const reasons = s.reasons.length > 0 ? s.reasons.map(cell).join('; ') : '—';
    return `| ${cell(s.path)} | ${s.score} | ${reasons} |`;
  });
  return [header, ...rows].join('\n');
}

// ── 4. Error + stack ──────────────────────────────────────────────────────────

function renderErrorAndStack(crash: CrashInfo): string | null {
  const error: ErrorInfo | undefined = crash.error;
  if (!error) {
    // No structured error — but a test failure may carry detail worth showing.
    const tf = renderTestFailure(crash);
    return tf;
  }

  const out: string[] = [];
  out.push(`**${error.name}**: ${oneLine(error.message)}`);

  const tf = renderTestFailure(crash);
  if (tf) out.push(tf);

  const userFrames = error.stack.filter((f) => f.isUserCode);
  const libFrames = error.stack.filter((f) => !f.isUserCode);

  if (error.stack.length > 0) {
    const lines = userFrames.map(formatFrame);
    if (libFrames.length > 0) {
      lines.push(`(${libFrames.length} library frame${libFrames.length === 1 ? '' : 's'} hidden)`);
    }
    out.push(fence('', lines.join('\n')));

    if (libFrames.length > 0) {
      const libBlock = fence('', libFrames.map(formatFrame).join('\n'));
      out.push(details(`Library / node-internal frames (${libFrames.length})`, libBlock));
    }
  } else if (error.rawStack.trim().length > 0) {
    out.push(fence('', error.rawStack.trim()));
  }

  return out.join('\n\n');
}

function formatFrame(f: StackFrame): string {
  const fn = f.functionName ?? '<anonymous>';
  return `  at ${fn} (${frameLocation(f)})`;
}

function renderTestFailure(crash: CrashInfo): string | null {
  const tf = crash.testFailure;
  if (!tf) return null;
  const lines: string[] = [];
  const counts: string[] = [];
  if (tf.total !== undefined) counts.push(`${tf.total} total`);
  if (tf.passed !== undefined) counts.push(`${tf.passed} passed`);
  if (tf.failed !== undefined) counts.push(`${tf.failed} failed`);
  const countStr = counts.length > 0 ? ` (${counts.join(', ')})` : '';
  lines.push(`**Test failure** — runner: \`${tf.runner}\`${countStr}`);
  for (const t of tf.failingTests) {
    const loc = t.file ? ` _(${t.file})_` : '';
    const msg = t.message ? ` — ${oneLine(t.message)}` : '';
    lines.push(`- ${cell(t.id)}${loc}${msg}`);
  }
  return lines.join('\n');
}

// ── 5. Environment ──────────────────────────────────────────────────────────

function renderEnvironment(env: EnvInfo): string {
  const lines: string[] = [];
  lines.push(`- **OS**: ${env.os.platform} ${env.os.release} (${env.os.arch})`);
  const v8val = env.runtime.details?.v8 ?? env.runtime.v8;
  const v8 = v8val ? `, v8 ${v8val}` : '';
  // Prefer name/version; fall back to the deprecated `node` alias so bundles
  // written before v0.2 still render.
  const rtName = env.runtime.name || (env.runtime.node ? 'node' : 'unknown');
  const rtVersion = env.runtime.version || env.runtime.node || '';
  const version = rtVersion ? ` ${rtVersion}` : '';
  lines.push(`- **Runtime**: ${rtName}${version}${v8}`);
  const pmVersion = env.packageManager.version ?? 'unknown';
  lines.push(`- **Package manager**: ${env.packageManager.name} ${pmVersion}`);
  lines.push(`- **cwd**: \`${env.cwd}\``);
  return lines.join('\n');
}

// ── 6. Git context ──────────────────────────────────────────────────────────

function renderGit(git: GitInfo): string {
  if (!git.isRepo) {
    return git.note ? `_${oneLine(git.note)}_` : '_Not a git repository._';
  }

  const out: string[] = [];
  const branch = git.branch ?? '(detached)';
  const head = git.head ? git.head.slice(0, 7) : '(unknown)';
  const dirty = git.dirty ? ' (dirty)' : '';
  out.push(`**${branch} @ ${head}**${dirty}`);

  if (git.changedFiles.length > 0) {
    const files = git.changedFiles
      .map((f) => `- \`${f.status}\` ${cell(f.path)}`)
      .join('\n');
    out.push(`Changed files (${git.changedFiles.length}):\n${files}`);
  } else {
    out.push('_No uncommitted changes._');
  }

  if (git.diffVsGreen && git.diffVsGreen.patch.trim().length > 0) {
    const base = git.diffVsGreen.base.slice(0, 7);
    const trunc = git.diffVsGreen.truncated ? ' — truncated' : '';
    out.push(`Diff vs green (base ${base}${trunc}):`);
    out.push(fence('diff', git.diffVsGreen.patch));
  } else if (git.greenRef) {
    out.push(`_No diff vs green (base ${git.greenRef.slice(0, 7)})._`);
  }

  return out.join('\n\n');
}

// ── 7. Relevant dependencies ──────────────────────────────────────────────────

function renderDependencies(deps: DepInfo): string | null {
  const entries = Object.entries(deps.relevantResolved);
  if (entries.length === 0) return null;
  const header = '| package | version |\n| --- | --- |';
  const rows = entries.map(([name, version]) => `| ${cell(name)} | ${cell(version)} |`);
  const table = [header, ...rows].join('\n');
  return `${table}\n\n_Lockfile: ${deps.lockfile}._`;
}

// ── 8. Logs ────────────────────────────────────────────────────────────────

function renderLogs(logs: LogInfo): string | null {
  const out: string[] = [];
  const stdout = logs.stdoutTail.trim();
  const stderr = logs.stderrTail.trim();

  if (stdout.length > 0) {
    out.push('**stdout** (tail):');
    out.push(fence('', logs.stdoutTail.replace(/\n+$/, '')));
  }
  if (stderr.length > 0) {
    out.push('**stderr** (tail):');
    out.push(fence('', logs.stderrTail.replace(/\n+$/, '')));
  }

  if (out.length === 0) return null;

  if (logs.truncated) {
    out.push(`_Output truncated to the last ${logs.bufferLines} lines per stream._`);
  }
  return out.join('\n\n');
}

// ── whatbroke diagnostics (only when something degraded) ──────────────────────--

function renderDiagnostics(errors: { collector: string; error: string }[]): string | null {
  if (!errors || errors.length === 0) return null;
  const lines = [
    '_These are whatbroke’s own non-fatal failures — the bundle still shipped, but a',
    'collector degraded. Useful for diagnosing whatbroke itself (run with `WHATBROKE_DEBUG=1`',
    'for stacks)._',
    '',
    ...errors.map((e) => `- **${cell(e.collector)}**: ${oneLine(e.error)}`),
  ];
  return lines.join('\n');
}

// ── 9. Redaction footer ──────────────────────────────────────────────────────

function renderRedactionFooter(redaction: RedactionReport): string {
  if (redaction.redactedCount === 0) {
    return '_No secrets detected._';
  }
  const ruleNames = redaction.rules.filter((r) => r.hits > 0).map((r) => r.rule);
  const n = redaction.redactedCount;
  const noun = n === 1 ? 'value' : 'values';
  if (ruleNames.length === 0) {
    return `_${n} ${noun} redacted._`;
  }
  return `_${n} ${noun} redacted by rules ${ruleNames.join(', ')}._`;
}

// ── helpers ────────────────────────────────────────────────────────────────

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** Fenced code block. Picks a backtick run longer than any inside the content. */
function fence(lang: string, body: string): string {
  let ticks = 3;
  const runs = body.match(/`+/g);
  if (runs) {
    for (const r of runs) {
      if (r.length >= ticks) ticks = r.length + 1;
    }
  }
  const f = '`'.repeat(ticks);
  return `${f}${lang}\n${body}\n${f}`;
}

/** Collapse newlines/extra whitespace so a value stays on one Markdown line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Escape pipe and newline so a value is safe inside a Markdown table cell. */
function cell(s: string): string {
  return oneLine(s).replace(/\|/g, '\\|');
}
