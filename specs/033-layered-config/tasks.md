---
description: "Task list: layered configuration"
---

# Tasks: Layered configuration

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

Format: `- [ ] T### [P?] [USn?] description (file)`. `[P]` means it can run in parallel with other `[P]` tasks.
The MVP is Phases 1 to 4. Later phases are listed so nothing is lost; they are not part of this implementation.

## Phase 1: Contract and engine (MVP)

- [x] T001 [US1] Define layers, merge kinds, effective setting, snapshot and the `layeredConfig` router contract; register it in the root contract (`packages/contracts/src/layered-config.ts`, `packages/contracts/src/index.ts`)
- [x] T002 [US1] Registry of the MVP settings with kind, layers, default, safe value, dangerous flag (`apps/hub/src/modules/layers/registry.ts`)
- [x] T003 [US2] Pure merge engine: ceiling, override, additive, lock, over-ceiling, `configVersion` hash (`apps/hub/src/modules/layers/engine.ts`)
- [x] T004 [US2] Engine unit tests: every kind, lock above and below, over-ceiling, null versus unset, additive deny wins, 100 randomised layer combinations never widen a ceiling (`apps/hub/src/modules/layers/engine.test.ts`)

## Phase 2: Sources and storage (MVP)

- [x] T005 [US8] Adapters from org policy and project settings to flat values; golden test that the engine matches `clampBudget`, `resolvePermission` and `machineSlots` (`apps/hub/src/modules/layers/sources.ts`, `sources.test.ts`)
- [x] T006 [US3] Table `config_layer_entries` with forced RLS (`apps/hub/src/modules/layers/schema.ts`)
- [x] T007 [US3] Service: effective config for a project, team entries read and write with permission, ceiling and lock checks, optimistic version, audit (`apps/hub/src/modules/layers/service.ts`)
- [x] T008 [US2] Org lock write path with audit (`apps/hub/src/modules/layers/service.ts`)

## Phase 3: API (MVP)

- [x] T009 [US1] oRPC router and mount in `app.ts`; public surface in `index.ts` (`apps/hub/src/modules/layers/router.ts`, `index.ts`, `apps/hub/src/app.ts`)
- [x] T010 [US1] DB tests for the service, including permission matrix and a project that is not visible to the caller (`apps/hub/src/modules/layers/service.db.test.ts`)
- [x] T011 RLS test in the pattern of `rls.db.test.ts` (`apps/hub/src/modules/layers/rls.db.test.ts`)

## Phase 4: Wrap up (MVP)

- [x] T012 Run `pnpm openapi`, commit `openapi.json`
- [x] T013 `git fetch && git merge origin/main`, then generate the migration (`apps/hub/db/migrations`)
- [x] T014 biome, typecheck, `pnpm deps`, vitest for the module

## Phase 5: Later (not in the MVP)

- [ ] T020 [US5] Instance layer: `HIVE_INSTANCE_ADMINS`, non-RLS table with grants, system page
- [ ] T021 [US6] Add `configVersion` and the safe subset to the job offer (needs `worker-protocol.ts` and `worker/internal/channel`)
- [ ] T022 [US6] Desktop snapshot cache with the 24 hour and 14 day ageing rules
- [ ] T023 [US1] Web: effective config page for a project, source and lock badges (FR-041, FR-093, FR-094)
- [ ] T024 [US3] Web: team configuration page (FR-092)
- [ ] T025 [US2] Web: lock buttons and source labels on `/admin/policies` (FR-091)
- [ ] T026 [US7] Config history view with the "affects this project" filter (FR-082)
- [ ] T027 [US9] Move a project between teams with preview (FR-031)
- [ ] T028 [US8] Fold `sandbox_org_settings.locked`, skill-pack and MCP rules into the registry (FR-020, FR-071)
- [x] T029 [US8] Make `resolveModel`, `resolvePermission`, `clampBudget`, `machineSlots` call the engine (FR-016)
- [ ] T030 [US8] SDLC modes (auto-approve floor, deny paths) as layered settings. Deferred: `apps/hub/src/modules/sdlc/**` and `packages/contracts/src/sdlc.ts` belong to spec 035 work right now; start after it merges
