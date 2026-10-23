# Kiểm phạm vi và yêu cầu QA

Phạm vi chốt 23/10/2026, [đặc tả](../spec.md).

- [x] Chỉ còn TC có cấu trúc gắn FR/AC, chạy tại máy và metadata, cổng duyệt QA.
- [x] Hub/web chỉ lưu metadata, cấu hình và duyệt; không thêm điều khiển thực thi test.
- [x] Metadata strict không có log, code, tên test, thông điệp lỗi hay attachment.
- [x] TC thiếu bằng chứng/failed/skipped/flaky đều chặn; không có TC bắt buộc cũng chặn.
- [x] Miễn từng TC cần quyền đội hiện có và lý do; có người quyết định, thời gian và audit.
- [x] Thay TC làm kết quả cũ mất hiệu lực và xoá miễn của TC đã đổi.
- [x] Không tạo vai trò Tester; ghi ý tưởng vào việc làm sau.
- [x] Cách ly test chập chờn: ngoài phạm vi.
- [x] Lịch chạy hồi quy: ngoài phạm vi.
- [x] Không sửa tenancy, governance, delivery, mcp, channel hoặc layers.
