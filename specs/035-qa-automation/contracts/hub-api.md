# API metadata và duyệt QA

- `sdlc.qa.view({itemId})`: TC, FR/AC, script metadata, trạng thái hợp lệ gần nhất, miễn, checklist cổng và `canWaive`.
  Kiểm quyền đọc hạng mục ở đội. Trả metadata của bước gần nhất, không trả log/code.
- `sdlc.qa.waive({caseId, waived, reason})`: miễn/thu hồi TC. Cần `sdlc.override` ở đội dự án chính;
  lý do 10–500 ký tự, hạng mục đang hoạt động, TC chưa ngừng dùng. Ghi audit và xét lại điều kiện chuyển pha.

Không có route chạy test, cách ly, lịch hồi quy hoặc tự tạo lỗi.
