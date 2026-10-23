# Thử luồng QA

1. Bật AI SDLC và cho phép preset `qa-automation` ở dự án. Dùng quyền đội sẵn có.
2. Tạo hạng mục, duyệt phạm vi/kế hoạch và bảng `test-cases` có TC-xxx, FR/AC và script tương đối.
3. Viết/chạy bộ test tại worker hoặc desktop. Đặt mã TC trong tên test. Không gửi reporter gốc lên hub.
4. Xuất Playwright JSON hoặc JUnit XML tại máy, rồi chạy:

   ```sh
   hive test-summary .hive/report.json --format playwright --commit <SHA-đầy-đủ>
   hive test-summary .hive/junit.xml --format junit
   ```

5. Trong bước `test-run`, agent gửi JSON qua `sdlc_report` loại `test-results` và ghi báo cáo chỉ gồm metadata.
6. Màn tổng quan AI SDLC hiển thị TC, FR/AC, kết quả và cổng QA. Test fail/skipped/flaky hay thiếu TC đều chặn.
7. Người có `sdlc.override` miễn từng TC với lý do; sau đó vẫn duyệt tài liệu theo cổng người duyệt.
8. Sửa TC và duyệt lại: báo cáo trước hết hiệu lực, miễn TC đã sửa bị xoá. Chạy lại tại máy.

Web không có nút thực thi test. Log, code, ảnh và trace ở lại máy.
Cách ly test chập chờn: ngoài phạm vi.
Lịch chạy hồi quy: ngoài phạm vi.
