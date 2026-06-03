# whatbroke — One-Page Brief

**Grounded, secret-free crash context for the local terminal.**

whatbroke is a local-only CLI + library. You wrap a dev command — `npx whatbroke run -- npm test` — and on a crash it packages the error, the diff since the code last worked, and a ranked guess at the responsible file into one redacted bundle, then hands it to your coding agent over a local MCP server. It diagnoses; it does not fix. No backend, no account, no dashboard. v1 is Node/TS only.

---

### The problem
When a Node/TS suite or server dies in the terminal, the developer holds context that decays by the minute: the stack trace just scrolled past, the working tree has uncommitted edits, and "what changed since this last worked?" lives only in local state. Transferring it to a teammate, an issue, or an AI agent means manual archaeology — and pasting raw logs/diffs routinely leaks secrets. Sentry watches production, Jam watches the browser, Replay records sessions; **none own the local terminal/backend crash anchored to git state.**

### What it does (pipeline)
`crash → capture → git-anchored context → deterministic suspect ranking → redaction gate → MCP / issue / terminal`

- **Capture** — error, stack, exit/signal, failing-test identity, ring-buffer log tail.
- **Git context** — branch/HEAD, uncommitted working tree, diff since the last *green* commit.
- **Suspect ranking** — files most likely at fault, ranked with explicit reasons. **No LLM.**
- **Redaction** — mandatory, type-enforced gate; secrets never leave the machine unredacted.
- **Delivery** — read-only MCP server (primary), prefilled GitHub issue, or terminal.

### The moat
A green-commit journal × stack-trace intersection, computed with **no LLM**. Every passing run records HEAD as *green*; on a crash, whatbroke intersects *files on the stack* with *files changed since green* and scores that overlap highest (+5, fixed integer weights). This is accumulated local ground truth a hosted SaaS structurally cannot see and a prompt cannot reproduce. *(Verified against the code: deterministic, no LLM/network/randomness/clock calls; byte-identical output asserted by test.)*

### Why it's better than what exists
| Incumbent | Owns | Where it stops |
|---|---|---|
| Sentry / Rollbar / Datadog | Deployed-app monitoring | Can't see the local suite/server or the dirty working tree |
| Replay.io | Time-travel runtime replay | Records sessions; doesn't diff against git |
| Jam.dev | Browser bug capture (DOM/network/console) | Frontend surface, not the terminal/backend |
| Cursor / Claude Code | LLM code *fixing* | whatbroke feeds them grounded context so they "aim before they shoot" |

whatbroke is **complementary, not a replacement** — it fills the one surface none of them own.

### Security
Redaction is a *mandatory, fail-closed gate*: `RedactedBundle` is a branded type whose only producer is `redact()`, and every sink/reader accepts only that brand — routing an unredacted bundle to output is a **compile-time error**. A CI corpus asserts zero secret survivors. Config can *tighten* but never disable the gate. *(Caveats: `allowEnv` surfaces those env values verbatim; `entropy:false` drops the lowest-precision pass.)*

### Adoption & distribution
Individual, zero team buy-in: `npx whatbroke run -- <cmd>` — no install, config, or account. MCP-into-agents is the primary distribution channel (the build order ships MCP before the GitHub sink). Growth model is recognition and stars, not sales. MIT licensed.

### Long-run impact
As AI writes more code, the bottleneck shifts from *fixing* to *localizing*. whatbroke bets that step lives in the terminal, anchored to git, with the answer flowing to agents over MCP. Realistic ceiling: the default way Node devs feed crash context to coding agents — defensible for as long as the local-terminal gap stays open. The moat is language-agnostic; the capture front-end is not, so multi-language is a credible second act, not a quick fan-out.

### Honest risks
- **Wedge is a timing bet** — incumbents are all shifting left into local dev + MCP; a spec-mandated pre-M2 validation gate must confirm none already own this path.
- **No measured accuracy yet** — "names the right file in top-3" is a spec *target to measure*, not an evidenced result; no benchmark in the repo.
- **A few claims are narrower than headlined** — provenance tiers apply only to repro steps (not every fact); the "single bundle" is two files (`.json` + `.md`); the "invisible wrapper" still prints `✓ green recorded` and writes the journal/gitignore on a passing run.
- **Redaction strength is partly tunable downward** — one leaked token would do outsized reputational damage; the weakening knobs need prominent docs.

---
*Verification: 5/8 core claims CONFIRMED against source, 3 PARTIAL (self-flagged above), 0 unsupported. 143/143 tests passing. Full detail in [PRODUCT-BRIEF.md](PRODUCT-BRIEF.md).*
