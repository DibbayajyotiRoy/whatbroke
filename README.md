# whatbroke

**Wrap a dev command. When it crashes, get a redacted, git-anchored, agent-ready bug bundle — automatically.**

> whatbroke is the terminal-side capture layer for local Node crashes. When a test or
> server dies in your shell, it packages the error, the diff since it last worked, and a
> ranked guess at the responsible file — secrets scrubbed — and hands it to your coding
> agent over MCP. It doesn't monitor production and it doesn't fix your code; it makes the
> thing that fixes your code aim before it shoots.

whatbroke works **alongside** Sentry, Jam, and Replay — it fills the local-terminal/backend-crash gap they don't cover. See [What it is NOT](#what-it-is-not).

## Quickstart

Zero config. Just wrap whatever command you already run:

```sh
npx whatbroke run -- npm test
```

- **On a passing run:** whatbroke is invisible. The child's output streams through unchanged, the exit code is mirrored, and whatbroke records a *green commit* in its journal (at most a dim one-line `✓ green recorded` note). It feels like a transparent wrapper.
- **On a crash** (non-zero exit, uncaught exception, unhandled rejection, or killing signal): whatbroke assembles a single self-contained, **redacted** bundle and writes it to `.whatbroke/bundles/` (as `whatbroke-<id>.json` + `.md`), then prints the paths.

On first run in a project, whatbroke creates `./.whatbroke/` and adds it to `.gitignore` (creating the file if absent) so bundles never get committed by accident.

## What it does

The pipeline at a glance:

```
crash → capture → git-anchored context → deterministic suspect ranking → redaction gate → MCP / issue / terminal
```

whatbroke assembles everything needed to understand and reproduce the failure into **one bundle**:

- **Capture** — error name/message, stack trace, exit code or signal, failing test identity, and a ring-buffer log tail.
- **Git-anchored context** — the branch and HEAD at crash time, the uncommitted working-tree state, and the diff since the last commit that passed.
- **Deterministic suspect ranking** — the files most likely responsible, ranked, each with explicit reasons. **No LLM guesser**: ranking is computed from git state intersected with the stack trace (see [The moat](#the-moat)).
- **Redaction** — a mandatory gate scrubs secrets before *anything* leaves the process. Secrets never leave the machine unredacted (see [Security / redaction](#security--redaction)).
- **Delivery** — the redacted bundle goes where the fix happens: a coding agent over MCP (primary), a prefilled GitHub issue, or the terminal.

Every fact in the bundle carries a **provenance tier** — `observed` (whatbroke measured it), `derived` (computed with no guessing), or `heuristic` (a labeled ranked guess) — so a reader knows exactly how much to trust each line.

## The moat

The defensible core is the **green-commit journal × stack-trace intersection**, computed with **no LLM**.

Every time your command passes, whatbroke records the commit as *green*. When it later crashes, whatbroke intersects two sets:

- the files **on the crash path** (frames in the stack trace), and
- the files you **changed since the last green commit**.

When that intersection is non-empty, the conclusion is direct and deterministic: *you changed X, X is on the crash path, X is probably it.* That file leads the ranking and confidence is `high`. Each suspect's `reasons[]` spell out which signals fired (e.g. "on stack at frame 2; changed since green `abc123`") — transparency is the trust mechanism.

This is accumulated local ground truth that production SaaS tools structurally cannot see and that an LLM cannot reproduce by prompting. It is cheap, deterministic, and improves with use.

## CLI reference

```
whatbroke run [flags] -- <command> [args...]   # wrap + capture (primary)
whatbroke mcp                                  # launch the local MCP server for this project
whatbroke show <bundle-id|path>                # re-render a saved bundle as Markdown
whatbroke open <bundle-id|path> [--github ...] # send an existing bundle to a sink
whatbroke journal [--list|--clear]             # inspect/clear the green-commit journal
whatbroke --version | --help
```

### `run` flags

| Flag | Effect |
|------|--------|
| `--out <dir>` | Bundle output dir (default `./.whatbroke/bundles/`). |
| `--md` | Also print the rendered Markdown to stdout (for piping/quick paste). |
| `--github [owner/repo]` | Create a prefilled GitHub issue. Repo inferred from `git remote get-url origin` if omitted. |
| `--timeout <ms>` | Kill and treat as a crash if the child hangs. |
| `--log-lines <n>` | Ring-buffer log size override. |
| `--explain` | Enable optional LLM **narration** (a 2–3 sentence summary only; requires a configured provider). Off by default. |
| `--quiet` / `--verbose` | Control whatbroke's own chatter. The child's output always streams through unchanged. |

**Exit codes:** `run` mirrors the child's exit code, so CI and shells behave identically with or without whatbroke. whatbroke's own usage errors (bad flags, command-not-found) use a distinct high code (e.g. `64`) so they're never confused with a child failure.

> `--explain` is the *only* place an LLM is involved, and it is off by default. Narration can never change the steps, suspects, or confidence — the tool is fully functional and the moat fully intact without it.

### Config file (optional)

`whatbroke.config.{json,js}` or `.whatbrokerc`. Resolution order: **CLI flag > project config > user config > defaults.**

```jsonc
{
  "logLines": 500,
  "out": "./.whatbroke/bundles",
  "defaultSink": "file",
  "redaction": { "allowEnv": ["NODE_ENV", "CI"], "denyPatterns": ["custom-secret-\\w+"] },
  "explain": { "enabled": false, "provider": "..." }
}
```

Config may **tighten** redaction but can never disable the gate.

## MCP usage

`whatbroke mcp` launches a **read-only, project-scoped stdio MCP server** so a coding agent (Claude Code, Cursor, etc.) can read whatbroke's bundles directly. This is the primary delivery surface.

- **Read-only:** the server only reads already-redacted bundle JSON from `.whatbroke/bundles/`. It computes nothing, mutates nothing, and never touches raw pre-redaction data.
- **stdio transport:** a local child process — no HTTP, no network, no auth, no account.
- **Project-scoped:** launched from the project directory, it serves only that project's `.whatbroke/`. One repo, one server.

### Tools exposed

| Tool | Returns |
|------|---------|
| `list_bundles` | Recent bundles: id, createdAt, error summary, confidence. |
| `get_bundle` | The full redacted bundle. |
| `get_suspects` | Ranked suspect files + reasons + confidence — *start here.* |
| `get_diff_vs_green` | Unified diff since the last green commit + base sha (redacted). |
| `get_logs` | Redacted log tail, optionally `grep`-filtered. |
| `get_repro` | The ordered, deterministic repro steps. |

Each tool defaults to the most recent crash bundle (or accepts an `id`). File references include the captured `git.head` sha so the agent knows what revision the locations refer to.

### Registration

Add a representative `mcpServers` entry pointing at `whatbroke mcp`, launched from the project directory. The exact config file and field names depend on your client — consult its MCP docs — but the shape is the same for both Claude Code and Cursor:

```jsonc
{
  "mcpServers": {
    "whatbroke": {
      "command": "npx",
      "args": ["whatbroke", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Then, after a crash, just tell the agent "fix the failing test." It calls `get_suspects` first, pulls the diff and error, and edits the right file with grounded context instead of guessing from a pasted snippet.

## Security / redaction

- Secrets are scrubbed by a **mandatory redaction gate** before any output — files, stdout, issues, or MCP. Only already-redacted bundles ever reach disk, so the MCP server (which only reads disk) inherits the guarantee for free.
- Every bundle includes a **redaction report** so you can see what was scrubbed.
- Config can only **tighten** redaction (add allowed env vars, add deny patterns); it can **never disable** the gate.

Secrets never leave your machine unredacted.

## What it is NOT

whatbroke is deliberately narrow. It is **not**:

- **a production error monitor** — no backend, no dashboard, no account. (That's Sentry / Rollbar / Datadog.)
- **a fixer** — it localizes and packages context; the coding agent proposes the fix. (That's Cursor / Claude Code.)
- **a browser / DOM / network capture tool** — no extension, no front-end session. (That's Jam.)
- **a runtime time-travel replay** — (that's Replay.io.)
- **a proactive bug finder** — it acts only on a real crash; it does not scan for latent bugs.
- **multi-language** — Node / TypeScript only in v1.
- **an LLM product** — ranking is deterministic; any narration is optional and off by default.

It is **complementary** to Sentry / Jam / Replay, not a replacement. It fills the one surface none of them own: the local terminal / backend crash, anchored to your git state.

## Requirements

- Node `>= 20`

## License

Source-available, **non-commercial**. whatbroke is **free to use for personal
learning, study, and evaluation**. Any other use — commercial use, production
use, redistribution, or shipping it as your own product — requires a separate
license from the author. See [LICENSE](LICENSE) for the full terms and contact
details.
