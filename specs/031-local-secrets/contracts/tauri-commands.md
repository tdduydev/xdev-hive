# Contract: lệnh Tauri của desktop (UI ↔ Rust)

**Quy tắc chung**:

- Đăng ký trong `apps/desktop/src-tauri/src/lib.rs`, cài đặt trong `apps/desktop/src-tauri/src/secrets.rs`.
- Bọc TS trong `apps/desktop/src/lib/secrets.ts`.
- Mọi lệnh chạy được khi chưa đăng nhập Hive (FR-008).
- Lỗi trả `string` tiếng Việt lấy từ `error.message` của sidecar.

| Lệnh Tauri | Tham số | Trả | Gọi sidecar |
|---|---|---|---|
| `secrets_status` | | `StoreStatus` | `secrets status` |
| `secrets_list` | `project?: string` | `{ secrets, reserved }` | `secrets list` |
| `secret_save` | `{ name, description, value?: string, projects?: string[], allProjects?: boolean }` | `SecretItem` | `secrets set` (+ `assign\|unassign --all-projects` khi có `allProjects`, rồi `assign` cho từng dự án mới) |
| `secret_rename` | `{ name, to }` | `SecretItem` | `secrets rename` |
| `secret_assign` | `{ name, project, assigned: boolean }` | `SecretItem` | `secrets assign` / `unassign` |
| `secret_delete` | `{ name }` | `{ deleted, inUse }` | `secrets delete` |
| `secret_reveal` | `{ name }` | `string` (giá trị) | `secrets reveal` |
| `secret_copy` | `{ name }` | `null` | `secrets reveal --copy`. Rust đặt clipboard, sau 30 giây xoá nếu chưa đổi |
| `secrets_log` | `{ name?, project?, limit? }` | `{ entries }` | `secrets log` |
| `secrets_log_clear` | | `{ cleared }` | `secrets log clear` |
| `secrets_purge` | `{ project?: string, all?: boolean }` | `{ removed, left }` | `secrets purge` |
| `secret_approvals` | | `{ pending }` | `secrets approvals` |
| `secret_approve` | `{ id, allow: boolean }` | `null` | `secrets approve` |

**Bảo mật**:

- `value` trong `secret_save` được chuyển thẳng vào stdin của sidecar. Rust gọi `wipe` sau khi ghi. Không log, không
  trả lại.
- `secret_reveal`:
  - trả giá trị cho UI một lần;
  - UI giữ trong state cục bộ của dòng, xoá sau 10 giây hoặc khi rời màn;
  - UI không lưu vào query cache: `useMutation` không cache kết quả.
- `secret_copy`:
  - giá trị không qua UI;
  - Rust giữ một bản để so sánh trong 30 giây, rồi `wipe`.
- Không có lệnh nào nhận hay trả giá trị qua sự kiện Tauri (`emit`). Sự kiện có thể được nhiều cửa sổ nghe.

**Thay đổi lệnh có sẵn** (`profiles.rs`, `git_groups.rs`):

- `open_cli_terminal(id, folder, bypass)`, `open_agent_terminal(cli, plan_id, bypass, folder)`, `open_folder_terminal`:
  - thêm tham số tuỳ chọn `project_local_id: Option<String>`;
  - nếu thiếu, Rust tìm `localId` theo `folder` qua `secrets list`/`projects`.
- Khi dự án có bí mật gán, `Launch.argv` được bọc:

  ```
  [<sidecar>, "secrets", "exec", "--project=<localId>", "--kind=terminal", "--cli=<cli>", "--", ...argv]
  ```

- `sh_script` và `cmd_script` giữ nguyên cách trích dẫn argv. Không thêm dòng `export`/`set` nào cho bí mật.
