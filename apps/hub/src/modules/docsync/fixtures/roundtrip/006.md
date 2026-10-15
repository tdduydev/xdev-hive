# 0004. Isolate tenants with PostgreSQL row-level security

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

Many organizations and teams share one hub and one database. A missing `WHERE org_id = …` in application code must
not leak data (SRS TEN-05, NFR-01).

## Decision

Every tenant table has `org_id`, row-level security enabled and forced, and policies that compare rows with the
transaction's tenant settings.
The hub connects as `hive_app` (not owner, no `BYPASSRLS`) and runs organization queries through `withTenant()`,
which sets `app.user_id` and `app.org_id` with `set_config(..., true)` inside the transaction. Lookups before the
tenant is known (machine tokens, invitations) set a token-hash setting that policies accept for that row only. Four
roles: `hive_owner` (migrations), `hive_app`, `hive_auth` (Better Auth schema), `hive_jobs` (pg-boss).

## Consequences

- Good: isolation holds even when application code forgets a filter; tested by `rls.db.test.ts` suites.
- Bad: every new table needs policies and a test; queries outside `withTenant()` return nothing, which surprises
  newcomers.

## Alternatives considered

- Database per tenant: heavy operations for many small teams.
- Application-level filtering only: one bug away from a leak.

## Links

- [add.md section 8.1](../add.md#81-multi-tenancy)
