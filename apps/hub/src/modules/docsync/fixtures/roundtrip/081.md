# Plan: Leader và thông báo qua Telegram / Slack

**Spec**: [spec.md](spec.md) · **ADR**: [0024](../../docs/adr/0024-chat-channels.md)

## Kiến trúc

Module hub mới `apps/hub/src/modules/chat/`:

| File | Việc |
|---|---|
| `schema.ts` | Sáu bảng, RLS; `chat_bots` thêm policy tra theo `hive.ctx_chat_bot()` cho webhook |
| `bots.ts` | CRUD bot, mã hoá cấu hình, kiểm tra kết nối (`getMe`/`setWebhook`/`auth.test`) |
| `links.ts` | Mã liên kết, liên kết, tách liên kết, sự kiện của liên kết |
| `adapters.ts` | Gửi tin Telegram và Slack (fetch, URL gốc thay được cho test) |
| `sanitize.ts` | Che bí mật, bỏ khối code, cắt độ dài |
| `outbox.ts` | Fan-out thông báo và tin Leader tới liên kết, job `chat.deliver` |
| `commands.ts` | Phân tích và chạy lệnh |
| `actions.ts` | Chạy nút bấm qua hàm hub, kiểm quyền, audit |
| `leader-bridge.ts` | Tin tự do → phiên Leader, giới hạn lượt, trả lời Leader về chat |
| `webhooks.ts` | Route Telegram và Slack, kiểm chữ ký, chuẩn hoá sự kiện, giới hạn tốc độ |
| `polling.ts` | Telegram getUpdates ở vai trò api, advisory lock theo token, con trỏ trong config_enc, huỷ khi dừng |
| `router.ts` | oRPC cho web (bot, cài đặt, liên kết của tôi) |

Thay đổi ở module khác (nhỏ, tương thích ngược):

- `notify`: `NotifyInput.actions?` và hook `provideNotifyFanout` (đảo phụ thuộc, tránh vòng notify → chat → runs → notify).
- `leader`: tách `sendLeaderMessage`, `decideApproval` khỏi router để chat dùng lại; hook `provideLeaderObserver` khi
  Leader trả lời hay đề xuất; `startLeaderRun` nhận `model`.
- `runs`: export `searchRuns`; `notifyPlan` gắn nút. `knowledge`: export `decideReview`; thông báo review gắn nút.
- `fleet`: `machineQuotas` cho `/quota`.
- `codereview`: thông báo chờ/quá hạn kèm SHA và nút; export `decideCodeReview`, input `gateRunId?` kiểm dưới khoá
  để nút cũ không duyệt lượt checkpoint tiếp theo cùng SHA. Chat nhận các cổng tạo run và sửa code như web.

Contract `packages/contracts/src/chat.ts`: nhóm `chat` (`bots`, `settings`, `links`).

Web: mục "Chat (Telegram, Slack)" ở trang Thông báo: quản trị thấy bot và cài đặt; mọi người thấy liên kết của mình.

## Rủi ro

- Telegram không có HTTPS công khai dùng `HIVE_TELEGRAM_POLL_BOT_IDS`; Slack vẫn cần webhook.
- Polling có thể xử lý lại update nếu hub chết sau khi nghiệp vụ commit nhưng trước khi lưu con trỏ. Các quyết định
  kiểm trạng thái/quorum/lượt checkpoint nên không quyết lại; tin Leader có thể lặp trong cửa sổ này.
- Mỗi bot polling dùng thêm một kết nối PostgreSQL riêng để giữ advisory lock, cần tính vào giới hạn kết nối hub.
- Hook notify là trạng thái toàn cục của tiến trình: cài ở `main.ts`; test cài tay.
- Telegram giới hạn `callback_data` 64 byte: nút dùng `o:<outboxId>:<chỉ số>`, hành động nằm trong `chat_outbox`.
