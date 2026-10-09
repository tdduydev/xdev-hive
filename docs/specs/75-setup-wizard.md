# 75. setup-wizard — cài hub bằng một lệnh `docker compose up`

Hỏi 9/10: "làm sao cho hive init màn hình đầu tiên là các thông số cấu hình, chỉ cần deploy bằng 1 lệnh docker compose up".
Chọn: HTTP trên LAN mặc định, HTTPS (Caddy / Cloudflare Tunnel) bật bằng profile; cấu hình lưu trong volume, biến môi trường thắng.

## Hiện trạng

- Hub cấu hình bằng ~25 biến `HIVE_*` trong `deploy/.env`; admin đầu tiên có mật khẩu tạm in ra log.
- `deploy/compose.yaml` cần `HIVE_HOSTNAME` cho Caddy; LAN và tunnel là file compose riêng, `deploy/update.sh` ghép lại.

## Thiết kế

1. **`compose.yaml` ở gốc repo**: `git clone … && docker compose up -d` là có hub ở `http://<máy>:7788`.
   - `hub` (build từ repo, cổng `${HIVE_HTTP_PORT:-7788}`), `seaweedfs`.
   - Profile `embed` (Ollama), `https` (Caddy, cần `HIVE_HOSTNAME`), `tunnel` (cloudflared, cần `TUNNEL_TOKEN`).
   - Đặt `HIVE_SETUP=1`. `deploy/compose.yaml` và `deploy/update.sh` giữ nguyên: hub đang chạy (hive.xdev.asia) không đổi gì.
2. **Tệp cấu hình** `settings.json` cạnh DB (`/data/settings.json`, quyền 0600): `{ done, values: { HIVE_…: "…" } }`.
   Khi hub khởi động, giá trị trong tệp điền vào các biến môi trường chưa đặt (hoặc rỗng). Biến đặt sẵn thắng và bị khoá trên wizard.
   Chỉ các khoá trong danh sách `SETUP_KEYS` (`apps/web/src/hub-setup.ts`) được đọc từ tệp.
3. **Chế độ cài đặt**: `HIVE_SETUP=1`, hub chưa có tài khoản nào và tệp chưa `done`.
   - Thay vì mật khẩu tạm, hub in **mã cài đặt** ra log (`docker compose logs hub`); ai trong mạng mở trang cũng phải có mã đó.
   - Mọi `/api/*` và `/mcp` trả 503 `errors.setupPending`, trừ `/api/health` và `/api/setup`.
   - `GET /api/setup`: `{ pending, locked: [khoá đang do env đặt], defaults }` (không trả secret).
   - `POST /api/setup` `{ code, admin: { username, password }, values }`: kiểm mã (so sánh thời gian hằng), kiểm mật khẩu như đổi mật khẩu,
     kiểm từng giá trị, tạo admin (không bắt đổi mật khẩu), ghi tệp, trả `{ restart: true }` rồi thoát tiến trình; `restart: unless-stopped`
     chạy lại hub với cấu hình mới. Sai mã 10 lần thì đổi mã mới và in lại.
4. **Trang `/setup`** (web): mã cài đặt, tài khoản admin, địa chỉ (tên miền công khai, tên/IP LAN, URL công khai, sau proxy HTTPS),
   lưu tệp (SeaweedFS hoặc DB), tìm kiếm theo nghĩa (URL/model/key), SSO OIDC, backup, duyệt memory, terminal từ xa, gate jobs.
   Ô bị env khoá thì hiện giá trị là "do biến môi trường đặt". Sau khi lưu: chờ hub chạy lại rồi về trang đăng nhập.
   Phần HTTPS chỉ hướng dẫn lệnh bật profile (container hub không tự bật được service khác).

## Chưa làm (để sau)

- Sửa cấu hình sau khi cài (trang Hub): hiện vẫn sửa `settings.json` hoặc env rồi chạy lại.
- Wizard cho app desktop.
