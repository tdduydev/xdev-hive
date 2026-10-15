# 0010. Organise tenants as organization, team, system, project

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

One hub serves several teams of one organization; each team owns several products made of several repositories.

## Decision

Organization → team → system → project. Organization roles: owner, admin, member. Team roles: admin, member, viewer.
Machines belong to a team and only run that team's work. Project-level grants to other people or teams are planned,
not built.

## Consequences

- Good: permissions and machine pools follow team ownership.
- Bad: sharing a project across teams needs the planned grants.

## Links

- [sdd.md section 3](../sdd.md#3-information-viewpoint)
