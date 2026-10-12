# 0012. Specify features with Spec Kit and a definition of done

- Status: Accepted
- Date: 2026-10-12
- Deciders: maintainers

## Context

Features were planned in chat and pull request descriptions, with no stable requirement IDs and no shared definition
of done. Several agents and people work on the repository.

## Decision

Use GitHub Spec Kit (`specify` 1.1.3, Claude integration as skills in `.claude/skills/speckit-*`, project files in
`.specify/`). Each feature gets `specs/<NNN-feature>/` with spec, plan and tasks; requirement IDs go into
[srs.md](../srs.md). The constitution in `.specify/memory/constitution.md` restates AGENTS.md as checks.
[feature-checklist.md](../feature-checklist.md) is the definition of done, linked from the pull request template.

## Consequences

- Good: traceable requirements and consistent plans; agents follow the same workflow.
- Bad: more documents per feature; Spec Kit updates must be pulled deliberately (`specify init --here --force`).

## Links

- https://github.com/github/spec-kit
