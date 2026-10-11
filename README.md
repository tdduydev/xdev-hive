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

Cần Docker Compose v2, Node 24+, pnpm 12, Go 1.27, Rust (chỉ khi làm app desktop).

```sh
pnpm install
pnpm dev                             # Postgres, setup DB, hub :3000 và web :5173
cd worker && go run ./cmd/hive-worker check --hub http://localhost:3000
```

Trước khi mở PR: `pnpm check`. Quy ước cho người và agent: [AGENTS.md](AGENTS.md).

Chạy thử trọn luồng (Postgres, hub, đăng ký, dự án, worker, task, run, PR): `pnpm e2e:smoke`. Cần Docker (Testcontainers), Go và git; mặc định dùng repo git cục bộ và CLI giả, không ra mạng ngoài. Biến môi trường cho GitHub thật, CLI thật hay Postgres có sẵn ghi ở đầu [scripts/e2e-smoke.ts](scripts/e2e-smoke.ts).

## Triển khai

Lên một máy chủ có Docker và docker compose v2, từ máy dev:

```sh
HIVE_PUBLIC_URL=http://<máy-chủ>:3000 HIVE_BIND=0.0.0.0 deploy/remote.sh <user>@<máy-chủ>
```

- Script clone hoặc cập nhật repo vào `/opt/xdev-hive` (đổi bằng `HIVE_REMOTE_DIR`), checkout `main` (hoặc ref ở tham số
  thứ hai), rồi chạy `docker compose up -d --build` và chờ hub báo healthy.
- Lần đầu, mật khẩu database, `HIVE_AUTH_SECRET` và `HIVE_MASTER_KEY` được sinh ngay trên máy chủ vào `deploy/.env`
  (quyền 600). Script không in chúng ra và không chép về máy dev. **Sao lưu `HIVE_MASTER_KEY`**: mất khoá là mất mọi
  secret đã lưu (token Git, kênh thông báo).
- Lần sau, script giữ nguyên secret và chỉ thêm biến mới còn thiếu. `HIVE_PUBLIC_URL`, `HIVE_BIND`,
  `HIVE_POSTGRES_IMAGE`, `HIVE_NODE_IMAGE` đặt theo tham số của lệnh.
- `HIVE_BIND=0.0.0.0` cho máy chủ LAN không có HTTPS. Khi đó cổng `/mcp` tự tắt vì `HIVE_PUBLIC_URL` không phải https.
  Dùng HTTPS thì để `HIVE_BIND` mặc định và thêm `--profile https` (Caddy).
- User không thuộc nhóm docker thì đặt `HIVE_REMOTE_DOCKER="sudo docker"`.

Tự chạy tại máy chủ: sao chép `deploy/.env.example` thành `deploy/.env`, đặt mật khẩu và secret, rồi chạy
`docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`. Hub tự bootstrap role (kể cả `hive_jobs`
cho hàng đợi), chạy migration rồi khởi động API. Health: `/api/v1/health`.
