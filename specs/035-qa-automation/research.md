# Khảo sát triển khai QA

## Cơ chế dùng lại

- Run `sdlc`, nhãn máy, `sdlc_report`, `sdlc_steps.result` đã có; thêm action/kind theo cách tương thích.
- `knowledge.ruleChecklist` và hook `sdlc.ruleContext` đang đánh giá luật câu hỏi, bản tách và độ phủ.
  QA dùng đúng điểm nối này thay vì tạo hệ thống cổng mới.
- `phaseReady` cần kiểm QA riêng vì tài liệu có baseline chưa đủ chứng minh TC pass, và pha không có tài liệu
  có thể tự chuyển. `advance` phải kiểm lại kể cả pha đã approved khi bằng chứng đổi.
- `sdlc.override` đã tồn tại trong quyền đội, dùng cho miễn TC. Không dùng ngoại lệ chặn run code thay cho miễn QA.
- UI AI SDLC dùng chung web/desktop qua sdlc-ui, nên panel QA ở đây tránh hai màn khác hành vi.

## Lựa chọn

Chỉ cho phép trường metadata cố định; bỏ hoàn toàn thông điệp lỗi và tên test khỏi dữ liệu gửi hub.
Một TC có nhiều test/browser phải gộp theo kết quả xấu nhất. Flaky không được coi là pass ở cổng.
Fingerprint chuẩn hoá thứ tự key JSONB để duyệt lại tài liệu không đổi không thu hồi miễn nhầm.

Cách ly test chập chờn: ngoài phạm vi.
Lịch chạy hồi quy: ngoài phạm vi.
Vai trò Tester: việc làm sau.
