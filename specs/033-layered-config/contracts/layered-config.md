# API cấu hình

Mọi thủ tục dùng tổ chức hiện hành (`x-hive-org`), xác thực và tenant transaction.

| Thủ tục | Đầu vào | Kết quả |
|---|---|---|
| `registry` | rỗng | Bốn khoá, nhóm, hai lớp, mặc định |
| `effective` | projectId | orgId, projectId, schemaVersion, generatedAt, configVersion, settings |
| `orgGet` | rỗng | Giá trị chung, khoá và phiên bản mỗi mục |
| `orgSet` | key, value?, locked?, expectedVersion? | Mục mới; value null gỡ giá trị, thiếu value giữ nguyên |
| `projectSet` | projectId, key, value | Cấu hình hiệu lực mới; value null chuyển về kế thừa |

Một setting hiệu lực có key, value, source hoặc null, locked và chain. Một mắt xích có layer (`org`/`project`), targetId, value, locked, applied. Không có trần hay dữ liệu secret.

Lỗi tiếng Việt: `CONFIG_LOCKED`, `CONFIG_VERSION_CONFLICT`, `CONFIG_UNKNOWN_KEY`, `CONFIG_VALUE_INVALID`, `PROJECT_NOT_FOUND`. Quyền và mã lỗi quyền dùng nghiệp vụ hiện có.

API team/run/instance: ngoài phạm vi. Ceiling/`overCeiling`: ngoài phạm vi. Cache desktop: ngoài phạm vi.
