# 0008. Use Better Auth for authentication with invitation-only sign-up

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

Organizations need SSO (OIDC), GitHub and GitLab sign-in and e-mail and password; MCP clients need OAuth. The hub is
internal to each organization, so strangers must not create accounts (SRS AUTH-01 to AUTH-05, MCP-02).

## Decision

Better Auth handles authentication (sessions, providers, per-organization SSO, JWT, OAuth for MCP with client ID
metadata documents). Organizations, teams and roles are the hub's own tables in module `tenancy`, not the Better Auth
organization plugin, to keep the four-level structure and row-level security. Sign-up requires an invitation, a
creator listing (`HIVE_ORG_CREATORS`, first organization only) or a verified SSO domain.

## Consequences

- Good: mature providers and MCP OAuth support; tenancy stays under the hub's RLS model.
- Bad: Better Auth has a history of security fixes and must be kept current.

## Links

- [add.md section 8.2](../add.md#82-authentication-and-tokens)
