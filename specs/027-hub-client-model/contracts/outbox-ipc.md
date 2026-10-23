# Contract: hộp thư đi qua socket cục bộ (US2)

Thêm op vào socket của ADR 0019 (`worker/internal/localipc`). Dạng gói không đổi: một đối tượng JSON mỗi dòng, sau
bước `hello`. Mục lớn hơn 64 KiB gửi bằng `outbox.submit` kèm `bodyFile`: đường dẫn file tạm do client tạo trong
`DataDir/outbox/incoming/` (0600); worker đọc rồi xoá. Giữ trần 64 KiB cho một dòng như hiện nay.

## `outbox.submit`

```jsonc
// yêu cầu
{
  "op": "outbox.submit",
  "key": "01JB...",            // client tạo; gửi lại cùng key thì worker trả mục đã có, không thêm mục mới
  "source": "mcp-local",
  "transport": "mcp",          // "mcp" | "rpc"
  "kind": "task_update",
  "target": { "type": "task", "id": "..." },  // tuỳ chọn; quyết định stream
  "body": { /* tools/call params, hoặc { path, input } của oRPC */ },
  "bodyFile": null,
  "createdAt": "2026-10-21T10:00:00Z",
  "waitMs": 10000              // 0: chỉ xếp hàng
}
// trả lời
{ "ok": true, "state": "accepted", "result": { "outcome": "accepted", "receivedAt": "...", "response": { } } }
{ "ok": true, "state": "queued", "key": "01JB...", "pending": 7 }
{ "ok": true, "state": "rejected", "result": { "outcome": "rejected", "code": "TASK_CANCELLED", "reason": "..." } }
{ "ok": false, "code": "NOT_QUEUEABLE", "error": "Hub đang vắng; thao tác này cần hub trả lời ngay." }
{ "ok": false, "code": "OUTBOX_FULL", "error": "Hộp thư đi đã đầy (200 MB). Gửi hoặc bỏ bớt mục chờ trước." }
{ "ok": false, "code": "ITEM_TOO_LARGE", "error": "Mục lớn hơn 20 MB, không xếp hàng được." }
{ "ok": false, "code": "NOT_SIGNED_IN", "error": "Chưa đăng nhập hub trên máy này." }
```

- Worker lấy danh tính từ PAT trong keychain lúc nhận mục (R6). Client không gửi token qua socket.
- `kind` không có trong bảng nhóm (`CLIENT_WRITE_TOOLS`, `CLIENT_WRITE_PROCEDURES`) thì trả `UNKNOWN_KIND`.
- Nhóm `immediate`: worker gửi thẳng, không ghi đĩa; hub vắng thì `NOT_QUEUEABLE`.

## `outbox.status`

```jsonc
{ "op": "outbox.status" }
{ "ok": true, "hub": "up" | "down" | "retrying", "hubUrl": "https://...", "lastContactAt": "...",
  "pending": 12, "held": 0, "rejected": 1, "expired": 0, "bytes": 1048576, "limitBytes": 209715200 }
```

## `outbox.list`

```jsonc
{ "op": "outbox.list", "states": ["pending", "held", "rejected", "expired"], "limit": 200 }
{ "ok": true, "items": [ { "key": "...", "kind": "doc_propose", "state": "rejected", "createdAt": "...",
  "target": { "type": "doc", "id": "..." }, "title": "Đề xuất tài liệu: Kiến trúc", "attempts": 3,
  "result": { "code": "DOC_VERSION_CONFLICT", "reason": "..." }, "heldReason": null, "hubLink": "https://.../docs/..." } ] }
```

`title` là câu ngắn tiếng Việt worker dựng từ `kind` và `target`, không chứa nội dung `body`.

## `outbox.drop`, `outbox.export`, `outbox.retry`

```jsonc
{ "op": "outbox.drop", "keys": ["..."] }                    // chỉ mục rejected, expired, held
{ "op": "outbox.export", "keys": ["..."], "path": "..." }   // ghi JSON các mục ra file người dùng chọn
{ "op": "outbox.retry", "keys": ["..."] }                   // held → pending sau khi đăng nhập lại; expired → pending
```

## `outbox.logout`

Gọi trước khi xoá token, chỉ cho mục của người đang đăng nhập `hubUrl`.

```jsonc
{ "op": "outbox.logout", "hubUrl": "https://...", "action": "count" | "send" | "keep" | "drop", "waitMs": 30000 }
// → { "ok": true, "pending": 0, "held": 2, "rejected": 0, "expired": 0, "dropped": 3 }
```

- `send`: thử lại mục `held` vì đăng nhập, gửi một lượt (chờ tối đa `waitMs`), mục còn lại như `keep`.
- `keep`: mục chờ gửi sang `held` (`login_required`); lần đăng nhập sau của đúng người đưa về hàng đợi.
- `drop`: bỏ mọi mục của người đó (giữ khoá danh tính nên không bỏ mục đang trên đường tới hub).
- Không xác định được người đang đăng nhập: `count`, `keep` tính mọi người dùng của hub; `send`, `drop` lỗi
  `UNKNOWN_IDENTITY`.

## Sự kiện qua `watch`

Thêm loại sự kiện vào luồng `watch` hiện có:

```jsonc
{ "event": "outbox", "hub": "down", "pending": 12, "held": 0, "rejected": 1, "expired": 0 }
{ "event": "outbox.item", "key": "...", "state": "rejected", "code": "...", "reason": "..." }
```

## Lệnh `hive`

| Lệnh | Op |
|---|---|
| `hive outbox` | `outbox.status` + `outbox.list` (bảng cho người đọc) |
| `hive outbox --json` | như trên, JSON cho desktop |
| `hive outbox drop <key>…`, `retry <key>…`, `export <key>… -o file` | |
| `hive outbox submit --json -` | đọc yêu cầu `outbox.submit` từ stdin (desktop, VS Code) |
| `hive logout [--outbox send\|keep\|drop]` | `outbox.logout`; không có terminal và không có cờ thì `keep` |
| `hive runs log <runId> [--attempt N] [--offset B] [--limit B] [--json]` | `runs.log.read` (US5) |
| `hive runs ls --json` | `runs.list` (US5) |

## `hive mcp` khi hub vắng

- Tool có trong `CLIENT_WRITE_TOOLS` với nhóm `progress`/`proposal`: proxy tạo key, gửi `outbox.submit` (`waitMs`
  10000). `queued` thì trả cho agent kết quả tool (không phải lỗi):
  `"Đã xếp hàng, chờ hub (khoá 01JB...). Hub sẽ nhận khi kết nối lại; không cần gọi lại."`
- Tool nhóm `immediate` và tool đọc: gọi thẳng hub như hiện nay; lỗi mạng thì trả lỗi tool
  `"Hub đang vắng (<hubUrl>). Thao tác này cần hub trả lời ngay."`
- Worker không chạy: tool ghi trả lỗi `"Sidecar hive-worker không chạy; mở app xDev Hive hoặc chạy hive-worker run."`.
  Không gọi thẳng hub để khỏi có lần ghi nằm ngoài hộp thư đi.

## Op log run (US5)

```jsonc
{ "op": "runs.list", "limit": 100 }
{ "ok": true, "runs": [ { "runId": "...", "attempt": 1, "projectKey": "...", "taskKey": "...", "startedAt": "...",
  "endedAt": "...", "bytes": 10485760, "status": "succeeded" } ] }

{ "op": "runs.log.read", "runId": "...", "attempt": 1, "offset": 0, "limit": 1048576 }
{ "ok": true, "offset": 0, "bytes": "<base64>", "eof": false, "total": 10485760 }
{ "ok": false, "code": "LOG_NOT_FOUND", "error": "Máy này không có log của run này." }
```

Trang `runs.log.read` tối đa 1 MiB base64, gửi bằng khung nhị phân nếu lớn hơn 64 KiB (dùng lại khung của
`session.attach`).
