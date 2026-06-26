/**
 * whatbroke VS Code extension — read-only crash-bundle viewer (spec 09, thin tier).
 *
 * Core invariant: the extension computes nothing. A FileSystemWatcher on
 * `**​/.whatbroke/bundles/*.json` (plus the journal) reloads the latest gated
 * bundle and refreshes the views. Data flows one way: watch → parse → render.
 * The brain stays in the CLI; redaction holds because only persisted (already
 * gated) bundles are ever read.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  errorSummary,
  greenSinceBundle,
  isLocationStale,
  loadLatest,
  toFsPath,
  topUserFrame,
  userFrames,
  type Bundle,
  type LatestBundle,
} from './bundle.js';
import { BundleTreeProvider } from './tree.js';

const DIAGNOSTIC_SOURCE = 'whatbroke';

/** Everything the views/decorations need for the current workspace state. */
interface State {
  workspaceRoot: string;
  latest: LatestBundle | null;
  /** A green run happened after this crash → treat as resolved. */
  resolvedByGreen: boolean;
}

let current: State | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const tree = new BundleTreeProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection('whatbroke');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'whatbroke.openLatestBundle';

  const codeLens = new SuspectCodeLensProvider();
  const codeLensReg = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('whatbroke.bundle', tree),
    diagnostics,
    statusBar,
    codeLensReg,
  );

  const refresh = async (): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      current = null;
      tree.update('', null);
      diagnostics.clear();
      codeLens.update('', null);
      statusBar.hide();
      return;
    }
    const workspaceRoot = folder.uri.fsPath;
    const latest = await loadLatest(workspaceRoot);
    const resolvedByGreen = latest ? await greenSinceBundle(workspaceRoot, latest.bundle) : false;
    current = { workspaceRoot, latest, resolvedByGreen };

    tree.update(workspaceRoot, latest);
    await renderDiagnostics(workspaceRoot, latest, resolvedByGreen, diagnostics);
    codeLens.update(workspaceRoot, resolvedByGreen ? null : latest);
    renderStatusBar(statusBar, latest, resolvedByGreen);
  };

  // ── File watcher: bundles + journal (journal mtime signals a green run) ────
  const watcher = vscode.workspace.createFileSystemWatcher('**/.whatbroke/{bundles/*.json,journal.json}');
  watcher.onDidCreate(() => void refresh());
  watcher.onDidChange(() => void refresh());
  watcher.onDidDelete(() => void refresh());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('whatbroke')) void refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
  );

  registerCommands(context, () => current, refresh);

  void refresh();
}

export function deactivate(): void {
  current = null;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function renderDiagnostics(
  workspaceRoot: string,
  latest: LatestBundle | null,
  resolvedByGreen: boolean,
  collection: vscode.DiagnosticCollection,
): Promise<void> {
  collection.clear();
  if (!latest || resolvedByGreen) return; // green run since → clear the squiggle
  if (!vscode.workspace.getConfiguration('whatbroke').get<boolean>('diagnostics.enabled', true)) return;

  const bundle = latest.bundle;
  const frame = topUserFrame(bundle);
  if (!frame || !frame.file || frame.line == null) return;

  const abs = toFsPath(frame.file, workspaceRoot);
  const line = Math.max(0, frame.line - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);

  const stale = await isLocationStale(workspaceRoot, bundle, abs);
  const greenRef = bundle.git?.greenRef;
  const sinceGreen = greenRef ? `, changed since ${greenRef.slice(0, 7)}` : '';
  const staleNote = stale ? ' (may be stale — files changed since capture)' : '';
  const message = `whatbroke: crash origin · ${errorSummary(bundle)} · suspect #1${sinceGreen}${staleNote}`;

  const diag = new vscode.Diagnostic(
    range,
    message,
    stale ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
  );
  diag.source = DIAGNOSTIC_SOURCE;
  diag.code = `bundle ${bundle.id}`;
  collection.set(vscode.Uri.file(abs), [diag]);
}

// ── Status bar ──────────────────────────────────────────────────────────────

function renderStatusBar(
  statusBar: vscode.StatusBarItem,
  latest: LatestBundle | null,
  resolvedByGreen: boolean,
): void {
  if (!vscode.workspace.getConfiguration('whatbroke').get<boolean>('statusBar.enabled', true)) {
    statusBar.hide();
    return;
  }
  if (!latest || resolvedByGreen) {
    statusBar.text = '$(check) whatbroke: green';
    statusBar.tooltip = resolvedByGreen
      ? 'Last crash resolved by a passing run'
      : 'No crash bundle in this workspace';
    statusBar.backgroundColor = undefined;
  } else {
    const n = latest.bundle.repro?.suspects?.length ?? 0;
    statusBar.text = `$(error) whatbroke: crashed (${n} suspect${n === 1 ? '' : 's'})`;
    statusBar.tooltip = `${errorSummary(latest.bundle)} — click to open the bundle`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBar.show();
}

// ── CodeLens ──────────────────────────────────────────────────────────────────

class SuspectCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private latest: LatestBundle | null = null;
  private workspaceRoot = '';

  update(workspaceRoot: string, latest: LatestBundle | null): void {
    this.workspaceRoot = workspaceRoot;
    this.latest = latest;
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.latest) return [];
    if (!vscode.workspace.getConfiguration('whatbroke').get<boolean>('codeLens.enabled', true)) return [];
    const frame = topUserFrame(this.latest.bundle);
    if (!frame || !frame.file || frame.line == null) return [];
    const abs = toFsPath(frame.file, this.workspaceRoot);
    if (path.normalize(abs) !== path.normalize(document.uri.fsPath)) return [];

    const line = Math.max(0, frame.line - 1);
    const range = new vscode.Range(line, 0, line, 0);
    return [
      new vscode.CodeLens(range, {
        title: `🐛 whatbroke: top suspect · ${errorSummary(this.latest.bundle)}`,
        command: 'whatbroke.openLatestBundle',
        arguments: [],
      }),
    ];
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function registerCommands(
  context: vscode.ExtensionContext,
  getState: () => State | null,
  refresh: () => Promise<void>,
): void {
  const need = (): State => {
    const s = getState();
    if (!s?.latest) {
      throw new VisibleError('No whatbroke crash bundle found in this workspace.');
    }
    return s;
  };

  const wrap = (fn: () => Promise<void> | void) => async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof VisibleError) {
        void vscode.window.showInformationMessage(err.message);
      } else {
        void vscode.window.showErrorMessage(`whatbroke: ${(err as Error).message}`);
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('whatbroke.refresh', wrap(refresh)),

    vscode.commands.registerCommand(
      'whatbroke.openLatestBundle',
      wrap(async () => {
        const { latest } = need();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(latest!.jsonPath));
        await vscode.window.showTextDocument(doc, { preview: true });
      }),
    ),

    vscode.commands.registerCommand(
      'whatbroke.openAsMarkdown',
      wrap(async () => {
        const { latest } = need();
        const md = vscode.Uri.file(latest!.markdownPath);
        try {
          await vscode.workspace.fs.stat(md);
        } catch {
          throw new VisibleError(
            'No Markdown render on disk. Re-run with `whatbroke run` (it writes the .md sibling) or use `whatbroke show`.',
          );
        }
        await vscode.commands.executeCommand('markdown.showPreview', md);
      }),
    ),

    vscode.commands.registerCommand(
      'whatbroke.openLogs',
      wrap(async () => {
        const { latest } = need();
        const bundle = latest!.bundle;
        const body = renderLogs(bundle);
        const doc = await vscode.workspace.openTextDocument({ language: 'log', content: body });
        await vscode.window.showTextDocument(doc, { preview: true });
      }),
    ),

    vscode.commands.registerCommand(
      'whatbroke.openDiffVsGreen',
      wrap(async () => {
        const { latest } = need();
        const diff = latest!.bundle.git?.diffVsGreen;
        if (!diff) throw new VisibleError('This bundle has no diff vs green.');
        const header =
          `# diff vs green (${diff.base.slice(0, 7)})` +
          (diff.truncated ? ' — truncated\n' : '\n') +
          `# bundle ${latest!.bundle.id}\n\n`;
        const doc = await vscode.workspace.openTextDocument({
          language: 'diff',
          content: header + diff.patch,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }),
    ),

    vscode.commands.registerCommand(
      'whatbroke.fileGithubIssue',
      wrap(async () => {
        const { latest } = need();
        const id = latest!.bundle.id;
        const choice = await vscode.window.showInformationMessage(
          'whatbroke files GitHub issues from the CLI (so secrets stay gated by the redaction pipeline). Copy the command?',
          'Copy command',
        );
        if (choice === 'Copy command') {
          await vscode.env.clipboard.writeText(`npx whatbroke open ${id} --github`);
          void vscode.window.showInformationMessage('Copied: npx whatbroke open ' + id + ' --github');
        }
      }),
    ),
  );
}

function renderLogs(bundle: Bundle): string {
  const parts: string[] = [`# whatbroke logs · bundle ${bundle.id} (redacted)`];
  const frames = userFrames(bundle).length;
  parts.push(`# ${errorSummary(bundle)} · ${frames} user frame(s)`, '');
  if (bundle.logs?.stdoutTail) parts.push('── stdout ──', bundle.logs.stdoutTail, '');
  if (bundle.logs?.stderrTail) parts.push('── stderr ──', bundle.logs.stderrTail, '');
  if (!bundle.logs?.stdoutTail && !bundle.logs?.stderrTail) parts.push('(no captured output)');
  return parts.join('\n');
}

/** An error whose message is safe and useful to show the user verbatim. */
class VisibleError extends Error {}
