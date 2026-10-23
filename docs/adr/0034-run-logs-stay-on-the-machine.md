# ADR 0034: Log run lưu trên máy, hub chuyển tiếp trực tiếp

- Trạng thái: Chấp nhận trong phạm vi T034–T040, ngoại lệ spec 010 ghi dưới đây
- Ngày: 2026-10-23
- Liên quan: spec 027 US5, spec 010 US6, ADR 0019, ADR 0038

## Bối cảnh

Hub giữ tiến độ và báo cáo, còn máy giữ bản log đầy đủ. Xoá worktree sau run không được xoá log. Tuy nhiên `hive attach`
của spec 010 đang đọc log run bằng SSE, gửi chỉ dẫn và xem terminal từ xa. Chủ dự án yêu cầu giữ các hành vi đó khi
chúng mâu thuẫn với spec 027. ADR 0034 chưa được dùng khi bắt đầu công việc này.

## Quyết định

1. Worker ghi stdout/stderr gộp vào `DataDir/runlogs/<runId>-<attempt>.log`, metadata trong file JSON cạnh đó. File tạo
   với quyền 0600, thư mục 0700 trên Unix; truy cập socket vẫn kiểm cùng người dùng theo ADR 0019. Windows dùng quyền
   thư mục cache người dùng và kiểm danh tính named pipe; không giả định bit Unix bảo vệ file trên Windows.
2. `job_offer.spec.runLogRetentionDays` mang chính sách tổ chức lúc giao run, mặc định 365 với hub cũ. Máy dọn mỗi ngày,
   lúc mở socket và trước run mới; tính từ lần ghi cuối để không xoá output vừa được tạo. Thay chính sách áp cho run
   mới; bản cũ giữ thời hạn được chụp lúc giao run. Không có tiến trình worker thì lần dọn kế tiếp chạy khi khởi động.
3. Op `runs.list`, `runs.log.read` và `hive runs [log <run>]` đọc tại máy, không yêu cầu hub. Đọc theo con trỏ byte,
   tối đa 32 KiB mỗi trang để nằm trong dòng JSON 64 KiB của IPC. CLI xuất chữ đọc tiếp tới hết file; `--json` trả một
   trang. Desktop mở phần đuôi bằng sidecar. Máy khác hoặc log hết hạn hiện nơi chạy run và không hỏi hub để lấy log.
4. Hub ngừng INSERT `run_logs`, không xoá bảng, không migration dữ liệu cũ. API vẫn đọc được log cũ theo quyền và RLS.
   SSE, steer và `hive attach` vẫn chạy: log mới đi qua bộ che ở worker rồi ở hub, chỉ giữ tạm trong RAM của tiến trình
   api (5 phút từ gói cuối, 1 MiB/run, 32 MiB và 256 run). NOTIFY chỉ mang run id. Id SSE giữ dạng `<event>.<log>`.
5. **Ngoại lệ spec 010:** giữ ghi và phát lại `terminal_chunks`, cùng relay WebSocket. Người xem vào sau cần bản ghi
   phiên từ xa. Không đánh đồng việc ngừng lưu log run với việc ngừng mọi output terminal trên hub. Muốn bỏ ngoại lệ
   phải có thiết kế phát lại từ máy cho spec 010 và một thay đổi riêng.
6. Chuỗi tự do trong sự kiện và kết quả run được che trước gửi và trước lưu. File log đầy đủ ở máy có thể chứa secret;
   không được chủ đích chia sẻ file đó nếu chưa kiểm nội dung. Che theo mẫu không nhận ra mọi giá trị tuỳ ý; hub không
   có kho secret dự án của máy để đối chiếu.
7. Danh mục `HUB_DATA_INVENTORY` sinh trang quản trị và `docs/hub-data.md`; test database chặn bảng hive/auth chưa khai.
   Hồ sơ SOC ghi cả credential tích hợp, nội dung người dùng gửi, log deploy, log cũ và ngoại lệ terminal.

## Hệ quả

Log đầy đủ mất nếu máy bị xoá/cài lại; metadata và báo cáo vẫn trên hub. SSE chỉ phát lại phần còn trong bộ đệm; hub
khởi động lại hoặc kết nối mất lâu sẽ có khoảng trống. Cần mở `hive runs log` trên máy để có bản đầy đủ. Đây là phần
mâu thuẫn còn lại với yêu cầu nối lại không mất log của spec 010; không thay đổi mã `attach.go`, `sse.go`, `hubws.go`.

Hub hiện vẫn có thể nhận output và còn lưu output phiên terminal từ xa. FR-051/SC-006 của spec 027 chưa đạt nguyên văn.
Không dùng tài liệu này để khẳng định hub không chứa secret hay code: báo cáo, tài liệu, artifact và kết nối tích hợp
có phạm vi dữ liệu riêng. Không triển khai, mở cổng hoặc xin SOC trong công việc này.
