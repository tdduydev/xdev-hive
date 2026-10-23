# Giao thức việc delivery giữa hub và worker

Định nghĩa zod ở `packages/contracts/src/delivery-worker.ts`. Mọi trường mới là tuỳ chọn hoặc có `.default()`; worker cũ
bỏ qua trường lạ (FR-086).

## Khả năng (worker báo ở `hello` và heartbeat)

```json
{ "delivery": { "methods": ["ssh-script", "jenkins-job", "gitlab-manual", "argocd", "kubectl"], "credentials": ["jenkins-prod"] } }
```

`credentials` chỉ là danh sách tên (FR-010). Linux không có kho bí mật báo `methods: []` (FR-102).

## Việc hub giao (`deliveryJobSpec`)

| Trường | Ý nghĩa |
|---|---|
| `jobId` | uuid, khoá idempotent |
| `kind` | một trong các loại ở data-model |
| `deployId` | uuid hoặc null |
| `configVersion` | phiên bản cấu hình đã khoá |
| `target` | đối tượng theo `kind`: địa chỉ, job, ứng dụng, workload; không có giá trị bí mật |
| `credential` | tên tham chiếu `[a-z0-9-]{1,64}` |
| `params` | tham số; tham số kiểu bí mật đi dưới dạng tên tham chiếu |
| `timeoutSeconds` | trần thời gian |

## Sự kiện worker gửi (`deliveryEvent`)

Mỗi sự kiện có `jobId`, `seq` (tăng dần, hub bỏ trùng), `at`, và một trong:

- `started` kèm `workerId`;
- `step` kèm `name`, `state` (`running`, `succeeded`, `failed`, `skipped`), `exitCode` tuỳ chọn;
- `external` kèm tham chiếu build, ứng dụng hoặc workload, và URL nguồn để mở;
- `health` kèm kết quả đạt hoặc không và mã trạng thái;
- `finished` kèm `state` và `error: { code, message }` tuỳ chọn.

Không có kiểu sự kiện nào mang thân log (FR-050). `message` cắt ở 200 ký tự.

## Quy tắc

- Worker gửi qua hàng chờ trên đĩa hiện có; hub bỏ sự kiện trùng theo `(jobId, seq)`.
- Hub chỉ giao khi worker báo đúng `method` ở khả năng (FR-011).
- Hub không giao lại việc đã `started` mà chưa hết lease.
