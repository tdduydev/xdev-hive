# Data model: Chạy CI/CD và triển khai trên worker

## Hub: bảng `delivery_jobs` (mới, RLS)

Một dòng mỗi lần hub giao việc cho worker. Lần triển khai chạy lại thì có dòng mới.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | id việc, worker dùng làm khoá idempotent |
| `org_id` | uuid | RLS `orgScoped` |
| `deploy_id` | uuid null | lần triển khai (FR-021); null với thao tác CI |
| `kind` | text | `ssh-script`, `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl`, `health`, `ci-action` |
| `state` | text | `waiting` (chưa có máy), `leased`, `running`, `succeeded`, `failed`, `lost`, `canceled` |
| `worker_id` | uuid null | máy đang giữ hoặc đã chạy |
| `config_version` | int | phiên bản cấu hình đích đã khoá lúc giao |
| `attempt` | int | tăng khi lease hết hạn và giao lại |
| `lease_expires_at` | timestamptz null | |
| `error_code` | text null | thuộc `DELIVERY_ERRORS` |
| `error_message` | text null | một dòng, đã che |
| `credential_names` | text[] | chỉ tên (FR-091) |
| `created_at`, `updated_at`, `finished_at` | timestamptz | |

Chỉ mục: `(org_id, state)`, `(deploy_id)`. Không có cột log (FR-050).

## Hub: cột thêm

- Môi trường: `runner` (`worker` mặc định, `legacy`), `runner_machines` (uuid[] theo thứ tự), `runner_label_required` (bool).
- Lần triển khai: `ran_on_worker_id` (uuid null); null và có `ran_legacy = true` hiển thị "chạy bằng hub (cũ)" (FR-085).

## Worker: đĩa

- `delivery-logs/<jobId>.log`: log đầy đủ, giữ theo chính sách giữ log (FR-053).
- Không có file credential. Credential ở kho hệ điều hành, không gian tên `delivery/<name>`.

## Chuyển trạng thái

```text
waiting -> leased -> running -> succeeded | failed
   |         |          \-> lost (mất lease, giao lại: attempt + 1, quay về leased)
   \-> canceled (huỷ hoặc quá 15 phút chưa có máy: failed runner_offline)
```
