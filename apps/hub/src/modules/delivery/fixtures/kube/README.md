# Fixture Kubernetes

Viết tay theo tài liệu công khai của Kubernetes (`apps/v1` Deployment, StatefulSet, DaemonSet, `meta/v1` Status)
**[Suy luận]**. Chưa lấy từ cụm RKE2 của dự án. Task T007 đối chiếu với hệ thật (quyền `get`, `patch` của
ServiceAccount, dạng lỗi khi thiếu quyền); khác thì người điều phối thêm task sửa `clients/kube.ts` và fixture. Tên,
URL, image trong fixture là giả.

| File | Điều chưa kiểm |
|---|---|
| `deployment-*.json` | Điều kiện `Progressing` và `reason` thực tế của bản Kubernetes đang chạy |
| `statefulset-*.json` | `currentRevision` khác `updateRevision` trong lúc rolling update |
| `status-forbidden.json` | Lời nhắn khi ServiceAccount thiếu quyền (`get` hay `patch`) |
