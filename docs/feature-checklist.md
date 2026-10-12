# Feature checklist (definition of done)

A feature is done when every applicable item below is checked in its pull request. Items that do not apply are marked
"n/a" with a short reason. The pull request template links here; `/speckit-checklist` generates the feature-specific
checks on top of this list.

## 1. Specification

- [ ] `specs/<NNN-feature>/spec.md` exists (`/speckit-specify`) with user stories and testable acceptance criteria.
- [ ] Open questions resolved (`/speckit-clarify`); nothing left as `[NEEDS CLARIFICATION]`.
- [ ] New or changed requirements have IDs and are listed in [docs/srs.md](srs.md).
- [ ] Out of scope is written down.

## 2. Design

- [ ] `plan.md` and `tasks.md` exist (`/speckit-plan`, `/speckit-tasks`) and `/speckit-analyze` reports no
      unresolved inconsistency.
- [ ] Architectural decisions (new service, store, protocol, dependency, security model) have an ADR in
      [docs/adr/](adr/).
- [ ] API and protocol changes are in `packages/contracts`; `pnpm openapi` was run and `openapi.json` committed.
- [ ] Worker protocol changes keep old workers and hubs working (optional fields, ignorable messages) and update the
      shared fixtures.
- [ ] UI designed with the `ui-ux-pro-max` skill and built from shadcn/ui components and design tokens.

## 3. Data and security

- [ ] New tables: migration generated with `db:generate`, RLS enabled and forced, `rls.db.test.ts` covers them.
- [ ] Enum or constraint changes tested by upgrading from the previous schema (`migrations-upgrade.db.test.ts`).
- [ ] Permission checks (organization and team roles) in the hub module, tested for allowed and denied users.
- [ ] Administrative writes recorded with `recordAudit()`.
- [ ] Secrets encrypted with the master key; never logged, returned twice, or placed in job specs.
- [ ] MCP tools: scoped by principal and run kind; read-only run kinds get no write tools.

## 4. Implementation

- [ ] Module boundaries respected (`pnpm deps`).
- [ ] User-facing text and error messages in Vietnamese; comments explain why.
- [ ] New configuration documented in `deploy/.env.example`, passed through `deploy/compose.yaml`, explained in
      [docs/self-hosting.md](self-hosting.md).

## 5. Tests

- [ ] Unit tests for logic; `*.db.test.ts` for SQL and RLS.
- [ ] Playwright for user flows, using roles and accessible names; light and dark; 360 px wide without horizontal
      scrolling.
- [ ] Worker changes: `gofmt`, `go vet`, `go test ./...` pass; behaviour that differs by OS is tested on Linux, macOS
      and Windows in CI.
- [ ] `pnpm check` passes locally.

## 6. Documentation

- [ ] [docs/add.md](add.md) and [docs/sdd.md](sdd.md) updated when building blocks, runtime flows, deployment or
      security change.
- [ ] README or self-hosting guide updated for anything an operator or user must do differently.

## 7. Delivery

- [ ] CI green; merged through the pull request.
- [ ] Deployed; `/api/v1/health` reports the merged commit; the feature checked on the deployed hub.
- [ ] Worker changes released with a `v*` tag when users need them ([docs/releasing.md](releasing.md)).
