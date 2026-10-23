# Research: Chạy CI/CD và triển khai trên worker

## D1. Gói tin mới nằm ở file contracts riêng

- **Quyết định**: `packages/contracts/src/delivery-worker.ts`. `worker-protocol.ts` do luồng khác giữ.
- **Lý do**: tránh xung đột file; trường mới là tuỳ chọn nên worker cũ bỏ qua.
- **Hệ quả**: nối vào `channel` (nhận việc, gửi sự kiện) cần luồng giữ `channel/**` làm. Điểm nối ghi ở SUMMARY.

## D2. Credential qua giao diện, không gọi thẳng kho

- **Quyết định**: gói `delivery` khai `CredentialReader{ Read(name) ([]byte, error) }`. Tên kho là `delivery/<name>`.
- **Lý do**: `secretstore` do luồng khác sở hữu và đang đổi; giao diện cho phép thử bằng map và nối sau.
- **Hệ quả**: thiếu credential trả `missing_credential` (FR-066). Giá trị chỉ nằm trong bộ nhớ (FR-063).

## D3. Một gói Go, mỗi hệ thống một file

- **Quyết định**: `worker/internal/delivery/{jenkins,argocd,kube,health,ssh}.go`.
- **Lý do**: dùng chung kiểu lỗi và `Event`; client nhỏ (vài trăm dòng) khi port từ TS.
- **Dùng lại**: fixture `apps/hub/src/modules/delivery/fixtures/{jenkins,argocd,kube}` để chắc hai bên hiểu cùng một dạng
  JSON.

## D4. Kubernetes bằng REST, không `client-go`

- **Quyết định**: gọi API server bằng `net/http` với bearer token và CA, như `clients/kube.ts`.
- **Lý do**: `client-go` kéo hàng chục MB phụ thuộc; chỉ cần GET và PATCH workload.

## D5. Chọn máy là hàm thuần ở hub

- **Quyết định**: `selectRunner(candidates, machines, needs)` trả máy đầu tiên đủ điều kiện hoặc lý do chờ.
- **Lý do**: logic FR-013 dễ sai (thứ tự, nhãn, khả năng); test thuần nhanh và không cần Docker.

## D6. Log ở đĩa worker

- **Quyết định**: worker ghi `delivery-logs/<jobId>.log` dưới thư mục dữ liệu, che bằng bộ che chung khi có. Hub chỉ nhận
  `deliveryEvent` không có thân log (FR-050).
- **Lý do**: log deploy hay chứa tên máy, đường dẫn, đôi khi bí mật; đã chốt ở spec.

## D7. Hợp đồng chỉ có mã lỗi từ danh mục

- **Quyết định**: `deliveryEvent.error.code` thuộc `DELIVERY_ERRORS` hiện có, thêm `missing_credential`,
  `runner_offline`, `lease_expired`.
- **Lý do**: UI đã dịch các mã này; thêm ít nhất.

## D8. Máy viết plan không có Go

- **Sự kiện**: `go` không có trong PATH, không có trong `Program Files`. [Unverified] mọi mã Go.
- **Biện pháp**: viết mã đơn giản, tránh tính năng lạ, test dùng `httptest`; CI chạy `go vet` và `go test` trên ba hệ điều
  hành. Task cuối của mỗi nhóm Go ghi "chạy trên máy có Go".
