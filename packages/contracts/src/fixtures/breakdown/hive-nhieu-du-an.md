# Tasks: Hoàn tiền (nhiều dự án)

**Input**: spec.md (R-1…R-4), plan.md

## Phase 1: API hoàn tiền

- [ ] T001 Bảng và API `POST /refunds` (R-1)
  - **Scope**: `apps/api/src/refunds/{schema.ts,router.ts}`, `apps/api/db/migrations/0012_*.sql`
  - **Phụ thuộc**: không · **Mức**: nặng
- [ ] T002 [P] Webhook báo trạng thái hoàn tiền (R-2)
  - **Scope**: `apps/api/src/refunds/webhook.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

## Phase 2: Web

Dự án: web-shop

- [ ] T003 [P] Màn yêu cầu hoàn tiền (R-3)
  - **Scope**: `src/pages/refund.tsx`
  - **Phụ thuộc**: T001 · **Mức**: vừa
- [ ] T004 Hiện trạng thái từ webhook
  - **Phụ thuộc**: T002, T003 · **Mức**: nhẹ

## Phase 3: Mobile

- [ ] T005 [P] [@mobile-app] Màn hoàn tiền trên app (R-3)
  - **Scope**: `lib/screens/refund.dart`
  - **Phụ thuộc**: T001 · **Mức**: vừa
