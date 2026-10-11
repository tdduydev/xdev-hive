# xDev Hive

Nơi nhiều đội trong một tổ chức giao việc cho coding agent CLI (Claude Code, Codex, Gemini CLI), dùng chung memory, tài liệu, skill, rồi review và merge kết quả.

Bản viết lại, đang ở giai đoạn thiết kế. Bản cũ: [`tdduydev/xdev-hive-old`](https://github.com/tdduydev/xdev-hive-old).

## Tài liệu

- [Kiến trúc](docs/architecture.md): thành phần, module, dữ liệu, giao thức worker, bảo mật, vận hành, thứ tự xây dựng.
- [Quyết định](docs/decisions.md): phạm vi, stack và phiên bản đã chốt.
- [Phân tích hệ cũ](docs/history/phan-tich-2026-10/README.md).

## Stack

Hub và web: TypeScript (Node, Hono, oRPC, Drizzle, pg-boss, Better Auth, MCP SDK v2, React, Vite). Worker và runner host: Go. Desktop: Tauri. Dữ liệu: PostgreSQL với RLS và pgvector.

## Chạy tại máy

Cần Node 24+, pnpm 12, Go 1.27, Rust (chỉ khi làm app desktop).

```sh
pnpm install
pnpm --filter @xdev-hive/hub dev     # hub ở http://localhost:3000
pnpm --filter @xdev-hive/web dev     # web ở http://localhost:5173
cd worker && go run ./cmd/hive-worker check --hub http://localhost:3000
```

Trước khi mở PR: `pnpm check`. Quy ước cho người và agent: [AGENTS.md](AGENTS.md).
