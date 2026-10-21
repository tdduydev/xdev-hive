# Data Model: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy

**Plan**: [plan.md](plan.md) · **Research**: [research.md](research.md)

## Trên hub (PostgreSQL, schema `hive`)

Mọi bảng có `org_id` đều bật và ép RLS theo `hive.ctx_org()` như các bảng hiện có, và có mặt trong `rls.db.test.ts` của
module (constitution II).

### `client_events` (mới, module `platform`)

Một dòng cho mỗi khoá chống trùng đã xử lý (US1).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid not null | RLS |
| `idempotency_key` | text not null | Do client tạo: ULID hay UUIDv7, 16–64 ký tự `[A-Za-z0-9_-]` |
| `source` | enum `client_source` | `worker-run`, `worker`, `desktop`, `hive-cli`, `mcp-local`, `vscode`, `web`, `unknown` |
| `machine_id` | uuid null | FK `machines(id, org_id)`, `on delete set null` |
| `user_id` | text null | Người của token; null khi danh tính là máy |
| `kind` | text not null | Tên tool MCP (`task_update`…) hay tên thủ tục oRPC (`memory.write`) hay loại sự kiện máy (`machine.token_score`) |
| `target_type` | text null | `task`, `run`, `doc`, `skill`, `memory`, `machine`… |
| `target_id` | text null | |
| `client_created_at` | timestamptz null | Chỉ để hiển thị; không dùng để sắp thứ tự |
| `received_at` | timestamptz not null default now() | |
| `outcome` | enum `client_event_outcome` | `accepted`, `rejected` (`duplicate` không lưu: là kết quả của lần gửi lại) |
| `reason_code` | text null | Mã lỗi nghiệp vụ khi `rejected` |
| `reason` | text null | Câu tiếng Việt, đã che secret |
| `response` | jsonb null | Kết quả trả về lúc đầu, để lần gửi lại trả y như cũ; giới hạn 64 KiB, dài hơn thì chỉ giữ tóm tắt |
| `client_version` | text null | Từ `User-Agent` hay `X-Hive-Client`; dùng cho cảnh báo FR-005 |

- Ràng buộc: `UNIQUE (org_id, idempotency_key)`.
- Index: `(org_id, target_type, target_id, received_at)` cho lịch sử task (FR-006); `(org_id, received_at)` cho dọn.
- Giữ 30 ngày (≥ 14 ngày của hộp thư đi, FR-002), xoá bằng job ngày của `platform`.
- Dòng `accepted` ghi trong cùng transaction với thay đổi nghiệp vụ; dòng `rejected` ghi ở transaction riêng sau khi
  transaction chính rollback.
- Không có khoá (client cũ, FR-005): hub không ghi dòng nào, ghi cảnh báo `client_event.missing_key` theo phiên bản
  client vào log và đếm theo ngày.

### `db_epoch` (mới, module `system`)

Một dòng, không theo tổ chức (bảng hệ thống, không có `org_id`, `hive_app` chỉ đọc).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | boolean PK default true, check `id` | Ép đúng một dòng |
| `epoch` | uuid not null | Đổi sau mỗi lần khôi phục |
| `restored_to` | timestamptz null | Thời điểm database được khôi phục tới; null khi chưa từng khôi phục |
| `changed_at` | timestamptz not null | |

### `machines` (sửa, module `fleet`)

| Cột | Đổi |
|---|---|
| `public_key` | Đã có. Bắt đầu dùng: khoá công khai Ed25519, base64url 32 byte |
| `public_key_at` | Mới, timestamptz null: lúc đăng ký khoá |
| `key_storage` | Mới, enum null `keychain`, `file`: máy báo khoá riêng nằm ở đâu, để trang Máy hiện cảnh báo với `file` |

### `machine_tokens` (sửa, module `fleet`)

| Cột | Đổi |
|---|---|
| `superseded_at` | Mới, timestamptz null. Đặt khi máy đăng ký khoá; `hwm_` có cột này thì bị từ chối (FR-021) |

### `run_git_tokens` (mới, module `scm`)

Theo dõi token git đã cấp để thu hồi. Không lưu giá trị token.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid not null | RLS |
| `run_id` | uuid not null | FK `runs` |
| `attempt` | int not null | |
| `connection_id` | uuid not null | FK `scm_connections` |
| `provider` | text not null | `github`, `gitlab` |
| `external_id` | text null | Id token phía GitLab, để thu hồi; null với GitHub (token tự hết hạn sau 1 giờ) |
| `repo` | text not null | `owner/name` hay đường dẫn project |
| `expires_at` | timestamptz not null | |
| `revoked_at` | timestamptz null | |

Job `scm.revokeRunTokens` chạy mỗi 10 phút: thu hồi token GitLab của run đã kết thúc mà `revoked_at` còn null.

### `run_logs`, `terminal_chunks` (ngừng ghi)

Không đổi schema. Hub mới không ghi thêm dòng nào (R10, R11). Dữ liệu cũ bị xoá theo `purge_run_logs()` hiện có. Một
migration sau, khi đã quá thời gian giữ lớn nhất (365 ngày), sẽ xoá hai bảng; không làm trong spec này.

### Chính sách tổ chức (sửa `packages/contracts/src/policies.ts`)

| Trường | Đổi |
|---|---|
| `limits.runLogRetentionDays` | Giữ nguyên. Nay áp ở máy (gửi trong `welcome.policy`) |
| `git.requireRunGitToken` | Mới, boolean, mặc định `false`. Bật thì run không có token git theo run bị từ chối giao |

## Trên máy (`hive-worker`, thư mục `DataDir` = `<UserCacheDir>/xdev-hive/worker`)

### Mục hộp thư đi

`DataDir/outbox/<identityKey>/<ulid>.json`, quyền 0600; thư mục 0700 (Windows: DACL chỉ SID người dùng).
`identityKey` = 16 ký tự hex đầu của SHA-256(`hubUrl` + `|` + `userId`), hoặc `machine-<machineId>` với sự kiện của máy.

| Trường | Ghi chú |
|---|---|
| `key` | Khoá chống trùng (ULID), cũng là tên file nên thứ tự file là thứ tự tạo |
| `source` | Nguồn gửi |
| `identity` | `{hubUrl, orgId, userId?, machineId?, email?}` |
| `transport` | `mcp` (body `tools/call`) hay `rpc` (đường dẫn oRPC + body) hay `worker` (sự kiện máy) |
| `kind`, `group` | Tên tool/thủ tục; nhóm `progress` hay `proposal` (R5) |
| `stream` | Khoá thứ tự: `task:<id>`, `doc:<id>`, `skill:<id>`, `memory:<scope>`, hay `kind` khi không có đối tượng |
| `body` | Nội dung gửi, đã che secret (R12); ≤ 20 MB |
| `createdAt` | Giờ máy |
| `state` | `pending`, `sending`, `held`, `accepted`, `duplicate`, `rejected`, `expired` |
| `attempts`, `lastAttemptAt`, `nextAttemptAt` | Lùi dần 5 giây → 5 phút |
| `result` | `{outcome, code?, reason?, receivedAt?, response?}` khi hub đã trả lời |
| `heldReason` | Lý do giữ (`login_required`, `identity_mismatch`, `machine_revoked`) |

Chuyển trạng thái:

```
pending ──gửi──▶ sending ──2xx accepted/duplicate──▶ accepted | duplicate ──▶ (chuyển sang sent.jsonl, xoá file)
   ▲                 │──4xx nghiệp vụ──▶ rejected (giữ tới khi người dùng Bỏ)
   │                 │──mạng/5xx/429──▶ pending (nextAttemptAt)
   │                 └──401/403 danh tính──▶ held (tới khi đăng nhập đúng người)
   └──────── 14 ngày không gửi được ──▶ expired (giữ, chờ người dùng xuất hay Bỏ)
```

- Gửi theo thứ tự trong từng `stream`; mục ở `pending` hay `held` chặn các mục sau **cùng stream**, không chặn stream
  khác. `rejected` và `expired` không chặn.
- Giới hạn: tổng 200 MB, một mục 20 MB (FR-016). Vượt thì `outbox.submit` trả lỗi `OUTBOX_FULL` hay `ITEM_TOO_LARGE`.
- `sent.jsonl`: một dòng `{key, stream, receivedAt, dbEpoch}` cho mỗi mục đã được nhận, giữ 14 ngày, cùng body nén
  trong `sent/<key>.json.gz` để gửi lại khi epoch đổi (R7).

### Log run

`DataDir/runs/<runId>/<attempt>.log` (0600) và `DataDir/runs/<runId>/index.json`:

| Trường của `index.json` | Ghi chú |
|---|---|
| `runId`, `attempt`, `projectKey`, `taskKey` | Để desktop liệt kê |
| `startedAt`, `endedAt`, `bytes` | |
| `exit`, `status` | Chép từ kết quả run |

Xoá thư mục run có `endedAt` cũ hơn `runLogRetentionDays` (từ `welcome.policy` lần nối gần nhất; chưa từng nối thì 30
ngày).

### Khoá máy

| Nơi | Ghi chú |
|---|---|
| Keychain, dịch vụ `dev.xdev.hive.machine`, tài khoản `<machineId>` | Khoá riêng Ed25519 (seed 32 byte, base64) |
| `worker-key` cạnh `worker.json`, 0600 | Chỉ khi không có keychain. `worker.json` ghi `keyStorage: "file"` |
| `worker.json` | Thêm `publicKey`, `keyStorage`; `machineToken` bị xoá sau khi khoá được hub nhận |
