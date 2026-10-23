# Implementation Plan: Chạy CI/CD và triển khai trên worker trong mạng nội bộ

**Branch**: `032-worker-delivery` · **Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

- Thiết kế dữ liệu: [data-model.md](data-model.md).
- Giao diện: [contracts/delivery-job-protocol.md](contracts/delivery-job-protocol.md).
- Kiểm tay: [quickstart.md](quickstart.md).

Nhãn **[Unverified]** đánh dấu điều chưa kiểm trên máy thật. Máy viết plan này không có toolchain Go, nên mã Go chỉ được
CI kiểm; xem research D8.

## Tóm tắt

Hôm nay hub tự gọi Jenkins, Argo CD, Kubernetes và SSH (spec 020). Hub nằm ngoài mạng nội bộ nên không với tới. Plan này
chuyển phần **gọi hệ thống ngoài** sang worker; hub giữ cấu hình, duyệt, khoá, lịch sử.

**Contracts** (`packages/contracts/src/delivery-worker.ts`, file mới, không đụng `worker-protocol.ts`):

- `deliveryJobSpec`: việc hub giao (id, loại, phiên bản cấu hình, đích, **tên** credential, tham số);
- `deliveryEvent`: tiến độ worker báo (bước, trạng thái, mã lỗi, siêu dữ liệu; không có log);
- `deliveryCapability`: khả năng worker báo ở `hello`/heartbeat;
- `credentialRef`: tên tham chiếu `[a-z0-9-]{1,64}`.

Mọi dữ liệu delivery trên worker gắn với `Scope` (một đăng ký máy-tổ chức-hub, specs/034): kho credential
`delivery/<registration>/<tên>`, `<root>/<registration>/delivery-logs`, `delivery-work`. Gói không đọc `internal/config`;
nơi gọi truyền `Scope` vào (FR-104..106).

**Worker** (`worker/internal/delivery/`, gói mới):

- `CredentialReader`: giao diện đọc credential theo tên. Bản thật bọc `secretstore` (do luồng khác sở hữu); bản thử là map;
- client Jenkins, Argo CD, Kubernetes REST, health, SSH, port từ client TypeScript ở hub và dùng lại fixture
  `delivery/fixtures/*`;
- `Executor`: nhận `deliveryJobSpec`, chạy đúng cách, phát `deliveryEvent`, ghi log đầy đủ ra đĩa máy.

**Hub**:

- bảng `delivery_jobs` (một dòng mỗi lần giao việc, có lease, số lần thử, máy nhận);
- `runner-select.ts`: chọn máy theo FR-013 (thuần, test được không cần DB);
- cột "máy chạy" cho lần triển khai; cờ `runner` cho từng môi trường (`worker` hoặc `legacy`);
- đường legacy giữ nguyên sau cờ `HIVE_DELIVERY_OUTBOUND`.

**Chưa làm trong lượt này** (cần file do luồng khác giữ): nối vào `worker/internal/channel` (nhận việc, gửi sự kiện),
thêm khả năng ở `hello`, tab "Credential triển khai" trên desktop, trang "Chuyển sang worker". Ghi ở
`SUMMARY-SPEC032.md`.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | Go 1.27 (worker), TypeScript (hub, contracts, web) |
| Phụ thuộc mới | không. SSH dùng `golang.org/x/crypto/ssh` đã có; HTTP dùng `net/http` |
| Lưu trữ | Postgres: bảng `delivery_jobs`, cột mới ở bảng lần triển khai; đĩa worker: log lần chạy |
| Kiểm thử | `go test` + `httptest` với fixture; vitest cho contracts và `runner-select`; `*.db.test.ts` cho bảng |
| Nền tảng | Windows, macOS, Linux (FR-100); không gọi `ssh`, `kubectl`, `curl` |
| Ràng buộc | hub không nhận giá trị credential; log không về hub; tương thích worker cũ (FR-086) |
| Quy mô | vài chục máy, vài trăm lần triển khai mỗi ngày mỗi tổ chức |

## Constitution Check

| Nguyên tắc | Đạt | Ghi chú |
|---|---|---|
| I. Contract first | có | zod ở file mới, trường mới tuỳ chọn, worker cũ bỏ qua trường lạ |
| II. RLS cho bảng mới | có | `delivery_jobs` có `org_id`, `orgScoped`; thêm vào `rls.db.test.ts` |
| III. Test trước | có | mỗi task kèm test cùng commit |
| IV. Giao diện tiếng Việt | có | mã lỗi mới có thông điệp tiếng Việt trong `DELIVERY_ERRORS` |
| V. Không lộ bí mật | có | hub chỉ giữ tên; test khẳng định payload không chứa giá trị |

## Cấu trúc mã

```text
packages/contracts/src/delivery-worker.ts        # mới
worker/internal/delivery/                        # mới: creds, errors, jenkins, argocd, kube, health, ssh, executor
apps/hub/src/modules/delivery/runner-select.ts   # mới, thuần
apps/hub/src/modules/delivery/schema.ts          # thêm delivery_jobs, runner cho môi trường
apps/hub/db/migrations/                          # sinh ở cuối, sau khi merge main
```

## Quyết định của người viết

Chưa được chủ dự án chốt; đổi thì sửa task tương ứng.

- Q1 (siêu dữ liệu lỗi): mã lỗi từ danh mục + một dòng thông điệp đã che. Không gửi stderr.
- Q2 (chuyển đổi): mỗi môi trường có cờ `runner`; mặc định `worker`.
- Q3 (nhãn runner): có, nhãn `delivery-runner` do admin gắn; môi trường chưa đòi nhãn thì máy nào có khả năng cũng nhận.
