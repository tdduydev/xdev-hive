# Hồ sơ SOC: dữ liệu và kết nối của hub

Ngày đối chiếu: 2026-10-23. Đây là mô tả code và giới hạn của spec 027 US5, **không phải xác nhận đã triển khai hay được
phép mở lại hub**. Không chọn máy, IP, tên miền, mở cổng hoặc đo mạng nội bộ trong phạm vi này.

Hub là nguồn tiến độ và dữ liệu chung; desktop/worker thực thi trên máy. Danh mục đầy đủ có nguồn và thời gian giữ tại
[Dữ liệu hub giữ](hub-data.md) và trang quản trị `/admin/hub-data`. Test đối chiếu bảng `hive`/`auth` bắt danh mục thiếu.

- Worker gọi ra hub qua HTTPS/WSS; CLI, desktop và MCP gọi API/MCP bằng thông tin xác thực của mình. Hub nhận webhook
  Git và gọi GitHub/GitLab, CI/deploy, kênh thông báo được cấu hình. Cổng và đường mạng khi triển khai cần SOC duyệt riêng.
- Log run đầy đủ nằm trên máy, có thời hạn 30/90/365 ngày chụp lúc giao run. Hub không ghi `run_logs` mới. Để giữ spec
  010, log đã che vẫn đi qua hub cho SSE, đệm RAM tối đa 5 phút có giới hạn dung lượng. Hub khởi động lại sẽ mất đệm.
- **Ngoại lệ còn tồn tại:** `terminal_chunks` vẫn lưu output phiên terminal từ xa để phát lại; log run cũ và backup
  không bị xoá trong chuyển đổi này. Log deploy cũng vẫn được lưu. Vì vậy chưa đạt FR-051/SC-006 nguyên văn.
- Hub giữ task, run, báo cáo, audit, tài liệu/memory/skill, artifact và nội dung người dùng chủ đích gửi. Các loại này
  có thể chứa đoạn code hoặc log. Hub giữ credential cho đăng nhập và các kết nối tích hợp; không tự tải kho secret dự
  án tại máy, tài khoản CLI AI, khoá riêng máy hoặc bản clone repo của worker.
- Worker che token biết được và chuỗi theo mẫu; hub che lại sự kiện, báo cáo và log run trực tiếp. Không cam kết mọi
  secret tuỳ ý được nhận ra. File log đầy đủ ở máy vẫn nhạy cảm và không được gửi tự động lên hub.

FR-020–FR-025 đã có code cho khoá máy, challenge/access token, reauth, thu hồi và token git theo run (ADR 0033). PAT của
CLI dùng keychain hoặc biến môi trường. US5 không kiểm chứng vận hành những mục này; cần bằng chứng kiểm thử và rà soát
bảo mật riêng trước khi SOC quyết định. Kết nối SCM không cấp token hẹp vẫn có ngoại lệ theo chính sách tổ chức.

Backup/PITR, diễn tập khôi phục và tách vai trò là US4 (T041–T044), chưa được xác nhận trong công việc này. Thời điểm
hoàn tất và lịch xin mở lại hub cần chủ dự án xác nhận; không tự coi Q2 là phê duyệt của SOC. Thiết kế phát lại terminal
từ máy để bỏ `terminal_chunks`, và bảo đảm phát lại SSE sau khi hub khởi động lại, cũng cần công việc tiếp theo.
