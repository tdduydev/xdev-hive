# Tasks: SDLC Pipeline

**Input**: Design documents from `/specs/056-sdlc-pipeline/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create module skeleton in hub/src/sdlc/ per implementation plan
- [ ] T002 [P] Add sdlc config keys to hub/src/config.ts
- [ ] T003 [P] Configure lint rules for hub/src/sdlc/
- [ ] T004 Add sdlc feature flag in hub/src/flags.ts
- [ ] T005 [P] Document setup in docs/sdlc/README.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story

- [ ] T006 Create gates table migration in hub/db/migrations/0031_gates.sql
- [ ] T007 [P] Gate model in hub/src/sdlc/models/gate.ts
- [ ] T008 [P] Pipeline model in hub/src/sdlc/models/pipeline.ts
- [ ] T009 Repository layer in hub/src/sdlc/repo.ts (depends on T006)
- [ ] T010 Event bus wiring in hub/src/sdlc/events.ts
- [ ] T011 [P] Error codes in hub/src/sdlc/errors.ts
- [ ] T012 Permission checks in hub/src/sdlc/auth.ts (FR-010)
- [ ] T013 Seed default pipelines in hub/src/sdlc/seed.ts (depends on T008)

---

## Phase 3: User Story 1 - Create a pipeline from an idea (Priority: P1) 🎯 MVP

**Goal**: deliver user story 1

**Independent Test**: exercise story 1 end to end

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T014 [P] [US1] Contract test 1 for story 1 in hub/test/contract/us1_1.test.ts (FR-001)
- [ ] T015 [P] [US1] Contract test 2 for story 1 in hub/test/contract/us1_2.test.ts (FR-002)
- [ ] T016 [P] [US1] Contract test 3 for story 1 in hub/test/contract/us1_3.test.ts (FR-003)

### Implementation for User Story 1

- [ ] T017 [P] [US1] Implement step 1 of story 1 in hub/src/sdlc/us1/step1.ts (FR-001)
- [ ] T018 [P] [US1] Implement step 2 of story 1 in hub/src/sdlc/us1/step2.ts (FR-002)
- [ ] T019 [US1] Implement step 3 of story 1 in hub/src/sdlc/us1/step3.ts (FR-003)
- [ ] T020 [US1] Implement step 4 of story 1 in hub/src/sdlc/us1/step4.ts (FR-001)
- [ ] T021 [US1] Implement step 5 of story 1 in hub/src/sdlc/us1/step5.ts (FR-002)
- [ ] T022 [US1] Implement step 6 of story 1 in hub/src/sdlc/us1/step6.ts (FR-003)
- [ ] T023 [US1] Implement step 7 of story 1 in hub/src/sdlc/us1/step7.ts (FR-001)
- [ ] T024 [US1] Implement step 8 of story 1 in hub/src/sdlc/us1/step8.ts (FR-002) (depends on T017)

**Checkpoint**: User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Review gate documents (Priority: P1)

**Goal**: deliver user story 2

**Independent Test**: exercise story 2 end to end

### Tests for User Story 2 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T025 [P] [US2] Contract test 1 for story 2 in hub/test/contract/us2_1.test.ts (FR-004)
- [ ] T026 [P] [US2] Contract test 2 for story 2 in hub/test/contract/us2_2.test.ts (FR-005)

### Implementation for User Story 2

- [ ] T027 [P] [US2] Implement step 1 of story 2 in hub/src/sdlc/us2/step1.ts (FR-004)
- [ ] T028 [P] [US2] Implement step 2 of story 2 in hub/src/sdlc/us2/step2.ts (FR-005)
- [ ] T029 [US2] Implement step 3 of story 2 in hub/src/sdlc/us2/step3.ts (FR-004)
- [ ] T030 [US2] Implement step 4 of story 2 in hub/src/sdlc/us2/step4.ts (FR-005)
- [ ] T031 [US2] Implement step 5 of story 2 in hub/src/sdlc/us2/step5.ts (FR-004)
- [ ] T032 [US2] Implement step 6 of story 2 in hub/src/sdlc/us2/step6.ts (FR-005)
- [ ] T033 [US2] Implement step 7 of story 2 in hub/src/sdlc/us2/step7.ts (FR-004) (depends on T027)

**Checkpoint**: User Story 2 should be fully functional and testable independently

---

## Phase 5: User Story 3 - Run tasks in waves (Priority: P2)

**Goal**: deliver user story 3

**Independent Test**: exercise story 3 end to end

### Tests for User Story 3 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T034 [P] [US3] Contract test 1 for story 3 in hub/test/contract/us3_1.test.ts (FR-006)
- [ ] T035 [P] [US3] Contract test 2 for story 3 in hub/test/contract/us3_2.test.ts (FR-007)

### Implementation for User Story 3

- [ ] T036 [P] [US3] Implement step 1 of story 3 in hub/src/sdlc/us3/step1.ts (FR-006)
- [ ] T037 [P] [US3] Implement step 2 of story 3 in hub/src/sdlc/us3/step2.ts (FR-007)
- [ ] T038 [US3] Implement step 3 of story 3 in hub/src/sdlc/us3/step3.ts (FR-006)
- [ ] T039 [US3] Implement step 4 of story 3 in hub/src/sdlc/us3/step4.ts (FR-007)
- [ ] T040 [US3] Implement step 5 of story 3 in hub/src/sdlc/us3/step5.ts (FR-006)
- [ ] T041 [US3] Implement step 6 of story 3 in hub/src/sdlc/us3/step6.ts (FR-007) (depends on T036)

**Checkpoint**: User Story 3 should be fully functional and testable independently

---

## Phase 6: User Story 4 - Trace requirements to PRs (Priority: P3)

**Goal**: deliver user story 4

**Independent Test**: exercise story 4 end to end

### Tests for User Story 4 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T042 [P] [US4] Contract test 1 for story 4 in hub/test/contract/us4_1.test.ts (FR-008)
- [ ] T043 [P] [US4] Contract test 2 for story 4 in hub/test/contract/us4_2.test.ts (FR-009)

### Implementation for User Story 4

- [ ] T044 [P] [US4] Implement step 1 of story 4 in hub/src/sdlc/us4/step1.ts (FR-008)
- [ ] T045 [P] [US4] Implement step 2 of story 4 in hub/src/sdlc/us4/step2.ts (FR-009)
- [ ] T046 [US4] Implement step 3 of story 4 in hub/src/sdlc/us4/step3.ts (FR-008)
- [ ] T047 [US4] Implement step 4 of story 4 in hub/src/sdlc/us4/step4.ts (FR-009)
- [ ] T048 [US4] Implement step 5 of story 4 in hub/src/sdlc/us4/step5.ts (FR-008) (depends on T044)

**Checkpoint**: User Story 4 should be fully functional and testable independently

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T049 [P] Docs updates in docs/sdlc/
- [ ] T050 Code cleanup and refactoring
- [ ] T051 [P] Performance optimization across all stories
- [ ] T052 Additional unit tests in hub/test/unit/
- [ ] T053 [P] Security hardening of hub/src/sdlc/auth.ts
- [ ] T054 Run quickstart.md validation
- [ ] T055 [P] Metrics dashboard in web/src/pages/sdlc-metrics.tsx
- [ ] T056 Accessibility pass on web/src/pages/sdlc.tsx
- [ ] T057 [P] Translate UI strings in web/src/i18n/vi.json
- [ ] T058 Release notes in docs/releases/0.9.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Contract test 1 for story 1 in hub/test/contract/us1_1.test.ts"
- [ ] T999 not a task, inside a code fence
```
