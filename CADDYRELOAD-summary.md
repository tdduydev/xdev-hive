# CADDYRELOAD

## Đã làm

- `deploy/remote.sh`: sau Compose up, so SHA-256 của Caddyfile trong container với file vừa deploy. Chỉ tạo lại riêng Caddy bằng `up -d --no-deps --force-recreate caddy` khi khác hash; giữ nguyên khi nội dung không đổi. So với mount thực tế nên cũng sửa được máy đã mắc lỗi inode cũ từ lần deploy trước.
- Giữ cách mount file đơn trong `deploy/compose.yaml`: script thay cả thư mục `src`, nên chỉ đổi sang mount thư mục không giải quyết được inode cũ.
- `deploy/check-ca.mjs`: chạy qua stdin bằng Node trong hub, kiểm HTTPS `/ca.crt` trả HTTP 200 và chứng chỉ PEM đọc được bằng `X509Certificate`. Thử tối đa 3 lần, giới hạn 10 giây/lần và 64 KiB phản hồi. Không theo redirect. Lỗi kiểm tra CA in cảnh báo tiếng Việt kèm lệnh xem log, không làm hỏng deploy hub. Vẫn kiểm tra khi profile HTTPS bật nhưng không thấy Caddy đang chạy.
- `docs/self-hosting.md`: mô tả tạo lại Caddy có điều kiện, gián đoạn HTTPS ngắn khi cấu hình đổi và cách kiểm CA.
- `deploy/test-remote.sh`: Docker giả kiểm deploy đầu, deploy lặp lại, mount cũ dù file trên host đã mới, thay đổi newline, lỗi đọc hash/tạo lại, cảnh báo CA, Caddy không chạy và profile HTTPS tắt. Chỉ dùng fixture trong worktree, không SSH hay Docker thật.
- `deploy/check-ca.test.mjs`: 7 ca HTTPS cục bộ với chứng chỉ thử sinh trong worktree và xoá sau test: PEM đúng, HTML fallback, PEM hỏng, HTTP lỗi, redirect, retry và phản hồi quá lớn.

## Kiểm tra

- `pnpm install`: đạt, lockfile giữ nguyên.
- `pnpm biome check --write .`: đạt; còn cảnh báo/info có sẵn ngoài phạm vi thay đổi.
- `pnpm -w typecheck`: đạt, 13/13 tác vụ.
- `pnpm deps`: đạt, không có vi phạm; công cụ có cảnh báo tương thích TypeScript 7.
- `bash -n deploy/remote.sh deploy/test-remote.sh`: đạt.
- `sh -n deploy/remote.sh deploy/test-remote.sh`: đạt.
- `shellcheck deploy/remote.sh deploy/test-remote.sh`: đạt.
- `sh deploy/test-remote.sh`: đạt toàn bộ tình huống.
- `node --test deploy/check-ca.test.mjs`: đạt 7/7.
- `git diff --check`: đạt.

Không chạy `pnpm ci:local`. Không sửa module ứng dụng, contracts, Go hay Rust nên không chạy các bộ Vitest/Playwright/Go/Rust và không sinh OpenAPI/migration.

## Chưa làm và rủi ro

- Không deploy lên máy 34, không push, không gọi gh hay mở PR. Chưa kiểm chứng trên Docker thật; kiểm hồi quy dùng Docker giả và máy chủ HTTPS cục bộ.
- Caddy được tạo lại khi hash khác sẽ gián đoạn HTTPS ngắn; volume dữ liệu/chứng chỉ giữ nguyên. Compose vẫn có thể tạo lại Caddy vì các thay đổi cấu hình service khác theo hành vi sẵn có.
- Phép kiểm endpoint chấp nhận TLS chưa được tin cậy để đọc CA nội bộ, chỉ kiểm định dạng PEM, không cài CA và không xác nhận độ tin cậy. DNS/hairpin/firewall hoặc triển khai dùng CA công khai không có file CA nội bộ có thể làm xuất hiện cảnh báo.
- Đề bài không có đường dẫn đích cho file tóm tắt; lưu file này trong worktree.
