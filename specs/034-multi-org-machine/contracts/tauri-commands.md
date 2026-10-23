# Contract: lệnh Tauri cho nhiều đăng ký

Mỗi lệnh gọi `hive-worker registrations …` (sidecar) và trả JSON của lệnh đó. Lỗi trả chuỗi tiếng Việt.

| Lệnh | Tham số | Trả về |
|---|---|---|
| `registrations_list` | — | `{ machineLimit, registrations: Registration[] }` |
| `registrations_add` | `{ hubUrl, token, label?, machineName?, limit? }` | `Registration` |
| `registrations_reregister` | `{ id, token }` | `Registration` |
| `registrations_update` | `{ id, label?, limit?, weight?, isolation?, enabled?, disclose? }` | `Registration` |
| `registrations_remove` | `{ id, outbox: "flush" \| "export" \| "drop", exportPath?, runs: "wait" \| "cancel" }` | `{ removed: string[] }` |
| `registrations_set_machine_limit` | `{ limit }` | `{ machineLimit }` |
| `account_assign_registrations` | `{ accountId, registrations: string[] \| "shared" }` | `Account` |

Lệnh có sẵn nhận thêm `registrationId` tuỳ chọn: `hub_switch`, `register_machine`, `local_projects_*`, `profiles_*`,
`account_login`/`account_logout` (token cá nhân), `terminal_open`, `outbox_*`, `secrets_*` (031).

Keychain: `account.rs` đổi khoá thành `"<hub>#<orgId>"` (data-model mục 7). Hàm `migrate_legacy_token(hub)` chạy lần đầu.

Sự kiện Tauri `registrations://changed` phát khi danh sách đổi, để các màn cập nhật nhãn và bộ lọc.
