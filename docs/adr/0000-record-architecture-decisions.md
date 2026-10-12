# 0000. Record architecture decisions as ADRs

- Status: Accepted
- Date: 2026-10-12
- Deciders: maintainers

## Context

The rewrite's decisions were recorded in one Vietnamese table, [decisions.md](../decisions.md). It mixes scope, stack
versions and design choices, has no status per decision, and gives no place to record why a later change departs
from it (for example the worker updater in [0011](0011-signed-worker-releases-and-own-updater.md)).

## Decision

Record each architecturally significant decision as one Markdown file in `docs/adr/`, numbered `NNNN-title.md`,
using the MADR layout in [template.md](template.md), in English. A decision that changes an earlier one adds a new ADR
and marks the old one `Superseded`. `decisions.md` stays as the original record of scope and pinned versions; ADRs
0001 to 0010 restate its design decisions in this form.

A pull request needs an ADR when it adds a runtime service, store, queue or external dependency, changes a protocol
or the security model, or departs from an accepted ADR ([feature-checklist.md](../feature-checklist.md)).

## Consequences

- Good: each decision has a status, a date and its reasons; reviewers can check plans against them.
- Bad: two places to read for history before 12 October 2026.

## Links

- [ADR index](README.md)
