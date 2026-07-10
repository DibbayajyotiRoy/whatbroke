# Publishing whatbroke to the VS Code Marketplace

Everything needed for the publisher profile ("About you" page) and the
extension listing, plus the publish commands. Copy-paste ready.

---

## 1. Publisher profile — "About you" form

### Description (paste into the "Details of publisher" box)

> Building agent-native developer tools. whatbroke gives AI coding agents
> grounded, secret-free crash context: wrap any dev command, get a redacted,
> git-anchored bug bundle with ranked suspect files — then let the agent verify
> its own fix by re-running the exact captured command. Local-only,
> deterministic, no accounts, no telemetry. Open source (Apache-2.0) at
> github.com/DibbayajyotiRoy/whatbroke.

Shorter variant, if you prefer one line:

> Agent-native developer tooling — whatbroke turns local crashes into
> redacted, git-anchored context AI coding agents can act on and verify
> against. Local-only, deterministic, open source.

### Logo (128 × 128)

Upload **`extension/media/publisher-logo.png`** — the whatbroke bug glyph in
amber on charcoal (the inverse of the extension icon, so your profile and the
extension tile read as one brand without being identical). Regenerate any time:

```sh
cd extension/media
convert -background none -density 96 publisher-logo.svg -resize 128x128 publisher-logo.png
```

If you'd rather use the product mark itself, `extension/media/icon.png`
(dark glyph on amber) is also 128 × 128.

---

## 2. Extension listing content

The Marketplace page is assembled from `extension/package.json` +
`extension/README.md` (already listing-ready). The fields that matter:

- **displayName** — `whatbroke` ✓
- **description** (search snippet, ≤ ~200 chars) — current text is good; a
  sharper alternative tuned for search:

  > See your latest crash without leaving VS Code: ranked suspect files, diff
  > since the code last worked, stack, and redacted logs — captured by the
  > whatbroke CLI, rendered in your editor. Read-only; computes nothing.

- **categories** — `Other`, `Debuggers` ✓ (add `Testing`: crashes usually come
  from test runs, and it's a real browse category)
- **keywords** (Marketplace caps at 30) — suggested set:
  `whatbroke, crash, stack-trace, debugging, suspect, bug-report, mcp,
  ai-agent, error, diff, test-failure, redaction`
- **icon** — `media/icon.png` ✓
- **galleryBanner** — brand the listing header:

  ```json
  "galleryBanner": { "color": "#1A1208", "theme": "dark" }
  ```

- **badges** (optional, must be from trusted hosts): CI status via
  `https://img.shields.io/github/actions/workflow/status/DibbayajyotiRoy/whatbroke/ci.yml`
  linking to the Actions page.

**Screenshots sell a viewer.** Before publishing, capture 2–3 PNGs and embed
them at the top of `extension/README.md`: (1) the Latest-crash tree with
ranked suspects, (2) the Problems-panel diagnostic + CodeLens on the top
suspect line, (3) the status-bar flip after a green run. GIF of the
crash → fix → green cycle is even better.

---

## 3. Publish commands

One-time setup:

```sh
npm i -g @vscode/vsce
# Azure DevOps PAT: https://dev.azure.com → User settings → Personal access
# tokens → New. Organization: "All accessible organizations".
# Scope: Marketplace → Manage. (That single scope is enough.)
vsce login DibbayajyotiRoy   # paste the PAT (must match the publisher in package.json)
```

Each release:

```sh
cd extension
npm ci && npm run build
vsce package              # builds whatbroke-vscode-<version>.vsix, respects .vscodeignore
vsce publish              # or: vsce publish patch|minor|major to bump+publish
```

Verify at `https://marketplace.visualstudio.com/items?itemName=DibbayajyotiRoy.whatbroke-vscode`
(listing can take a few minutes to index). `vsce ls` shows exactly which files
ship in the package.

Pre-publish checklist:

- [ ] `npm run build` clean; F5 Extension Development Host smoke-run
- [ ] Version bumped in `extension/package.json`
- [ ] README screenshots present and paths relative to `extension/`
- [ ] `vsce package` and inspect the `.vsix` size + file list (`vsce ls`)
- [ ] LICENSE present (Apache-2.0) ✓
