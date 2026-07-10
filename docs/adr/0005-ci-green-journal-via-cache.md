# ADR-0005: CI green baseline via cache-restored journal on the default branch

**Status**: Proposed (Roadmap Theme 2)
**Date**: 2026-07-10

## Context

In CI, every runner starts cold: no `.whatbroke/journal.json`, so diff-vs-green
falls back to merge-base — decent but weaker than a true "last passing main
build" baseline. The 10x value of CI mode is a PR crash annotated with the
diff against the commit where the suite last actually passed.

## Considered Options

1. **Cache-restored journal**: the GitHub Action restores `.whatbroke/journal.json`
   from the actions cache, records green on passing default-branch runs, and
   saves it back. PR runs restore read-only.
2. Query the GitHub API for the last green check run — accurate but couples
   core logic to a forge API and needs token scopes; rejected for core
   (may become an optional fallback inside the Action only).
3. Merge-base only (status quo) — zero setup but says "changed since
   branch point", not "changed since last green"; kept as the fallback chain
   already in `collectGit`.

## Decision

Option 1, implemented entirely in the composite Action; core whatbroke stays
forge-agnostic and just reads whatever journal file is present. The existing
fallback chain (journal → merge-base → HEAD~1) is unchanged, so a cache miss
degrades gracefully rather than failing.

## Consequences

**Good**: real diff-vs-green in PRs with one YAML line; no new core code paths;
the journal's last-write-wins semantics are acceptable because default-branch
runs are serialized per ref in practice.
**Bad**: cache eviction silently degrades to merge-base — the bundle's reason
strings already disclose which baseline was used, which is the mitigation.
