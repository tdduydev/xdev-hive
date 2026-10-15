# Tasks

## 1. Chuẩn bị

- [x] 1.1 Thêm bảng `refund_requests` (REQ-001)
- [ ] 1.2 Sinh migration
  - Chạy `pnpm db:generate`

## 2. API hoàn tiền

**Phụ thuộc**: 1

- [ ] 2.1 Thêm route `POST /refunds` theo REQ-002
- [ ] 2.2 Kiểm quyền người duyệt

## 3. Giao diện

Dự án: web-shop
**Phụ thuộc**: 2.1

- [ ] 3.1 [P] Nút hoàn tiền ở `apps/web/src/pages/orders.tsx`
