# Epics

## Epic 1: Hoàn tiền

Mục tiêu: khách hoàn tiền không cần gọi tổng đài (FR1, NFR2).

### Story 1.1: Tạo yêu cầu hoàn tiền
As a khách hàng,
I want gửi yêu cầu hoàn tiền,
so that tôi nhận lại tiền.

#### Acceptance Criteria

1. Given đơn đã thanh toán, when khách bấm hoàn tiền, then hệ thống tạo yêu cầu (FR1).

#### Tasks / Subtasks

- [ ] Thêm bảng `refund_requests`
- [ ] Thêm API tạo yêu cầu
  - [ ] Kiểm hạn hoàn tiền

### Story 1.2: [P] Màn duyệt hoàn tiền

Dự án: web-shop
**Phụ thuộc**: Story 1.1

- [ ] Trang danh sách yêu cầu (FR3)

## Epic 2: Báo cáo

### Story 2.1: Báo cáo hoàn tiền theo tháng

**Phụ thuộc**: 1.1, 1.2

Tổng hợp số yêu cầu theo tháng (NFR2).
