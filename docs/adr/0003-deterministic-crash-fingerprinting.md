# ADR-0003: Deterministic crash fingerprinting (normalization, no LLM)

**Status**: Proposed (Roadmap Themes 1 & 3)
**Date**: 2026-07-10

## Context

Verify needs "same bug or new bug?" (failure-delta), history needs "have we
seen this before?" (recurrence), and watch mode needs dedup. All three need a
stable identity for a crash. An embedding/LLM similarity approach would be
non-deterministic and break the moat's core claim.

## Decision

A crash fingerprint is a SHA-256 over deterministic, normalized fields:
error name + normalized message (timestamps, hex addresses, tmp paths, port
numbers, and UUIDs replaced with placeholders) + top user-code frame
(file path relative to repo root, function name; line number excluded as too
volatile) + failing-test identity when present. `compareCrashes(a, b)` returns
`same | related | different` with `reasons[]` using fixed rules layered on the
same normalizer (`related` = same name + same top frame but different message,
or same test different frame).

## Consequences

**Good**: byte-deterministic (testable with a corpus of pairs); shared by
verify, history, stats, and watch, so they can never disagree; language-agnostic
because it consumes the adapter-parsed frame model, not raw text.
**Bad**: normalization rules will need curation (a corpus test with known
same/different pairs is the regression harness); excluding line numbers trades
some precision for stability across edits — deliberate, since the fix itself
moves lines.
