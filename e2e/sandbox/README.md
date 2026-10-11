# E2E sandbox (M6)

Chạy `pnpm e2e:sandbox` trên Linux bằng user không phải root, có Docker và runtime
gVisor `runsc` đăng ký trong Docker và nằm trong PATH. Script tự build image Node qua
mirror ECR, build worker Go tĩnh, khởi động Postgres bằng Testcontainers và hub thật.
Không cần API key AI, GitHub token, repo ngoài hoặc môi trường dev Compose.

Script đăng ký runner loại `host`, bật `features.sandbox` qua API settings, đặt image
và allowlist dự án qua API sandbox. HTTP server cục bộ trả chuỗi duy nhất của lần
chạy; chỉ IP/cổng của server được cho phép. Một yêu cầu tới IP khác phải nhận 403.
Script thử cả lệnh `hive-worker egress-proxy` độc lập và proxy riêng của run do host
tạo từ snapshot hub.

CLI giả trong image thực hiện hai yêu cầu HTTP qua relay proxy, ghi
`sandbox-network.json`, sửa README và commit. CLI giữ container sống tới khi harness
đọc `docker inspect`: runtime `runsc`, mạng `none`, user không root, rootfs chỉ đọc,
bỏ capability, không tăng quyền và giới hạn CPU/RAM/PID. Danh sách card mạng đọc
ngay trong container phải chỉ có `lo`. Sau đó harness cho CLI kết thúc, kiểm commit
trên nhánh đã push và PR do provider Git cục bộ tạo. Ca thứ hai huỷ run qua API khi
CLI đang sống. Cả hai ca kiểm container đã bị **xoá**, worktree và socket proxy đã dọn.

Mã thoát: `0` đạt đầy đủ, `1` không đạt, `77` bỏ qua do thiếu Docker/runsc hoặc máy
không hỗ trợ runner host. Không fallback sang `runc`. Job CI coi mã bỏ qua là không
đạt, vì runner được yêu cầu có gVisor. Lỗi runtime/container thực tế là lỗi kiểm tra,
không phải bỏ qua.

Job `E2E sandbox (gVisor)` dùng `CI_LINUX_RUNNER`, mặc định
`self-hosted, Linux, X64, hive-ci`, timeout 15 phút. Báo cáo từng kiểm tra và bằng chứng
nằm ở `.e2e/sandbox/result.json`, được đưa vào artifact và job summary; không lưu
`Config.Env` từ inspect vì có run token. Thư mục chạy tạm nằm trong `.e2e/`, tài nguyên
Docker có tên riêng cho mỗi lần chạy và chỉ được dọn trong phạm vi host đó.

Đặt `HIVE_E2E_KEEP=1` để giữ thư mục tạm khi chẩn đoán tại máy; không bật trên CI.
Không kết hợp chế độ này với `HIVE_E2E_DATABASE_ADMIN_URL`, `HIVE_E2E_GITHUB=1` hoặc
`HIVE_E2E_REAL_CLI=1`.
