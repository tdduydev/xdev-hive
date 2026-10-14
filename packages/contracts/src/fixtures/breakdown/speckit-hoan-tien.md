# Tasks: Hoàn tiền một phần

**Input**: spec.md, plan.md của `specs/012-hoan-tien/`

## Format: `[ID] [P?] [Story] Description`

- **[P]**: chạy song song được (khác file, không chờ nhau)
- **[Story]**: user story của task (US1, US2…)

## Phase 1: Nền

**Purpose**: bảng và contract dùng chung cho mọi story.

- [ ] T001 Thêm bảng `refunds` trong `apps/api/src/refunds/schema.ts` (FR-001)
- [ ] T002 [P] Contract `POST /refunds` trong `packages/contracts/src/refunds.ts` (FR-002)
- [ ] T003 [P] Sinh migration `apps/api/db/migrations/0012_refunds.sql`
- [ ] T004 Seed dữ liệu thử cho đơn đã thanh toán

**Checkpoint**: nền sẵn sàng, các story bắt đầu.

---

## Phase 2: User Story 1 - Khách yêu cầu hoàn tiền (Priority: P1) 🎯 MVP

**Goal**: khách gửi yêu cầu hoàn tiền một phần cho đơn đã giao.

### Tests for User Story 1

- [ ] T005 [P] [US1] Test contract cho `POST /refunds` trong apps/api/test/refunds.contract.test.ts
- [ ] T006 [P] [US1] Test số tiền hoàn không vượt số đã trả (FR-003) (phụ thuộc T001)

### Implementation for User Story 1

- [ ] T007 [US1] Dịch vụ tạo yêu cầu trong `apps/api/src/refunds/service.ts` (FR-002, FR-003)
- [ ] T008 [US1] Gắn route vào router (depends on T002)
- [ ] T009 [US1] Ghi audit khi tạo yêu cầu (FR-004)

---

## Phase 3: User Story 2 - Kế toán duyệt hoàn tiền (Priority: P2)

**Goal**: kế toán duyệt hoặc từ chối yêu cầu.

- [ ] T010 [P] [US2] Màn danh sách yêu cầu trong `apps/web/src/pages/refunds.tsx`
- [ ] T011 [US2] Nút duyệt, từ chối gọi `POST /refunds/{id}/decide` (FR-005)
  - Phụ thuộc: T003
- [ ] T012 [US2] Thông báo cho khách khi có quyết định (FR-004)
- [ ] T013 [US2] Ẩn nút khi đơn đã hoàn đủ (phụ thuộc T010)
- [ ] T014 [US2] Test e2e luồng duyệt trong apps/web/e2e/refunds.spec.ts

---

## Dependencies & Execution Order

- **Phase 1**: không phụ thuộc.
- **Phase 2, Phase 3**: chờ Phase 1 xong; hai story chạy song song được.
