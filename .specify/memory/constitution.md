# xDev Hive Constitution

Rules every feature spec, plan and implementation in this repository follows. They restate the conventions in
[AGENTS.md](../../AGENTS.md) and the design in [docs/add.md](../../docs/add.md) as checks that `/speckit-plan`,
`/speckit-analyze` and `/speckit-checklist` can apply. Where this file and AGENTS.md disagree, AGENTS.md wins and this
file is amended.

## Core Principles

### I. Contract first

Every API and worker protocol change starts in `packages/contracts` as zod schemas. `pnpm openapi` regenerates
`openapi.json`, which is committed; CI fails on drift. Worker protocol changes also update
`packages/contracts/fixtures/worker-protocol.json` and the hand-written Go types, and must stay compatible with workers
already deployed (new optional fields, new message types that old peers can ignore).

### II. Tenant isolation is not optional

All organization data is read and written through `withTenant()` with the `hive_app` role. Every new tenant table
enables and forces row-level security in its migration and is covered by an `rls.db.test.ts` suite. Authorization
(organization and team roles) is checked in the module, not only in the UI. Writes that matter to an administrator are
recorded with `recordAudit()`.

### III. Module boundaries

Hub modules import each other only through `index.ts`; `pnpm deps` enforces it. New cross-module needs are added to
the exporting module's `index.ts` with a reason, never by deep imports.

### IV. Tested before merged (non-negotiable)

A feature ships with tests at the level where it can break: unit tests for logic, `*.db.test.ts` for SQL, RLS and
migrations (including upgrade from the previous schema when enums or constraints change), Playwright for user flows,
and Go tests on Linux, macOS and Windows for worker changes. `pnpm check` passes locally and CI is green before merge.

### V. Secure by default

No secrets in the repository, logs, test fixtures that look real, or job specs. Secrets at rest use the master key
envelope encryption. Agents get the least privilege their run kind needs. Anything downloaded and executed (worker
releases) is signed and verified. Security-relevant behaviour is documented in `docs/add.md` section 8.

### VI. Vietnamese for people, English for code

User-facing text and API error messages are Vietnamese. Code identifiers, specs under `specs/`, and engineering
documents (ADD, SDD, SRS, ADR) are English. Comments explain why, not what.

### VII. Simple to self-host

PostgreSQL is the only stateful dependency. A new runtime service, queue, store or external SaaS needs an ADR in
`docs/adr/` that weighs it against using PostgreSQL or the existing hub process. Configuration goes through
documented environment variables (`deploy/.env.example`, `deploy/compose.yaml`).

## User interface

- Screens are designed with the `ui-ux-pro-max` skill and built from shadcn/ui components (Base UI primitives) through
  the shadcn MCP server; one-off styling is the exception.
- Colours, type, spacing, radius and shadows come from design tokens (CSS variables); no hard-coded colours.
- Every screen works at 360 px wide without horizontal scrolling, in light and dark themes, with keyboard navigation
  and visible focus, and is covered by Playwright using roles and accessible names.

## Development workflow

1. `/speckit-specify` writes `specs/<NNN-feature>/spec.md`; requirements get IDs that `docs/srs.md` lists.
2. `/speckit-clarify` resolves ambiguity before planning.
3. `/speckit-plan` produces the plan; architectural choices get an ADR.
4. `/speckit-tasks`, then `/speckit-analyze` for consistency, then `/speckit-implement`.
5. `/speckit-checklist` and [docs/feature-checklist.md](../../docs/feature-checklist.md) are the definition of done.
6. Work happens on a branch, merges through a pull request with green CI, and is deployed and checked with
   `/api/v1/health`.

## Governance

This constitution is changed by pull request like code. Changing a principle bumps the major version, adding one bumps
the minor version, wording fixes bump the patch version. Reviews check plans and pull requests against it; a deviation
is allowed only with a written reason in the plan's complexity tracking section or an ADR.

**Version**: 1.0.0 | **Ratified**: 2026-10-12 | **Last Amended**: 2026-10-12
