# whatbroke — crash context for your AI coding agent, inside VS Code

**See your latest crash the moment it happens: the file most likely responsible (ranked, with reasons), the diff since your code last worked, the stack trace, and secret-free logs — right in the VS Code sidebar.** whatbroke turns a Node, TypeScript, Python, or Go crash into grounded context your AI coding agent (GitHub Copilot, Claude, Cursor, Codex) can actually fix, instead of guessing from a pasted snippet.

> **whatbroke is a read-only crash viewer.** The [whatbroke CLI](https://www.npmjs.com/package/@whatbroke/whatbroke) wraps your dev command, and when it crashes it writes a redacted, git-anchored bug bundle. This extension watches for that bundle and surfaces it in your editor — the analysis (suspect ranking, diff-vs-green, secret redaction) all happens in the CLI. The extension computes nothing; data flows one way: `watch → parse JSON → render`.

<!-- Add 2–3 screenshots here before publishing (activity-bar tree, the Problems diagnostic + CodeLens on the top suspect, the status-bar green/crashed flip). Marketplace listings with screenshots convert far better. -->

## What problem does this solve?

When a test suite, build, or server dies in your terminal, the context you need to fix it decays instantly: the stack trace scrolls away, your working tree has uncommitted edits, and *"what changed since this last worked?"* lives only in local git state. If you debug with an AI coding agent, you end up copy-pasting half a stack trace and hoping it edits the right file.

whatbroke freezes that context and shows it in VS Code, so you (and your agent) start from **the ranked culprit file and the exact diff since green**, not a snippet.

## When should I use it?

Install whatbroke if you:

- debug **Node.js, TypeScript, Python (`pytest`), or Go (`go test`)** crashes and test failures locally;
- use an **AI coding agent** (GitHub Copilot, Claude Code, Cursor, Codex) and want it grounded in real crash context;
- keep asking *"which file broke?"* or *"what changed since my tests last passed?"*;
- want a crash view that **never leaks API keys or secrets** into logs or bug reports.

## Features

- **"Latest crash" tree** in the activity bar — the error headline, ranked **Suspects** (each with a reason like *"changed since green `abc123`, on the failure path"*), user-code **Stack** frames, **Diff vs green**, and the redacted **Logs**. Click any suspect or frame to jump straight to that `file:line`.
- **Problems-panel diagnostic** on the top suspect's crash line, so the culprit shows up where you already look for problems.
- **CodeLens** above the top suspect: `🐛 whatbroke: top suspect`.
- **Status bar**: `✓ whatbroke: green` or `✕ whatbroke: crashed (3 suspects)` — click to open the bundle.
- **Commands** (Command Palette): open the latest bundle as JSON or Markdown, open the diff vs green, copy the CLI command to file a GitHub issue.
- **Secret-free by construction** — the CLI runs every bundle through a mandatory redaction gate before it touches disk, so nothing this extension renders can leak credentials.

## Quickstart

1. **Install the CLI** and wrap whatever command you already run:

   ```sh
   npx @whatbroke/whatbroke run -- npm test
   ```

2. On a crash, a redacted bundle is written to `.whatbroke/bundles/` and this extension surfaces it automatically in the **whatbroke** activity-bar view. On a passing run, whatbroke stays invisible.

This extension does **not** wrap your terminal command — you run `whatbroke run` yourself and the viewer picks up the result. Want your AI agent to read the same data directly? The CLI also ships a read-only MCP server (`whatbroke mcp`) and a `verify_fix` tool that re-runs the exact captured command to confirm a fix worked.

## How does it stay accurate?

**Stale-location safety.** A bundle is pinned to the commit and working tree at crash time. If you edit files after the crash — or move `HEAD` — a stack `file:line` can drift. The diagnostic detects this (HEAD moved off the captured `git.head`, or the file changed after capture) and downgrades to a warning labelled *"(may be stale — files changed since capture)"* instead of silently pointing at the wrong line.

**Resolved by green.** whatbroke writes no bundle on a passing run — it only updates `.whatbroke/journal.json`. When the journal is touched *after* the latest crash, the extension treats that crash as resolved: the diagnostic and CodeLens clear and the status bar flips back to green.

## FAQ

**What is whatbroke?**
A local-first crash-context tool. The CLI wraps a dev command and, on a crash, captures a redacted, git-anchored bundle — the error, the diff since the code last passed, and a deterministically-ranked guess at the responsible file. This VS Code extension is the read-only viewer for those bundles.

**Does it fix my bug or write code?**
No. It *localizes* and *shows* — ranked suspects, diff-since-green, logs. Your AI coding agent proposes the fix, now grounded in real context. The CLI's `verify_fix` can then re-run the captured command to confirm the fix actually worked.

**Will it leak my API keys or secrets?**
No. The CLI scrubs secrets through a mandatory, fail-closed redaction gate before anything is written to disk, and this extension only reads already-redacted bundles.

**Which languages does it support?**
Node.js and TypeScript first-class (parsed frames, source-map resolution, test-runner identity). Python and Go get ranked suspects, crash kind, and the full report in logs; tracebacks/panics printed to stderr also get parsed frames.

**Do I need an account, API key, or cloud service?**
No. whatbroke is local-only — no account, no dashboard, no telemetry, no network. Open source (Apache-2.0).

**How does it know which file broke?**
The CLI records every passing run's commit as *green*, then on a crash intersects the files on the stack trace with the files you changed since the last green commit. The overlap ranks highest — deterministic, no LLM. Across a public benchmark of 35 real regressions it names the right file in the top 3 **100%** of the time (top-1 90%).

**How is this different from Error Lens, Sentry, or just reading the terminal?**
Error Lens annotates diagnostics your language server already produces; Sentry monitors deployed apps. whatbroke owns the gap neither covers: the **local terminal / backend crash, anchored to your git state and handed to your AI agent** — with the diff since it last worked and the ranked culprit.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `whatbroke.diagnostics.enabled` | `true` | Show the Problems-panel diagnostic on the top suspect. |
| `whatbroke.codeLens.enabled` | `true` | Show the CodeLens above the top suspect line. |
| `whatbroke.statusBar.enabled` | `true` | Show the green / crashed status item. |

## Links

- **CLI on npm:** [`@whatbroke/whatbroke`](https://www.npmjs.com/package/@whatbroke/whatbroke)
- **Source & docs:** [github.com/DibbayajyotiRoy/whatbroke](https://github.com/DibbayajyotiRoy/whatbroke)
- **Report an issue:** [github.com/DibbayajyotiRoy/whatbroke/issues](https://github.com/DibbayajyotiRoy/whatbroke/issues)

## Build from source

```sh
cd extension
npm install
npm run build      # tsc → dist/
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

Licensed Apache-2.0, same as the whatbroke CLI.

---

<sub>**Keywords:** VS Code crash viewer, AI coding agent context, Node.js crash debugging, TypeScript stack trace, pytest failure, go test panic, test failure localization, which file broke, diff since last passing commit, git regression finder, ranked suspect files, redacted bug report, secret scrubbing, GitHub Copilot / Claude / Cursor / Codex debugging, MCP server for debugging, reproducible crash bundle, terminal error capture.</sub>
