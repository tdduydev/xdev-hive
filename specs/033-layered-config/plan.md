# Implementation Plan: Layered configuration

**Branch**: `ai/SPEC033` | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/033-layered-config/spec.md`

## Summary

One registry of settings, one pure merge engine (ceiling, override, additive), and one effective-config read model, on
top of the data that already exists (`agent_policies`, `projects.settings`). The only new storage is a table for the
team layer and for locks. The hub computes the effective value; clients never merge (FR-066).

The work is split so that each slice ships alone and keeps today's behaviour:

1. **MVP (this implementation)**: registry, merge engine, layer sources (org policy, team entries, project settings),
   locks, effective-config read API with `configVersion`, team-layer write API with audit, contract, tests. Covers
   US1 (API side), US2, US3, US4 (API side), US8 (no behaviour change: existing `resolve*` keep their result).
2. **Later**: instance layer (US5), client snapshot cache and offline ageing in desktop and worker (US6), web pages per
   layer (FR-090 to FR-095), history view (US7 UI), project move between teams (US9), migration of the sandbox `locked`
   flag and skill-pack/MCP rules into the registry (FR-020, FR-071).

## Technical Context

**Language/Version**: TypeScript (Node runs `.ts` directly), zod 4, Drizzle, oRPC

**Primary Dependencies**: existing hub modules `governance`, `catalog`, `tenancy`, `audit`, `platform`

**Storage**: PostgreSQL. One new tenant table `config_layer_entries` with forced RLS

**Testing**: vitest unit tests for the engine and registry; `*.db.test.ts` for the module (CI only, Docker is not
available on this machine)

**Target Platform**: hub (Linux server); clients consume an oRPC contract

**Project Type**: web service module plus contracts

**Performance Goals**: effective config for one project computed on demand from three reads (policy row, team entries,
project row); no hub-side cache (spec Assumptions)

**Constraints**: no behaviour change for existing orgs (FR-070); no edits to `worker-protocol.ts` or to the paths
owned by other agents; contract-first (constitution I)

**Scale/Scope**: tens of teams, hundreds of projects; about 12 registry entries in the MVP

## Constitution Check

| Principle | Result |
|---|---|
| I. Contract first | New file `packages/contracts/src/layered-config.ts`, registered in `index.ts`, `openapi.json` regenerated |
| II. Tenant isolation | New table has `org_id`, RLS enabled and forced, covered by `rls.db.test.ts` pattern; all access through `withTenant()`; audit through `recordAudit()` |
| III. Module boundaries | New module `layers` imports only `governance`, `catalog`, `tenancy`, `audit`, `platform` through their `index.ts`. Nobody imports `layers` except `app.ts` |
| IV. Tested | Engine unit tests (property style over layers x kinds x locks), module db tests, contract round trip |
| V. Secure by default | Snapshot carries no secret; dangerous settings keep `policies.fullaccess`; unknown values fall back to the safe value |
| VI. Language | Vietnamese error messages, English code and specs |
| VII. Simple to self-host | No new service. The instance layer reads an environment variable list (spec Q1) |

No violations. Re-checked after design: unchanged.

## Design decisions

- **Registry in the hub, not in contracts.** The registry holds merge logic and safe values; clients only receive the
  merged result. Contracts carry the result shape and the setting keys.
- **Sources are adapters.** `sources.ts` maps the org policy and the project settings to flat `key -> value` maps, so
  the existing storage stays the source of truth (FR-071) and nothing is copied.
- **Team layer and locks use one table.** Rows are `(org_id, layer, target_id, key)`; `layer` is `org` (locks only in
  the MVP) or `team`. Optimistic `version` column per row for concurrent edits.
- **Existing resolvers delegate to the engine only where results are identical.** `clampBudget`, `resolvePermission`
  and `machineSlots` stay as they are in the MVP; a golden test asserts the engine returns the same value for the same
  inputs, so FR-016 can be finished later without risk.
- **`configVersion`** is a SHA-256 of the canonical JSON of the effective values (sorted keys), so clients reload only
  on change (FR-061).
- **Instance layer** is modelled in the engine (`LAYERS` includes `instance`) but has no storage yet; it contributes
  nothing, so adding it later changes no result.

## Project Structure

### Documentation (this feature)

```text
specs/033-layered-config/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/layered-config.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code

```text
packages/contracts/src/layered-config.ts      # layers, merge kinds, effective setting, snapshot, router contract
packages/contracts/src/index.ts               # register layeredConfig contract
apps/hub/src/modules/layers/
├── index.ts                                  # public surface
├── registry.ts                               # setting definitions
├── engine.ts                                 # pure merge (ceiling, override, additive, lock, over-ceiling)
├── sources.ts                                # org policy / project settings -> flat values
├── schema.ts                                 # config_layer_entries (RLS forced)
├── service.ts                                # effective config, team layer read/write, audit
├── router.ts                                 # oRPC handlers
├── engine.test.ts
├── sources.test.ts
├── service.db.test.ts
└── rls.db.test.ts
apps/hub/src/app.ts                           # mount the router
apps/hub/db/migrations/00NN_*.sql             # generated last, after merging origin/main
```

**Structure Decision**: a new hub module, because the feature spans governance, catalog and tenancy data and must not
make any of them import each other.

## Complexity Tracking

None.
