# whatbroke for VS Code

A **read-only viewer** for [whatbroke](https://github.com/DibbayajyotiRoy/whatbroke)
crash bundles. When you run a command through the whatbroke CLI and it crashes,
the CLI writes a redacted bundle to `.whatbroke/bundles/`. This extension watches
that directory and surfaces the latest crash — its ranked suspects, the diff since
the code last worked, the stack, and the captured logs — without leaving your editor.

It is a viewer, not a second brain. **It computes nothing.** All the analysis (suspect
ranking, the diff-vs-green moat, redaction) happens in the CLI; the extension only
parses the gated bundle on disk and renders it. Data flows one way:
`watch → parse JSON → refresh views`.

## What you get

- **"Latest crash" tree** in the activity bar — error headline, ranked **Suspects**,
  user-code **Stack** frames, **Diff vs green**, and the redacted **Logs**. Click any
  suspect or frame to jump to that `file:line`.
- **Problems-panel diagnostic** on the top suspect's crash line:
  `whatbroke: crash origin · <error> · suspect #1, changed since abc123`.
- **CodeLens** above the top suspect line: `🐛 whatbroke: top suspect`.
- **Status bar**: `✓ whatbroke: green` or `✕ whatbroke: crashed (3 suspects)`.
  Click to open the latest bundle.
- **Commands** (Command Palette): open the latest bundle as JSON or Markdown, open
  the diff vs green, and copy the CLI command to file a GitHub issue.

## Stale-location safety

A bundle is pinned to the commit and working tree at crash time. If you edit files
after the crash — or move HEAD — a stack `file:line` can drift. The diagnostic detects
this (HEAD moved off the captured `git.head`, or the file changed after capture) and
downgrades to a warning labelled `(may be stale — files changed since capture)` instead
of silently pointing at the wrong line.

## Resolved by green

whatbroke writes no bundle on a passing run — it only updates `.whatbroke/journal.json`.
When the journal is touched *after* the latest crash, the extension treats that crash as
resolved: the diagnostic and CodeLens clear and the status bar flips back to green.

## Usage

1. Install the [whatbroke CLI](https://www.npmjs.com/package/@whatbroke/whatbroke):
   `npx whatbroke run -- npm test`
2. On a crash, the bundle appears automatically in the **whatbroke** activity-bar view.

This extension does **not** wrap your terminal command — you run `whatbroke run`
yourself and the watcher picks up the result.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `whatbroke.diagnostics.enabled` | `true` | Show the Problems-panel diagnostic on the top suspect. |
| `whatbroke.codeLens.enabled` | `true` | Show the CodeLens above the top suspect line. |
| `whatbroke.statusBar.enabled` | `true` | Show the green / crashed status item. |

## Build from source

```sh
cd extension
npm install
npm run build      # tsc → dist/
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

Licensed Apache-2.0, same as the whatbroke CLI.
