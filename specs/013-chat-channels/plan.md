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
| `router.ts` | oRPC cho web (bot, cài đặt, liên kết của tôi) |

Thay đổi ở module khác (nhỏ, tương thích ngược):

- `notify`: `NotifyInput.actions?` và hook `provideNotifyFanout` (đảo phụ thuộc, tránh vòng notify → chat → runs → notify).
- `leader`: tách `sendLeaderMessage`, `decideApproval` khỏi router để chat dùng lại; hook `provideLeaderObserver` khi
  Leader trả lời hay đề xuất; `startLeaderRun` nhận `model`.
- `runs`: export `searchRuns`; `notifyPlan` gắn nút. `knowledge`: export `decideReview`; thông báo review gắn nút.
- `fleet`: `machineQuotas` cho `/quota`.

Contract `packages/contracts/src/chat.ts`: nhóm `chat` (`bots`, `settings`, `links`).

Web: mục "Chat (Telegram, Slack)" ở trang Thông báo: quản trị thấy bot và cài đặt; mọi người thấy liên kết của mình.

## Rủi ro

- Webhook cần URL HTTPS công khai; chưa có long polling.
- Hook notify là trạng thái toàn cục của tiến trình: cài ở `main.ts`; test cài tay.
- Telegram giới hạn `callback_data` 64 byte: nút dùng `o:<outboxId>:<chỉ số>`, hành động nằm trong `chat_outbox`.
