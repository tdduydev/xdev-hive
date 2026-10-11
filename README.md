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

- Script gửi mã của commit đang chọn (tham số thứ hai, mặc định `HEAD`) bằng `git archive` qua SSH, nên máy chủ không
  cần quyền đọc repo private. Mã nằm ở `<dir>/src`, mặc định `<dir>` là `/opt/xdev-hive` (đổi bằng `HIVE_REMOTE_DIR`).
  Sau đó script chạy `docker compose up -d --build` và chờ hub báo healthy.
- **Máy chủ đã chạy hệ khác có compose project tên `xdev-hive` (ví dụ hệ cũ) thì phải đặt `HIVE_COMPOSE_PROJECT` khác**
  ở lần đầu. Nếu không, compose sẽ coi container của hệ kia là của mình. Tên này được lưu vào `<dir>/.env` cho các lần
  sau.
- Lần đầu, mật khẩu database, `HIVE_AUTH_SECRET` và `HIVE_MASTER_KEY` được sinh ngay trên máy chủ vào `<dir>/.env`
  (quyền 600). Script không in chúng ra và không chép về máy dev. **Sao lưu `HIVE_MASTER_KEY`**: mất khoá là mất mọi
  secret đã lưu (token Git, kênh thông báo).
- Lần sau, script giữ nguyên secret và chỉ thêm biến mới còn thiếu. `HIVE_PUBLIC_URL`, `HIVE_BIND`,
  `HIVE_POSTGRES_IMAGE`, `HIVE_NODE_IMAGE` đặt theo tham số của lệnh.
- `HIVE_BIND=0.0.0.0` cho máy chủ LAN không có HTTPS. Khi đó cổng `/mcp` tự tắt vì `HIVE_PUBLIC_URL` không phải https.
- Muốn agent trong run vẫn gọi `task_update`, `memory_search` qua http trong mạng tin cậy, đặt `HIVE_MCP_ALLOW_HTTP=1`
  (mặc định tắt). Khi đó `/mcp` chỉ nhận run token của agent: token OAuth hay request không có run token bị 401, còn
  `/.well-known` và đăng nhập OAuth cho người dùng vẫn chỉ bật khi https. Run token đi qua http trần, nên chỉ bật cờ này
  khi mạng giữa máy chủ và máy chạy worker là mạng tin cậy. Hub ghi một dòng cảnh báo lúc khởi động.
  Dùng HTTPS thì để `HIVE_BIND` mặc định và thêm `--profile https` (Caddy).
- User không thuộc nhóm docker thì đặt `HIVE_REMOTE_DOCKER="sudo docker"`.

Tự chạy tại máy chủ: sao chép `deploy/.env.example` thành `deploy/.env`, đặt mật khẩu và secret, rồi chạy
`docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`. Hub tự bootstrap role (kể cả `hive_jobs`
cho hàng đợi), chạy migration rồi khởi động API. Health: `/api/v1/health`.

### Sao lưu và khôi phục

Với bố cục của `deploy/remote.sh` (`<dir>/.env`, `<dir>/src`), chạy trên máy chủ:

```sh
cd <dir>/src
deploy/backup.sh
HIVE_BACKUP_KEEP=30 deploy/backup.sh
deploy/restore.sh <dir>/backups/20261011T030000Z
# Bỏ qua câu hỏi ghi đè .env khi chạy tự động:
deploy/restore.sh <dir>/backups/20261011T030000Z --yes
```

- Backup gồm `hive.dump` (pg_dump custom), `.env` **có HIVE_MASTER_KEY**, và `SHA256SUMS`. Thư mục có quyền 700,
  file có quyền 600. Dump được kiểm bằng `pg_restore --list`; lỗi thì trả mã khác 0 và giữ các bản cũ.
- `HIVE_BACKUP_KEEP` đặt trong `<dir>/.env` hoặc môi trường lệnh, mặc định 14. Chỉ xoá bản cũ sau khi hoàn tất bản mới.
  Nên chép cả thư mục backup sang nơi lưu trữ an toàn ngoài máy chủ; người đọc được `.env` cũng đọc được secret.
- Restore kiểm checksum, dump và project trước khi dừng hub. Nếu `.env` khác, phải xác nhận hoặc dùng `--yes`.
  SQL từ `pg_restore --clean --if-exists` được chạy bằng psql trong một transaction, giữ role, ownership và ACL.
  Schema `pgboss` được xoá và dựng lại trong cùng transaction để tránh lỗi clean constraint của bảng partition.
  Script nạp lại `.env`, đồng bộ mật khẩu postgres, tái tạo hub bằng image hiện có và chờ healthy tối đa 3 phút.
- Restore **ghi đè dữ liệu hiện tại**. Sao lưu trước khi chạy. Chỉ dùng backup tin cậy và khôi phục vào cùng project
  đã bootstrap, cùng phiên bản code/extension tương thích; không phải công cụ dựng lại toàn bộ máy chủ hay đổi project.
  Dump không chứa role toàn cụm, mã nguồn, blob ngoài Postgres hay cấu hình hạ tầng. Nếu lỗi sau khi dừng hub,
  hub được giữ dừng để tránh ghi thêm dữ liệu; sửa lỗi rồi chạy lại restore với cùng backup.
- Backup/restore dùng khoá `<dir>/.backup-restore.lock` để tránh chạy chồng nhau. Không chạy đồng thời với deploy
  hoặc đổi `.env`. Nếu tiến trình bị kill cưỡng bức, chỉ xoá khoá sau khi chắc chắn không còn backup/restore chạy.

Từ máy dev, dùng bản script đã triển khai trên máy chủ:

```sh
deploy/remote-backup.sh <user>@<máy-chủ>
HIVE_REMOTE_DIR=/opt/xdev-hive deploy/remote-backup.sh <user>@<máy-chủ> --cron "0 3 * * *"
```

Lệnh luôn backup ngay; `--cron` thêm lịch vào crontab của user SSH, chạy lại sẽ thay lịch của cùng `<dir>` và giữ
các lịch khác. Cron dùng múi giờ máy chủ, ghi log quyền 600 tại `<dir>/backups/cron.log`; cần Docker trong PATH của
cron. `HIVE_REMOTE_DOCKER="sudo -n docker"` khi cần sudo không tương tác. `.env` và dump không được tải về máy dev.

Kiểm tra các nhánh lỗi và cron bằng `sh deploy/test-backup.sh` (Docker/SSH giả, không đụng bản triển khai thật).

### Worker chạy nền

Đăng ký máy một lần bằng `hive-worker register --hub URL --token MÃ`. Sau đó cài worker chạy nền bằng
`hive-worker service install [--config PATH] [--capacity N]`; xem trạng thái bằng `hive-worker service status`
và gỡ bằng `hive-worker service uninstall`. Dùng `--dry-run` để xem nội dung dịch vụ và các lệnh trước khi cài.

Linux cài systemd user service. Mặc định service chỉ chạy trong phiên đăng nhập; dùng `loginctl enable-linger USER`
để worker tiếp tục chạy khi người dùng chưa đăng nhập. Log xem bằng `journalctl --user -u hive-worker`.
macOS cài LaunchAgent và ghi log vào `~/Library/Logs/xdev-hive/worker.log`. Khi hub từ chối máy, LaunchAgent
thoát thành công và không tự khởi động lại liên tục; đăng ký lại rồi chạy `service install` để nạp lại.
Windows tạo tác vụ Task Scheduler ở mức quyền thường, chạy lúc đăng nhập và ghi log vào
`%LOCALAPPDATA%\xdev-hive\worker.log`.
