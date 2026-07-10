# ADR-0004: Crash history is a local index file — no backend, no telemetry

**Status**: Proposed (Roadmap Theme 3)
**Date**: 2026-07-10

## Context

Crash history and the suspect hit/miss ledger could be served by a hosted
backend (enabling team-shared history and network effects) or kept purely
local like the journal. whatbroke's trust posture and adoption story are built
on "no account, no network, secrets never leave the machine."

## Considered Options

1. **Local `.whatbroke/index.json`**, same discipline as the journal
   (atomic temp-file-then-rename writes, self-GC, corrupt→empty).
2. Hosted service — enables team history but destroys the zero-trust pitch,
   adds an operational surface, and creates a place secrets could go; rejected.
3. Git-committed history (share via repo) — leaks bundle metadata into the
   repo and conflicts with the auto-gitignore decision; rejected for v1.
   CI-cache sharing (ADR-0005) covers the team case for the journal.

## Decision

Option 1. The index stores only derived metadata (fingerprint, suspect paths,
resolved status, resolving sha, hit/miss booleans) — never log or diff content,
so it adds no new redaction surface. `whatbroke stats` reads it locally.
Nothing in the index ever leaves the machine.

## Consequences

**Good**: moat-compatible (accumulated local ground truth), zero new trust
asks, same tested persistence patterns as the journal.
**Bad**: history doesn't transfer between clones or teammates; accepted —
the CI journal (ADR-0005) is the sanctioned shared-baseline mechanism.
