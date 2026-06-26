/**
 * The "Latest crash" TreeView (spec 09, thin tier).
 *
 *   ✕ TypeError: cannot read 'id' of undefined
 *      ├─ Suspects
 *      │   ├─ auth.ts:42   (#1 · on stack + changed since abc123)
 *      │   └─ token.ts:13  (#2 · changed since abc123)
 *      ├─ Stack (user frames)
 *      ├─ Diff vs green (abc123)
 *      └─ Logs (redacted)
 *
 * Pure projection of the on-disk bundle — no computation, no derived data.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  displayPath,
  errorSummary,
  toFsPath,
  userFrames,
  type Bundle,
  type LatestBundle,
  type StackFrame,
  type SuspectFile,
} from './bundle.js';

type NodeKind = 'root' | 'group' | 'suspect' | 'frame' | 'diff' | 'leaf';

export class BundleNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public children: BundleNode[] = [],
  ) {
    super(label, collapsible);
  }
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '?';
}

/** Open a repo file at a 1-based line, read-only navigation. */
function openLocationCommand(workspaceRoot: string, frameFile: string, line: number): vscode.Command {
  const abs = toFsPath(frameFile, workspaceRoot);
  const position = new vscode.Position(Math.max(0, line - 1), 0);
  return {
    command: 'vscode.open',
    title: 'Open location',
    arguments: [
      vscode.Uri.file(abs),
      { selection: new vscode.Range(position, position) } satisfies vscode.TextDocumentShowOptions,
    ],
  };
}

function suspectNode(workspaceRoot: string, suspect: SuspectFile, rank: number): BundleNode {
  const display = displayPath(suspect.path, workspaceRoot);
  const node = new BundleNode(
    `#${rank} ${path.basename(display)}`,
    vscode.TreeItemCollapsibleState.None,
    'suspect',
  );
  node.description = suspect.reasons.join(' · ') || `score ${suspect.score}`;
  node.tooltip = new vscode.MarkdownString(
    `**${display}**\n\nscore: ${suspect.score}\n\n${suspect.reasons.map((r) => `- ${r}`).join('\n')}`,
  );
  node.iconPath = new vscode.ThemeIcon(rank === 1 ? 'flame' : 'circle-filled');
  node.resourceUri = vscode.Uri.file(toFsPath(suspect.path, workspaceRoot));
  // Suspect paths carry no line; open at the file head.
  node.command = openLocationCommand(workspaceRoot, suspect.path, 1);
  return node;
}

function frameNode(workspaceRoot: string, frame: StackFrame): BundleNode {
  const label = `${displayPath(frame.file!, workspaceRoot)}:${frame.line}`;
  const node = new BundleNode(label, vscode.TreeItemCollapsibleState.None, 'frame');
  node.description = frame.functionName ?? '<anonymous>';
  node.iconPath = new vscode.ThemeIcon('debug-stackframe');
  node.command = openLocationCommand(workspaceRoot, frame.file!, frame.line!);
  return node;
}

export class BundleTreeProvider implements vscode.TreeDataProvider<BundleNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private latest: LatestBundle | null = null;
  private workspaceRoot = '';

  update(workspaceRoot: string, latest: LatestBundle | null): void {
    this.workspaceRoot = workspaceRoot;
    this.latest = latest;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BundleNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BundleNode): BundleNode[] {
    if (element) return element.children;
    if (!this.latest) return [];
    return [this.buildRoot(this.latest.bundle)];
  }

  private buildRoot(bundle: Bundle): BundleNode {
    const root = new BundleNode(
      `✕ ${errorSummary(bundle)}`,
      vscode.TreeItemCollapsibleState.Expanded,
      'root',
    );
    const lang = bundle.language && bundle.language !== 'unknown' ? `${bundle.language} · ` : '';
    root.description = `${lang}confidence ${bundle.repro?.confidence ?? 'unknown'}`;
    root.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    root.tooltip = `bundle ${bundle.id} · ${bundle.createdAt}`;

    const groups: BundleNode[] = [];
    groups.push(this.suspectsGroup(bundle));
    groups.push(this.stackGroup(bundle));
    const diff = this.diffNode(bundle);
    if (diff) groups.push(diff);
    groups.push(this.logsGroup(bundle));
    root.children.push(...groups);
    return root;
  }

  private suspectsGroup(bundle: Bundle): BundleNode {
    const suspects = bundle.repro?.suspects ?? [];
    const group = new BundleNode(
      'Suspects',
      suspects.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      'group',
    );
    group.description = `${suspects.length}`;
    group.iconPath = new vscode.ThemeIcon('search');
    group.children = suspects.map((s, i) => suspectNode(this.workspaceRoot, s, i + 1));
    return group;
  }

  private stackGroup(bundle: Bundle): BundleNode {
    const frames = userFrames(bundle);
    const group = new BundleNode(
      'Stack (user frames)',
      frames.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      'group',
    );
    group.description = `${frames.length}`;
    group.iconPath = new vscode.ThemeIcon('list-flat');
    group.children = frames.map((f) => frameNode(this.workspaceRoot, f));
    return group;
  }

  private diffNode(bundle: Bundle): BundleNode | null {
    const diff = bundle.git?.diffVsGreen;
    if (!diff) return null;
    const node = new BundleNode(
      `Diff vs green (${shortSha(diff.base)})`,
      vscode.TreeItemCollapsibleState.None,
      'diff',
    );
    node.description = diff.truncated ? 'truncated' : '';
    node.iconPath = new vscode.ThemeIcon('git-compare');
    node.command = { command: 'whatbroke.openDiffVsGreen', title: 'Open diff vs green' };
    return node;
  }

  private logsGroup(bundle: Bundle): BundleNode {
    const node = new BundleNode('Logs (redacted)', vscode.TreeItemCollapsibleState.None, 'leaf');
    node.description = bundle.logs?.truncated ? 'truncated' : '';
    node.iconPath = new vscode.ThemeIcon('output');
    node.command = { command: 'whatbroke.openLogs', title: 'Open logs' };
    return node;
  }
}
