# Tasks: Leader và thông báo qua Telegram / Slack

**Input**: [spec.md](spec.md), [plan.md](plan.md), [ADR 0024](../../docs/adr/0024-chat-channels.md)

- [x] T001 Spec, plan, tasks, ADR 0024
- [x] T002 Contract `chat.ts`, `openapi.json`
- [x] T003 Schema, migration, RLS
- [x] T004 Bot: CRUD, mã hoá, kiểm tra kết nối, adapter Telegram/Slack
- [x] T005 Liên kết bằng mã một lần
- [x] T006 Fan-out thông báo, outbox, job `chat.deliver`, nút hành động
- [x] T007 Lệnh và nút bấm (không LLM), audit, quyền như web
- [x] T008 Leader qua chat, giới hạn lượt, trả lời về chat
- [x] T009 Webhook Telegram/Slack: chữ ký, giới hạn tốc độ, chặn nhóm
- [x] T010 Web: trang cấu hình, liên kết, e2e
- [x] T011 Long polling Telegram — `HIVE_TELEGRAM_POLL_BOT_IDS`, khoá giữa tiến trình, con trỏ mã hoá, retry và huỷ khi dừng; test database
- [x] T012 Decision checkpoint code review qua chat — nút gắn `headSha` + `gateRunId`, quyền/quorum/audit như web; test database
