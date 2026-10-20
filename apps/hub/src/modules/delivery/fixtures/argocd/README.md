# Fixture Argo CD

Viết tay theo tài liệu công khai của Argo CD (API `/api/version`, `/api/v1/applications`, trường `status.summary`,
`status.history`, `status.operationState`) **[Suy luận]**. Chưa lấy từ Argo CD của dự án. Task T007 đối chiếu với hệ
thật; khác thì người điều phối thêm task sửa `clients/argocd.ts` và fixture. Tên, URL, mã commit trong fixture là giả.

Chỗ cần đối chiếu:

| File | Điều chưa kiểm |
|---|---|
| `application-*.json` | `status.summary.images` có với chart của dự án không; `syncPolicy.automated` bật hay tắt; dạng `history` khi nhiều nguồn |
| `error-permission-denied.json` | Argo CD trả 403 cho ứng dụng không thấy được hay 404; token của account có quyền `sync`, `rollback` không |
| `error-rollback-autosync.json` | Mã HTTP và lời nhắn khi rollback lúc autoSync bật |
