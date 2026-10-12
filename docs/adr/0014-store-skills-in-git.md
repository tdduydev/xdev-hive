# 0014. Store skills in Git with a PostgreSQL read cache

- Status: Accepted
- Date: 2026-10-12
- Deciders: maintainers

## Context

Skills (`SKILL.md`) guide agent CLIs during runs. Previously, skills were stored exclusively in PostgreSQL
(`skills` and `skill_versions` tables). However, engineering teams require standard Git workflows for skill
governance: version control with commit logs, peer review via pull requests, and direct compatibility with agent
CLI directories on local machines (`.claude/skills/` and `.agents/skills/`). Furthermore, organizations wish to
synchronize skills with shared repositories such as `tdduydev/xdev-skills`.

At the same time, agent runs require low-latency skill lookups over MCP (`skill_list`, `skill_get`), full-text
search, and strict multi-tenant access control (SKILL-01 through SKILL-05).

## Decision

Treat the Git repository as the canonical source of truth for skill definitions, while maintaining an RLS-enforced,
read-optimized cache in PostgreSQL:

1. **Repository Layout**:
   - `org/<skill-name>/SKILL.md` for organization-wide skills.
   - `teams/<team-slug>/<skill-name>/SKILL.md` for team-scoped skills.
   - `projects/<project-key>/<skill-name>/SKILL.md` for project-scoped skills.
   - Each skill contains a `SKILL.md` file with YAML frontmatter (`name`, `description`) and Markdown body.
2. **Synchronization**:
   - Webhooks delivered to `/hooks/skills/{repoId}` on push events parse changes and update the PostgreSQL cache within seconds.
   - `repoId` identifies the organization's skill repository connection, so the hub can find the tenant and that
     connection's webhook secret before trusting the payload (as `/hooks/git/{projectId}` does for projects). It
     is a separate path because `/hooks/git/{projectId}` would treat any fixed segment as a project ID.
   - A manual "Sync now" API triggers an immediate bidirectional reconciliation.
3. **Write Path**:
   - Direct edits on the hub create Git commits to the default branch (`main`) attributed to the editing user.
   - Skill change proposals open a Git pull request for review in Git; the decision stays on the hub, which then
     closes the pull request. An approved proposal reaches the default branch through the regular sync commit.
4. **Read Path**:
   - Agent MCP calls and web catalog listings query the PostgreSQL cache using `withTenant()`, benefiting from
     indexes and database RLS.
   - Scoped lookups support shadowing: a project or team skill overrides an organization skill with the identical name.

## Consequences

- Good: Skills live as native files in Git with full history, diffing, and PR review capabilities.
- Good: Developers and workers can clone or vendor skills into `.agents/skills/` directly.
- Good: Fast reads and RLS security boundaries remain in PostgreSQL without runtime Git API latency or rate limits.
- Bad: Eventual consistency between external Git pushes and the PostgreSQL cache (mitigated by webhook-driven sync).
- Bad: Potential merge conflicts when concurrent changes occur in Git and on the hub.

## Alternatives considered

- Pure PostgreSQL storage: Retaining skills solely in database tables prevents using Git-native developer workflows,
  branch reviews, and repository sharing.
- Pure Git queries without PostgreSQL caching: Fetching files over Git APIs or local clones on every agent run would
  introduce high latency, dependency on Git host availability, and complex multi-tenant indexing challenges.

## Links

- [0003](0003-postgresql-only-state.md), [0004](0004-row-level-security-tenancy.md), [srs.md (SKILL-01 to SKILL-05)](../srs.md#316-skills-repository-synchronization-skill), `specs/006-skills-repo-sync/`
