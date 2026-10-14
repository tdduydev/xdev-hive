# Feature Specification: Leader và thông báo qua Telegram / Slack

**Feature Branch**: `013-chat-channels`

**Created**: 2026-10-14

**Status**: Draft

**Input**: Yêu cầu của product owner (2026-10-14): lấy ý tưởng từ Hermes Agent (một gateway nối Telegram, Discord, Slack
tới agent) "theo hướng mình": Hive là hub nhiều tổ chức, có `notify`, Leader (chat → đề xuất → người duyệt), run, review.
Tiết kiệm token: lệnh và nút bấm không gọi LLM; chỉ tin nhắn tự do mới tới Leader, có giới hạn lượt.

**Decision record**: [ADR 0024](../../docs/adr/0024-chat-channels.md).

## Thuật ngữ

- **Bot**: một bot Telegram hoặc một Slack app do quản trị tổ chức cấu hình trên web. Mỗi tổ chức tối đa một bot mỗi loại
  đang bật (tên không trùng); id bot nằm trong URL webhook nên chọn được tổ chức.
- **Liên kết**: một tài khoản chat gắn với một người dùng Hive trong một bot.
- **Mã liên kết**: mã dùng một lần, 10 phút, sinh từ web.

## User Stories & kiểm thử

### US1 — Quản trị cấu hình bot (P1)

Quản trị tổ chức thêm bot Telegram (token) hoặc Slack (bot token + signing secret) ở trang Thông báo, bấm "Kiểm tra và
kết nối" để hub gọi `getMe` + `setWebhook` (Telegram) hoặc `auth.test` (Slack) và hiện URL webhook cần dán vào Slack.
Đặt cho tổ chức: cho phép chat nhóm (mặc định tắt), giới hạn lượt Leader mỗi người và mỗi tổ chức mỗi ngày, model Leader.

- Token không bao giờ trả về qua API; chỉ thấy `target` (vd. `@hive_bot`).
- Chỉ quản trị tổ chức thấy và sửa bot, cài đặt.
- Test: hub db (CRUD, mã hoá, RLS), web e2e (trang cấu hình).

### US2 — Liên kết tài khoản (P1)

Người dùng bấm "Tạo mã" cho một bot đang bật, gửi `/link MÃ` (Telegram) hoặc `/hive link MÃ` (Slack) cho bot. Hub gắn
id tài khoản chat với người dùng. Không dùng tên hiển thị. Mã hết hạn sau 10 phút, dùng một lần, tạo mã mới thì mã cũ
của người đó vô hiệu. Tài khoản chat đã liên kết với người khác thì từ chối. Người dùng tách liên kết trên web hoặc bằng
`/unlink`.

- Test: mã đúng, sai, hết hạn, dùng lại; tài khoản chat đã gắn người khác; tách liên kết.

### US3 — Thông báo qua chat (P1)

Sự kiện `notify` hiện có tới người nhận đã liên kết nếu danh sách sự kiện của liên kết (chọn trên web) có sự kiện đó.
Tin gồm tiêu đề, tóm tắt ngắn và nút: Duyệt / Trả lại (kế hoạch, tài liệu chờ duyệt), Mở trên web.

- Gửi qua hàng đợi `chat.deliver` có thử lại; lỗi vĩnh viễn (token sai) đánh dấu failed.
- Không gửi secret hay code dài: che mẫu token/khoá, thay khối code bằng lời nhắc xem trên web, cắt độ dài.
- Test: hub db (phát sự kiện → outbox → gửi tới server giả), lọc sự kiện, người không liên kết không nhận.

### US4 — Lệnh và nút bấm, không gọi LLM (P1)

| Lệnh | Việc |
|---|---|
| `/help` | Danh sách lệnh |
| `/pending` | Đề xuất của Leader đang chờ, kèm nút Duyệt / Từ chối / Mở trên web |
| `/approve ID`, `/reject ID [lý do]` | Duyệt hoặc từ chối đề xuất (ID là 8 ký tự đầu) |
| `/runs` | Run đang chạy và run gần đây của tôi |
| `/run ID` | Trạng thái một run |
| `/task MÃ` | Trạng thái task (vd. `PAY-12`) |
| `/cancel ID` | Huỷ run |
| `/quota` | Quota phiên 5 giờ và tuần của tài khoản CLI trên máy của tôi |
| `/project [MÃ]` | Xem hoặc chọn dự án cho Leader |
| `/new` | Bắt đầu cuộc trò chuyện Leader mới |
| `/unlink` | Tách liên kết |

Mọi lệnh và nút chạy trong `withTenant` bằng người dùng đã liên kết, kiểm vai trò như web; thành viên đã bị gỡ khỏi tổ
chức thì không dùng được dù liên kết còn. Nút chỉ dùng được bởi chính tài khoản chat nhận tin.

- Test: hub db (nút gọi đúng quyền: người không có quyền bị từ chối, người đã rời tổ chức bị từ chối; nút của người khác
  bị từ chối).

### US5 — Leader qua chat (P2)

Tin nhắn tự do trong chat riêng đi vào phiên Leader của người đó (dự án chọn bằng `/project`, tự chọn nếu chỉ có một).
Hub trả "đã nhận" kèm số lượt còn lại; câu trả lời của Leader tới sau qua chat (rút gọn, che bí mật), đề xuất kèm nút
Duyệt / Từ chối. Không có chế độ tự duyệt qua chat. Model theo cài đặt tổ chức (mặc định `sonnet`).

- Giới hạn lượt mỗi người và mỗi tổ chức mỗi ngày (mặc định 30 và 300); hết lượt thì trả lời cố định, không gọi LLM.
- Test: hub db (lượt, giới hạn, phiên Leader tạo đúng, câu trả lời Leader tới chat).

### US6 — An toàn (P1)

Chặn chat nhóm trừ khi tổ chức bật (và khi bật chỉ nhận lệnh `/`, không nhận tin tự do). Giới hạn tốc độ mỗi tài khoản chat
(20 tin/phút) và số lần nhập mã sai (5 lần/10 phút). Audit mọi lệnh và nút (`chat.command`, `chat.action`). Chữ ra
ngoài che bí mật và code.

## Yêu cầu

- **CHAT-01** Bảng `chat_bots`, `chat_org_settings`, `chat_link_codes`, `chat_links`, `chat_outbox`, `chat_usage`: có
  `org_id`, bật và ép RLS.
- **CHAT-02** Secret bot mã hoá envelope, không lộ qua API, nhật ký audit hay thông báo lỗi.
- **CHAT-03** Webhook Telegram kiểm `X-Telegram-Bot-Api-Secret-Token`; Slack kiểm chữ ký v0 và độ lệch giờ ≤ 5 phút.
- **CHAT-04** Lệnh và nút không gọi LLM; chỉ tin tự do trong chat riêng tới Leader.
- **CHAT-05** Chữ giao diện và lỗi tiếng Việt.

## Ngoài phạm vi bản này

Long polling Telegram, Discord/Teams, bot theo đội, quyết định checkpoint code review qua chat (cần head SHA), chế độ
tự duyệt qua chat, chat nhóm cho tin tự do, định dạng Slack phong phú.
